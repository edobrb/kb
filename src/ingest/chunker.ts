import { declaredSymbols, isDeclarationStart } from "../sync/code.js";
import type { Chunk, Document } from "../types.js";

export interface ChunkOptions {
  targetTokens: number;
  maxTokens: number;
  overlapTokens: number;
  /** Sizes for source files (default: the prose sizes). */
  code?: { targetTokens: number; maxTokens: number };
}

/** Cheap token estimate good enough for sizing (Qwen tokenizer ≈ 3.5 chars/token on en/it prose). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

/** Code tokenises denser than prose (punctuation, camelCase). */
export function estimateCodeTokens(text: string): number {
  return Math.ceil(text.length / 3.2);
}

/** The text that gets embedded and BM25-indexed: breadcrumb, contextual-retrieval prefix, content. */
export function composeChunkText(headingPath: string, context: string, content: string): string {
  return [headingPath, context, content].filter((s) => s && s.trim()).join("\n\n");
}

type BlockKind = "heading" | "code" | "table" | "text";

interface Block {
  kind: BlockKind;
  text: string;
  /** Heading level when kind === "heading". */
  level?: number;
  /** Heading path (excluding the doc title) in effect for this block. */
  path: string[];
}

/**
 * Split markdown into structural blocks: headings, fenced code, tables, and paragraphs/lists.
 * Each block carries the heading path in effect where it appears.
 */
export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.split("\n");
  const blocks: Block[] = [];
  const headingStack: { level: number; text: string }[] = [];
  const currentPath = () => headingStack.map((h) => h.text);

  let i = 0;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) {
      const text = para.join("\n").trim();
      if (text) blocks.push({ kind: "text", text, path: currentPath() });
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i] as string;

    // Fenced code block (``` or ~~~), kept atomic.
    const fence = /^(\s*)(`{3,}|~{3,})/.exec(line);
    if (fence) {
      flushPara();
      const marker = fence[2] as string;
      const buf = [line];
      i++;
      while (i < lines.length) {
        buf.push(lines[i] as string);
        if ((lines[i] as string).trim().startsWith(marker[0] as string) && (lines[i] as string).trim().startsWith(marker)) {
          i++;
          break;
        }
        i++;
      }
      blocks.push({ kind: "code", text: buf.join("\n"), path: currentPath() });
      continue;
    }

    // ATX heading.
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flushPara();
      const level = (h[1] as string).length;
      const text = (h[2] as string).replace(/[*_`]/g, "").trim();
      while (headingStack.length && (headingStack.at(-1) as { level: number }).level >= level) headingStack.pop();
      if (text) headingStack.push({ level, text });
      blocks.push({ kind: "heading", text: line.trim(), level, path: currentPath() });
      i++;
      continue;
    }

    // Table: run of lines starting with '|'.
    if (/^\s*\|/.test(line)) {
      flushPara();
      const buf: string[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i] as string)) {
        buf.push((lines[i] as string).trim());
        i++;
      }
      blocks.push({ kind: "table", text: buf.join("\n"), path: currentPath() });
      continue;
    }

    // Blank line ends a paragraph.
    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  return blocks;
}

/** Split an oversized block into pieces no larger than maxTokens, preserving table headers / code fences. */
function splitOversized(block: Block, maxTokens: number): Block[] {
  if (estimateTokens(block.text) <= maxTokens) return [block];
  const lines = block.text.split("\n");
  const pieces: Block[] = [];

  if (block.kind === "table") {
    const header = lines.slice(0, 2);
    const rows = lines.slice(2);
    let cur: string[] = [];
    const headerTokens = estimateTokens(header.join("\n"));
    for (const row of rows) {
      if (cur.length && headerTokens + estimateTokens([...cur, row].join("\n")) > maxTokens) {
        pieces.push({ ...block, text: [...header, ...cur].join("\n") });
        cur = [];
      }
      cur.push(row);
    }
    if (cur.length) pieces.push({ ...block, text: [...header, ...cur].join("\n") });
    return pieces;
  }

  if (block.kind === "code") {
    const open = lines[0] as string;
    const close = lines.at(-1) as string;
    const body = lines.slice(1, -1).flatMap((l) => hardWrap(l, maxTokens));
    let cur: string[] = [];
    for (const l of body) {
      if (cur.length && estimateTokens([open, ...cur, l, close].join("\n")) > maxTokens) {
        pieces.push({ ...block, text: [open, ...cur, close].join("\n") });
        cur = [];
      }
      cur.push(l);
    }
    if (cur.length) pieces.push({ ...block, text: [open, ...cur, close].join("\n") });
    return pieces;
  }

  // Prose / lists: split on sentence-ish boundaries, then hard-wrap if still too big.
  const sentences = block.text.split(/(?<=[.!?;:])\s+|\n/);
  let cur = "";
  for (const s of sentences) {
    if (!s) continue;
    if (cur && estimateTokens(`${cur} ${s}`) > maxTokens) {
      pieces.push({ ...block, text: cur });
      cur = "";
    }
    if (estimateTokens(s) > maxTokens) {
      // Pathological single sentence: hard split by characters.
      const step = Math.floor(maxTokens * 3.5);
      for (let k = 0; k < s.length; k += step) pieces.push({ ...block, text: s.slice(k, k + step) });
      continue;
    }
    cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) pieces.push({ ...block, text: cur });
  return pieces;
}

/** A single line longer than a whole chunk (minified JSON, a data URI…) is cut into chunk-sized pieces. */
export function hardWrap(line: string, maxTokens: number, charsPerToken = 3.5): string[] {
  const step = Math.max(80, Math.floor(maxTokens * charsPerToken * 0.8));
  if (line.length <= step) return [line];
  const out: string[] = [];
  for (let k = 0; k < line.length; k += step) out.push(line.slice(k, k + step));
  return out;
}

function joinPath(title: string, path: string[]): string {
  const parts = [title, ...path.filter((p) => p.toLowerCase() !== title.toLowerCase())];
  return parts.join(" > ");
}

function makeChunk(doc: Document, ordinal: number, headingPath: string, content: string, tokens: number, lines: [number, number] | null): Chunk {
  return {
    id: `${doc.meta.sourceId}::${ordinal}`,
    sourceId: doc.meta.sourceId,
    ordinal,
    headingPath,
    content,
    context: "",
    text: composeChunkText(headingPath, "", content),
    tokenEstimate: tokens,
    lineStart: lines ? lines[0] : null,
    lineEnd: lines ? lines[1] : null,
  };
}

/**
 * Heading-aware chunking for prose:
 *  - packs consecutive blocks up to `targetTokens`, never over `maxTokens`
 *  - prefers to break at headings once a chunk is at least ~1/3 of target
 *  - carries a short overlap (last block) when a break happens mid-section
 *  - prefixes each chunk's embedding text with "Title > H2 > H3" so it is self-describing
 * Source files (`kind: code`) go through `chunkCode` instead.
 */
export function chunkDocument(doc: Document, opts: ChunkOptions): Chunk[] {
  if (doc.meta.kind === "code") return chunkCode(doc, opts.code ?? { targetTokens: opts.targetTokens, maxTokens: opts.maxTokens });

  const { targetTokens, maxTokens, overlapTokens } = opts;
  const minTokens = Math.max(40, Math.floor(targetTokens / 3));
  const blocks = parseBlocks(doc.body).flatMap((b) => splitOversized(b, maxTokens));

  const chunks: Chunk[] = [];
  let cur: Block[] = [];
  let curTokens = 0;

  const tokensOf = (bs: Block[]) => estimateTokens(bs.map((b) => b.text).join("\n\n"));

  const emit = () => {
    // Drop leading/trailing heading-only content.
    const meaningful = cur.filter((b) => b.kind !== "heading");
    if (!meaningful.length) {
      cur = [];
      curTokens = 0;
      return;
    }
    const first = meaningful[0] as Block;
    const content = cur.map((b) => b.text).join("\n\n").trim();
    chunks.push(makeChunk(doc, chunks.length, joinPath(doc.meta.title, first.path), content, estimateTokens(content), null));
  };

  for (const block of blocks) {
    const bt = estimateTokens(block.text);

    // Prefer heading boundaries once the chunk has some substance.
    if (block.kind === "heading" && curTokens >= minTokens) {
      emit();
      cur = [];
      curTokens = 0;
    }

    if (cur.length && curTokens + bt > targetTokens && curTokens >= minTokens) {
      emit();
      // Overlap: carry the last non-heading block if it is small enough.
      const last = cur.at(-1);
      cur = last && last.kind !== "heading" && estimateTokens(last.text) <= overlapTokens * 1.5 ? [last] : [];
      curTokens = tokensOf(cur);
    }

    cur.push(block);
    curTokens += bt;

    // Hard cap safety (single huge block already split by splitOversized).
    if (curTokens > maxTokens && cur.length > 1) {
      const lastBlock = cur.pop() as Block;
      emit();
      cur = [lastBlock];
      curTokens = estimateTokens(lastBlock.text);
    }
  }
  if (cur.length) emit();

  // Merge a trailing tiny chunk into the previous one to avoid orphan fragments.
  if (chunks.length >= 2) {
    const last = chunks.at(-1) as Chunk;
    const prev = chunks.at(-2) as Chunk;
    if (last.tokenEstimate < minTokens / 2 && prev.tokenEstimate + last.tokenEstimate <= maxTokens) {
      prev.content = `${prev.content}\n\n${last.content}`;
      prev.text = composeChunkText(prev.headingPath, prev.context, prev.content);
      prev.tokenEstimate = estimateTokens(prev.content);
      chunks.pop();
    }
  }
  return chunks;
}

/** The single fenced block a code document consists of. */
export function extractFencedCode(body: string): { fence: string; language: string; lines: string[] } | null {
  const all = body.split("\n");
  const start = all.findIndex((l) => /^(`{3,}|~{3,})\S*\s*$/.test(l));
  if (start < 0) return null;
  const m = /^(`{3,}|~{3,})(\S*)/.exec(all[start] as string) as RegExpExecArray;
  const fence = m[1] as string;
  let end = all.length;
  for (let i = all.length - 1; i > start; i--) {
    if ((all[i] as string).trim() === fence) {
      end = i;
      break;
    }
  }
  return { fence, language: m[2] ?? "", lines: all.slice(start + 1, end) };
}

interface Piece {
  from: number; // inclusive index into lines
  to: number; // exclusive
  tokens: number;
}

/**
 * Chunking for source files: cut at top-level declarations (function/class/def/...) once a chunk has
 * reached the target size, at blank lines when no declaration is near, and hard-cut only when a single
 * construct exceeds the maximum. Every chunk keeps the fence and language tag, carries the 1-based line
 * range for deep links, and gets a "project > file > symbols" breadcrumb.
 */
export function chunkCode(doc: Document, sizes: { targetTokens: number; maxTokens: number }): Chunk[] {
  const fenced = extractFencedCode(doc.body);
  if (!fenced) return [];
  const { fence, language } = fenced;
  // Giant single lines (minified bundles, embedded data) are wrapped; `origLine` keeps the real line numbers.
  const lines: string[] = [];
  const origLine: number[] = [];
  fenced.lines.forEach((l, i) => {
    for (const piece of hardWrap(l, sizes.maxTokens, 3.2)) {
      lines.push(piece);
      origLine.push(i + 1);
    }
  });
  const n = lines.length;
  if (!lines.some((l) => l.trim())) return [];
  const { targetTokens: target, maxTokens: max } = sizes;
  const minTokens = Math.max(40, Math.floor(target / 3));
  const cost = (l: string) => estimateCodeTokens(l) + 1;

  const pieces: Piece[] = [];
  let i = 0;
  while (i < n) {
    let tokens = 0;
    let lastStrong = -1;
    let lastWeak = -1;
    let j = i;
    for (; j < n; j++) {
      const line = lines[j] as string;
      if (j > i && tokens >= minTokens) {
        if (isDeclarationStart(line)) {
          if (tokens >= target) break; // cut before this declaration
          lastStrong = j;
        } else if (!line.trim()) lastWeak = j;
      }
      const t = cost(line);
      if (j > i && tokens + t > max) {
        j = lastStrong > i ? lastStrong : lastWeak > i ? lastWeak : j;
        break;
      }
      tokens += t;
    }
    if (j <= i) j = i + 1;
    pieces.push({ from: i, to: j, tokens: lines.slice(i, j).reduce((s, l) => s + cost(l), 0) });
    i = j;
  }

  // Merge a trailing tiny piece into the previous one.
  if (pieces.length >= 2) {
    const last = pieces.at(-1) as Piece;
    const prev = pieces.at(-2) as Piece;
    if (last.tokens < minTokens / 2 && prev.tokens + last.tokens <= max) {
      prev.to = last.to;
      prev.tokens += last.tokens;
      pieces.pop();
    }
  }

  const project = typeof doc.frontmatter["project"] === "string" ? (doc.frontmatter["project"] as string) : "";
  const root = project && !doc.meta.title.startsWith(project) ? `${project} > ${doc.meta.title}` : doc.meta.title;
  const chunks: Chunk[] = [];
  for (const p of pieces) {
    // Trim blank lines at both ends but keep the real line numbers.
    let from = p.from;
    let to = p.to;
    while (from < to && !(lines[from] as string).trim()) from++;
    while (to > from && !(lines[to - 1] as string).trim()) to--;
    if (from >= to) continue;
    const code = lines.slice(from, to).join("\n");
    const symbols = declaredSymbols(code, 4);
    const headingPath = symbols.length ? `${root} > ${symbols.join(", ")}` : root;
    const content = `${fence}${language}\n${code}\n${fence}`;
    chunks.push(makeChunk(doc, chunks.length, headingPath, content, estimateCodeTokens(code), [origLine[from] as number, origLine[to - 1] as number]));
  }
  return chunks;
}
