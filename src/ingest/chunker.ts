import type { Chunk, Document } from "../types.js";

export interface ChunkOptions {
  targetTokens: number;
  maxTokens: number;
  overlapTokens: number;
}

/** Cheap token estimate good enough for sizing (Qwen tokenizer ≈ 3.5 chars/token on en/it prose). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
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
    const body = lines.slice(1, -1);
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

function joinPath(title: string, path: string[]): string {
  const parts = [title, ...path.filter((p) => p.toLowerCase() !== title.toLowerCase())];
  return parts.join(" > ");
}

/**
 * Heading-aware chunking:
 *  - packs consecutive blocks up to `targetTokens`, never over `maxTokens`
 *  - prefers to break at headings once a chunk is at least ~1/3 of target
 *  - carries a short overlap (last block) when a break happens mid-section
 *  - prefixes each chunk's embedding text with "Title > H2 > H3" so it is self-describing
 */
export function chunkDocument(doc: Document, opts: ChunkOptions): Chunk[] {
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
    const headingPath = joinPath(doc.meta.title, first.path);
    const ordinal = chunks.length;
    chunks.push({
      id: `${doc.meta.sourceId}::${ordinal}`,
      sourceId: doc.meta.sourceId,
      ordinal,
      headingPath,
      content,
      text: `${headingPath}\n\n${content}`,
      tokenEstimate: estimateTokens(content),
    });
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
      prev.text = `${prev.headingPath}\n\n${prev.content}`;
      prev.tokenEstimate = estimateTokens(prev.content);
      chunks.pop();
    }
  }
  return chunks;
}
