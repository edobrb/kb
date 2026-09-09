import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { getChatProvider } from "../llm/chat.js";
import { parseFrontmatter } from "./loader.js";
import type { ChatMessage, Chunk, Document } from "../types.js";

/**
 * Contextual retrieval (https://www.anthropic.com/engineering/contextual-retrieval).
 *
 * Chunks lose their context when embedded alone ("the retry count is 3" — of what?). Before indexing, a
 * chat model that sees the whole document plus a short project brief writes 1–3 sentences that situate
 * each chunk; the sentences are prepended to the chunk text for both the embedding and the BM25 index.
 * Anthropic measured a 49 % drop in retrieval failures with this alone (67 % with a reranker).
 *
 * Cost model. Generation is the bottleneck and it does not parallelise: Ollama on Metal time-slices
 * concurrent requests instead of batch-decoding them, so aggregate throughput is a constant per model
 * (measured on the M5 Pro: ~49 tok/s for an 8B, ~156 tok/s for qwen3:1.7b, flat from 1 to 16 in flight).
 * Wall-clock is therefore just `generated tokens / model throughput`, and the only levers are a smaller
 * model, fewer generated tokens, and fewer prompt tokens re-read per context.
 *
 * Hence one call per *group of chunks* rather than one per chunk: the document is rendered once with
 * `<chunk id=N>` markers around its own chunks and the model answers one line per id. That removes the
 * repeated per-chunk prefill (~3 900 -> ~400 prompt tokens per chunk) and shortens each context, for
 * ~2x over the per-chunk prompt at equal quality. Ids the model skips or truncates are retried one by
 * one, so a malformed batch costs time, never quality.
 *
 * Contexts are cached under DATA_DIR/contexts keyed by document and chunk *content* hash, so re-ingests,
 * embedder swaps and crashes never redo them. Documents with fewer than `minChunks` chunks and project
 * cards get a deterministic context instead: with the heading path ("repo > file > symbol") already in
 * the indexed text there is little left for the model to situate.
 */

/** Bump when the prompt changes materially; cached contexts written with another version are ignored. */
export const CONTEXT_PROMPT_VERSION = 3;

const SYSTEM = `You write short contexts that situate a chunk of a document within the document and its project, to improve search retrieval of the chunk.
Rules: answer with the context only — 1 to 3 plain sentences, at most 80 words, in English. Keep identifiers, file names, endpoints, product and team names verbatim. No markdown, no lists, no preamble, no quotes around the answer.`;

const INSTRUCTION = `Give a short, succinct context to situate this chunk within the overall document (and the project described in the background) for the purposes of improving search retrieval of the chunk. Say what the chunk is about, which names it defines or uses, and which part of the document or project it belongs to. Answer only with the succinct context and nothing else.`;

export interface ContextCacheFile {
  version: 1;
  sourceId: string;
  model: string;
  promptVersion: number;
  /** chunk content hash -> context */
  entries: Record<string, string>;
}

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");

/** Key of a chunk inside the cache file: depends on the content only, so an unchanged chunk of an edited file is reused. */
export function chunkKey(chunk: Chunk): string {
  return sha1(chunk.content).slice(0, 16);
}

/** One JSON file per document, sharded by the first two hex chars of the id hash. */
export class ContextCache {
  constructor(readonly dir: string) {}

  file(sourceId: string): string {
    const h = sha1(sourceId);
    return path.join(this.dir, h.slice(0, 2), `${h}.json`);
  }

  async load(sourceId: string): Promise<ContextCacheFile | null> {
    try {
      const f = JSON.parse(await readFile(this.file(sourceId), "utf8")) as ContextCacheFile;
      return f.version === 1 && f.entries ? f : null;
    } catch {
      return null;
    }
  }

  async save(f: ContextCacheFile): Promise<void> {
    const file = this.file(f.sourceId);
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(f), "utf8");
    await rename(tmp, file);
  }
}

/** Reads `kb/gitlab/<project>/__project.md` bodies on demand (the background of that repository's chunks). */
export class ProjectCards {
  private cache = new Map<string, Promise<string | null>>();
  constructor(private readonly kbDir: string) {}

  /** Register a card seen during this run so its latest text is used even before it is on disk. */
  set(project: string, body: string): void {
    this.cache.set(project.toLowerCase(), Promise.resolve(body));
  }

  bodyFor(project: string): Promise<string | null> {
    const key = project.toLowerCase();
    let p = this.cache.get(key);
    if (!p) {
      p = readFile(path.join(this.kbDir, "gitlab", project, "__project.md"), "utf8").then(
        (raw) => parseFrontmatter(raw).body.trim(),
        () => null,
      );
      this.cache.set(key, p);
    }
    return p;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Project name for prose: "scm-invoicing" from "oneplatform/islands/scm/scm-invoicing". */
function projectLabel(fm: Record<string, unknown>): { name: string; path: string } {
  const p = str(fm["project"]);
  return { name: str(fm["project_name"]) || p.split("/").pop() || p, path: p };
}

/**
 * What the model should know beyond the document itself: the project card for repository files, the
 * catalog entity for portal pages, a one-liner for the other sources. Truncated to `maxChars`.
 */
export function buildBackground(doc: Document, projectCard: string | null, maxChars: number): string {
  const fm = doc.frontmatter;
  let bg: string;
  if (doc.meta.sourceType === "devportal" || str(fm["entity"])) {
    const bits = [
      `TeamSystem Developer Portal (Backstage) documentation.`,
      str(fm["site_name"]) ? `Site: ${str(fm["site_name"])}.` : "",
      str(fm["entity"]) ? `Catalog entity: ${str(fm["entity_title"]) || str(fm["entity_name"])} (${str(fm["entity"])}).` : "",
      str(fm["entity_description"]) ? `Description: ${str(fm["entity_description"])}` : "",
      str(fm["owner"]) ? `Owner: ${str(fm["owner"])}.` : "",
      str(fm["system"]) ? `System: ${str(fm["system"])}.` : "",
      str(fm["lifecycle"]) ? `Lifecycle: ${str(fm["lifecycle"])}.` : "",
    ].filter(Boolean);
    bg = bits.join(" ");
  } else if (str(fm["project"])) {
    const { path: p } = projectLabel(fm);
    bg = projectCard ? projectCard : `Repository ${p} on the TeamSystem GitLab (OnePlatform).`;
  } else if (doc.meta.sourceType === "adr") {
    bg = "Architecture Decision Record (ADR) of TeamSystem OnePlatform: a binding architectural decision for the platform teams.";
  } else if (doc.meta.sourceType === "manually-curated") {
    bg = "Hand-written TeamSystem / OnePlatform reference material (glossary, manifesto, design principles, product catalog).";
  } else {
    bg = `${doc.meta.sourceType} document from the TeamSystem knowledge base.`;
  }
  return bg.length > maxChars ? `${bg.slice(0, maxChars - 1).trimEnd()}…` : bg;
}

/** First descriptive line of a project card (after the title and the "Repository ..." line). */
function firstDescription(background: string): string {
  for (const line of background.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("Repository `") || t.startsWith("- ") || t.startsWith("[")) continue;
    const d = t.replace(/[.\s]+$/, "");
    return d.length > 220 ? `${d.slice(0, 219)}…` : d;
  }
  return "";
}

/** Context that needs no model: single-chunk documents, project cards, and the fallback when the model fails. */
export function deterministicContext(doc: Document, background: string): string {
  const fm = doc.frontmatter;
  const { name, path: p } = projectLabel(fm);
  const desc = p ? firstDescription(background) : "";
  const withDesc = desc ? ` — ${desc}` : "";
  switch (doc.meta.kind) {
    case "code": {
      const lang = str(fm["language"]);
      return `Source file ${str(fm["file_path"]) || doc.meta.title}${lang ? ` (${lang})` : ""} of the ${name} repository (${p})${withDesc}.`;
    }
    case "project":
      return `Project card of the ${name} repository (${p}): what it is, who owns it, its README and the related Confluence pages.`;
    case "api":
      return `${doc.meta.title}: API definition of ${str(fm["entity_title"]) || str(fm["entity_name"]) || str(fm["entity"])} from the TeamSystem Developer Portal catalog${str(fm["owner"]) ? `, owned by ${str(fm["owner"])}` : ""}.`;
    default:
      if (p) return `Document "${doc.meta.title}"${str(fm["file_path"]) ? ` (${str(fm["file_path"])})` : ""} of the ${name} repository (${p})${withDesc}.`;
      if (str(fm["entity"]))
        return `Page "${doc.meta.title}" of the ${str(fm["site_name"]) || str(fm["entity_title"]) || str(fm["entity_name"])} documentation in the TeamSystem Developer Portal${str(fm["owner"]) ? ` (owner ${str(fm["owner"])})` : ""}.`;
      return `Document "${doc.meta.title}" (${doc.meta.sourceType}).`;
  }
}

/** Head of the document plus a window around the chunk when the whole document does not fit. */
export function documentWindow(body: string, chunk: Chunk, maxChars: number): string {
  if (body.length <= maxChars) return body;
  const probe = chunk.content.replace(/^`{3,}\S*\n/, "").slice(0, 160);
  const at = probe ? body.indexOf(probe) : -1;
  const headLen = Math.floor(maxChars * 0.35);
  const winLen = maxChars - headLen;
  if (at < 0 || at < headLen) return `${body.slice(0, maxChars)}\n[… document truncated]`;
  const start = Math.max(headLen, at - Math.floor(winLen * 0.3));
  const end = Math.min(body.length, start + winLen);
  return `${body.slice(0, headLen)}\n[… ${at - headLen > 0 ? "part of the document omitted" : ""} …]\n${body.slice(start, end)}${end < body.length ? "\n[… document truncated]" : ""}`;
}

export function buildContextMessages(doc: Document, chunk: Chunk, background: string, maxDocChars: number): ChatMessage[] {
  const fm = doc.frontmatter;
  const attrs = [`title="${doc.meta.title.replace(/"/g, "'")}"`, `kind="${doc.meta.kind}"`];
  if (str(fm["file_path"])) attrs.push(`path="${str(fm["file_path"])}"`);
  if (str(fm["language"])) attrs.push(`language="${str(fm["language"])}"`);
  const user = [
    `<background>\n${background}\n</background>`,
    `<document ${attrs.join(" ")}>\n${documentWindow(doc.body, chunk, maxDocChars)}\n</document>`,
    `Here is the chunk we want to situate within the whole document:\n<chunk>\n${chunk.content}\n</chunk>`,
    INSTRUCTION,
  ].join("\n\n");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

/**
 * The batch prompt: the document is rendered once as its own chunks wrapped in `<chunk id=N>` markers, so
 * every chunk is shown *in place* rather than repeated after a copy of the document. `head` re-states the
 * opening of the document for groups that do not start at chunk 1.
 */
export function buildBatchContextMessages(doc: Document, group: Chunk[], background: string, head: string, maxWords: number): ChatMessage[] {
  const fm = doc.frontmatter;
  const attrs = [`title="${doc.meta.title.replace(/"/g, "'")}"`, `kind="${doc.meta.kind}"`];
  if (str(fm["file_path"])) attrs.push(`path="${str(fm["file_path"])}"`);
  if (str(fm["language"])) attrs.push(`language="${str(fm["language"])}"`);
  const body = group
    .map((c, i) => `<chunk id="${i + 1}"${c.headingPath ? ` section="${c.headingPath.replace(/"/g, "'")}"` : ""}>\n${c.content}\n</chunk>`)
    .join("\n");
  const user = [
    `<background>\n${background}\n</background>`,
    head ? `<document_start ${attrs.join(" ")}>\n${head}\n</document_start>` : "",
    `<document ${attrs.join(" ")}>\n${body}\n</document>`,
    `Write one context line for each of the ${group.length} chunk ids above (1 to ${group.length}), in order. Format: "<id>: <context>". Nothing else.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return [
    { role: "system", content: batchSystem(maxWords) },
    { role: "user", content: user },
  ];
}

/**
 * Two example lines, shown only for their *length*. A word count alone is ignored by small models
 * (qwen3:1.7b wrote ~59 tokens per context when asked for 30 words); showing the length halves that to
 * ~29 and, because the answer no longer runs into its token budget, drops the skipped-id rate to ~0.
 * Generated tokens are ~3/4 of this stage's cost, so that alone is a ~1.8x speed-up.
 *
 * The cost is that a small model handed a two-chunk document sometimes has little to say and copies an
 * example verbatim (~4 % of chunks in short documents; telling it *not* to copy them made that worse, as
 * negations tend to). `parseBatchContexts` therefore drops any line that is one of these verbatim, which
 * turns a copied line into an ordinary single-chunk retry — and that prompt carries no examples.
 * If you edit them, keep them short, keep one prose and one config-ish line, and keep them describing a
 * document that is obviously not in this knowledge base.
 */
const LENGTH_EXAMPLES = [
  "Defines the CommandData interface returned by the assistant backend: id, label and payload fields.",
  "Retry and timeout settings for the /v1/dispatch endpoint of the notification-router service.",
];

/** Loose comparison key, so a copy that differs only in case or trailing punctuation is still caught. */
const exampleKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
const EXAMPLE_KEYS = new Set(LENGTH_EXAMPLES.map(exampleKey));

const batchSystem = (maxWords: number) => `You write short contexts that situate each chunk of a document within the document and its project, to improve search retrieval.
The document is shown split into numbered chunks. For EVERY chunk id you must output exactly one line: the id, a colon, then 1 to 2 plain sentences (at most ${maxWords} words) saying what the chunk is about, which names it defines or uses, and which part of the document or project it belongs to.
Keep identifiers, file names, endpoints, product and team names verbatim. No markdown, no lists, no preamble, no blank lines, nothing but the numbered lines.

<length_example note="from an unrelated document; shows the length only">
${LENGTH_EXAMPLES.map((e, i) => `${i + 1}: ${e}`).join("\n")}
</length_example>`;

/**
 * "3: the context" → contexts[2]. Tolerates `3.`, `3)`, `[3]` and bold markers, ignores anything else the
 * model emits (including a line copied from `LENGTH_EXAMPLES`), and returns null for every id it did not
 * produce — those are retried one by one.
 */
export function parseBatchContexts(raw: string, n: number): (string | null)[] {
  const out = new Array<string | null>(n).fill(null);
  const text = raw.replace(/<think>[\s\S]*?<\/think>/g, "");
  for (const line of text.split("\n")) {
    const m = /^\s*[*_`]*\[?(\d{1,3})\]?[*_`]*\s*[:.)\]-]\s*(.+)$/.exec(line.trim());
    if (!m) continue;
    const i = Number(m[1]) - 1;
    if (i < 0 || i >= n || out[i]) continue;
    const ctx = sanitizeContext(m[2] as string);
    if (ctx && !EXAMPLE_KEYS.has(exampleKey(ctx))) out[i] = ctx;
  }
  return out;
}

/** Split chunks into groups whose combined content fits one prompt. */
export function groupChunks(chunks: Chunk[], maxChars: number): Chunk[][] {
  const out: Chunk[][] = [];
  let cur: Chunk[] = [];
  let n = 0;
  for (const c of chunks) {
    if (cur.length && n + c.content.length > maxChars) {
      out.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(c);
    n += c.content.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Model output → one clean paragraph (thinking tags, labels, quotes and markdown removed). */
export function sanitizeContext(raw: string): string {
  let s = raw
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^\s*(context|answer|succinct context)\s*:\s*/i, "")
    .replace(/^["'“”\s]+|["'“”\s]+$/g, "")
    // Markdown emphasis / headings / quotes, but never `_` inside identifiers (subject_token must survive).
    .replace(/\*\*|\*|^[#>\s]+|\s#{1,6}(?=\s)/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > 700) s = `${s.slice(0, 699).replace(/\s+\S*$/, "")}…`;
  return s.length < 10 ? "" : s;
}

export type CompleteFn = (messages: ChatMessage[], opts: { model: string; numCtx: number; maxTokens: number }) => Promise<string>;

export interface ContextualizerOptions {
  model: string;
  numCtx: number;
  maxDocChars: number;
  maxBackgroundChars: number;
  maxTokens: number;
  /** Document kinds that get an LLM context; the others get a deterministic one. */
  kinds: string[];
  /** Characters of chunk content per batched call; sized to fit `numCtx` with room for the answer. */
  groupChars: number;
  /** Per-kind override of `groupChars` (dense reference pages need smaller groups). */
  groupCharsByKind: Record<string, number>;
  /** Word budget asked of the model per context, and the token budget derived from it. */
  maxWords: number;
  /** Documents with fewer chunks than this get a deterministic context (nothing worth situating). */
  minChunks: number;
  /** Per-kind override of `minChunks` (e.g. code files, whose heading path already names the symbol). */
  minChunksByKind: Record<string, number>;
}

export interface ContextualizeResult {
  contexts: string[];
  /** Chunks the model actually wrote a context for (0 for documents that get a deterministic one). */
  generated: number;
  llmCalls: number;
  cacheHits: number;
  failures: number;
  /** Chunks the batch call skipped or truncated, re-asked one by one. */
  retries: number;
}

export class Contextualizer {
  constructor(
    private readonly complete: CompleteFn,
    private readonly cache: ContextCache | null,
    readonly opts: ContextualizerOptions,
  ) {}

  /** True when this document's chunks will be sent to the model (used for progress accounting). */
  usesModel(doc: Document, chunkCount: number): boolean {
    const min = this.opts.minChunksByKind[doc.meta.kind] ?? this.opts.minChunks;
    return chunkCount >= min && this.opts.kinds.includes(doc.meta.kind);
  }

  /**
   * Token budget for a batched answer. Generous on purpose: the cap only ever truncates the tail of the
   * group, and every truncated id costs a single-chunk retry, which is far more expensive than the tokens
   * a well-behaved answer leaves unused. Dense reference pages legitimately run to ~80 tokens a line.
   */
  private batchTokens(n: number): number {
    return Math.min(8192, n * Math.max(96, Math.ceil(this.opts.maxWords * 2.6)));
  }

  async contextualize(doc: Document, chunks: Chunk[], background: string): Promise<ContextualizeResult> {
    const res: ContextualizeResult = { contexts: [], generated: 0, llmCalls: 0, cacheHits: 0, failures: 0, retries: 0 };
    if (!chunks.length) return res;
    const bg = background.length > this.opts.maxBackgroundChars ? `${background.slice(0, this.opts.maxBackgroundChars - 1).trimEnd()}…` : background;
    const fallback = deterministicContext(doc, bg);
    if (!this.usesModel(doc, chunks.length)) {
      res.contexts = chunks.map(() => fallback);
      return res;
    }

    let file = (await this.cache?.load(doc.meta.sourceId)) ?? null;
    if (file && (file.model !== this.opts.model || file.promptVersion !== CONTEXT_PROMPT_VERSION)) file = null;
    const entries: Record<string, string> = { ...(file?.entries ?? {}) };
    let dirty = false;

    // Cached chunks are filled straight away; only the rest are grouped into calls. `todo` stays in
    // document order, so a partially cached document (a resumed run, or an edit that touched a few chunks)
    // still shows the model its remaining chunks in order — with gaps where the cached ones were.
    const out = new Array<string | null>(chunks.length).fill(null);
    const todo: number[] = [];
    chunks.forEach((c, i) => {
      const cached = entries[chunkKey(c)];
      if (cached) {
        out[i] = cached;
        res.cacheHits++;
      } else todo.push(i);
    });

    const head = doc.body.slice(0, Math.min(doc.body.length, 1200));
    const groupChars = this.opts.groupCharsByKind[doc.meta.kind] ?? this.opts.groupChars;
    for (const group of groupChunks(todo.map((i) => chunks[i] as Chunk), groupChars)) {
      const idx = group.map((c) => chunks.indexOf(c));
      // Re-state the opening of the document unless this group already contains it.
      const showHead = (chunks[idx[0] as number] as Chunk).ordinal > 0 && doc.body.length > groupChars;
      let parsed: (string | null)[] = new Array(group.length).fill(null);
      try {
        res.llmCalls++;
        const raw = await this.complete(buildBatchContextMessages(doc, group, bg, showHead ? head : "", this.opts.maxWords), {
          model: this.opts.model,
          numCtx: this.opts.numCtx,
          maxTokens: this.batchTokens(group.length),
        });
        parsed = parseBatchContexts(raw, group.length);
      } catch {
        /* every id falls through to the single-chunk retry below */
      }
      for (let j = 0; j < group.length; j++) {
        let ctx = parsed[j] ?? "";
        if (!ctx) {
          // The batch skipped or truncated this id: ask for it alone before giving up on the model.
          try {
            res.retries++;
            res.llmCalls++;
            ctx = sanitizeContext(
              await this.complete(buildContextMessages(doc, group[j] as Chunk, bg, this.opts.maxDocChars), {
                model: this.opts.model,
                numCtx: this.opts.numCtx,
                maxTokens: this.opts.maxTokens,
              }),
            );
          } catch {
            ctx = "";
          }
        }
        const at = idx[j] as number;
        if (ctx) {
          entries[chunkKey(chunks[at] as Chunk)] = ctx;
          dirty = true;
          res.generated++;
          out[at] = ctx;
        } else {
          res.failures++;
          out[at] = fallback;
        }
      }
    }

    res.contexts = out.map((c) => c ?? fallback);
    if (dirty && this.cache) {
      await this.cache.save({ version: 1, sourceId: doc.meta.sourceId, model: this.opts.model, promptVersion: CONTEXT_PROMPT_VERSION, entries });
    }
    return res;
  }
}

/** The contextualizer configured from .env; with the mock chat provider it produces deterministic text. */
export function createContextualizer(cacheDir: string | null): Contextualizer {
  const c = config.context;
  const opts: ContextualizerOptions = {
    model: c.model,
    numCtx: c.numCtx,
    maxDocChars: c.maxDocChars,
    maxBackgroundChars: c.maxBackgroundChars,
    maxTokens: c.maxTokens,
    kinds: c.kinds,
    groupChars: c.groupChars,
    groupCharsByKind: c.groupCharsByKind,
    maxWords: c.maxWords,
    minChunks: c.minChunks,
    minChunksByKind: c.minChunksByKind,
  };
  const complete: CompleteFn =
    config.chat.provider === "mock"
      ? async (messages) => {
          const user = messages.at(-1)?.content ?? "";
          const single = /<chunk>\n([\s\S]*?)\n<\/chunk>/.exec(user);
          if (single) return `Mock context for: ${(single[1] ?? "").split("\n")[0]?.slice(0, 60) ?? ""}`;
          const lines: string[] = [];
          for (const m of user.matchAll(/<chunk id="(\d+)"[^>]*>\n([\s\S]*?)\n<\/chunk>/g)) {
            lines.push(`${m[1]}: Mock context for: ${(m[2] ?? "").split("\n")[0]?.slice(0, 60) ?? ""}`);
          }
          return lines.join("\n");
        }
      : (messages, o) => getChatProvider().complete(messages, { model: o.model, temperature: 0, think: false, numCtx: o.numCtx, maxTokens: o.maxTokens });
  return new Contextualizer(complete, cacheDir ? new ContextCache(cacheDir) : null, opts);
}
