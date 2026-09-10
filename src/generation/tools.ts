import { config } from "../config.js";
import type { ToolSpec } from "../llm/ollama.js";
import { DocumentNotFoundError, type DocumentStore, type FetchedDocument } from "../retrieval/documents.js";
import type { RetrieveOptions } from "../retrieval/retriever.js";
import type { Citation, ChatMessage, RetrievalFilters, RetrievedChunk, ToolCall } from "../types.js";
import { BLOCK_SEPARATOR, deepLink, formatBlock, toCitation } from "./prompt.js";

/**
 * Tools the answering model may call.
 *
 * Retrieval hands the model a handful of ~450-token passages found by one search on the question.
 * Two tools cover the cases where that is not enough:
 *
 * - `search(query)` runs the same hybrid retrieval on a query of the model's choosing, for when the
 *   first pass missed the page: the user's words are not the documents' words, or the answer spans
 *   pages. Passages already in the context are not repeated, so every call adds something or says so.
 * - `fetch_document(source_id, section?)` reads the whole page a passage came from, for when the
 *   passage is the middle of a procedure, the retry table is in the next section, the ADR's decision
 *   is quoted but not its consequences.
 *
 * Both come back as numbered context blocks, citable with the same [n] mechanism, and both count
 * against the same character budget and round limit (see src/generation/ask.ts).
 */

export const SEARCH_TOOL: ToolSpec = {
  type: "function",
  function: {
    name: "search",
    description:
      "Search the knowledge base again with a different query. Use it when the CONTEXT blocks do not answer the question " +
      "or cover only part of it, and before saying the knowledge base does not cover something. Returns the most relevant " +
      "new passages as numbered blocks; passages already in the CONTEXT are not repeated.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "A short search query (2-10 words) phrased differently from the user's question: the service, repository, " +
            "endpoint, setting or error name; an acronym or its expansion; the Italian or English term; a term seen in a CONTEXT block.",
        },
      },
      required: ["query"],
    },
  },
};

export const FETCH_DOCUMENT_TOOL: ToolSpec = {
  type: "function",
  function: {
    name: "fetch_document",
    description:
      "Read a full knowledge-base document. Use it when a CONTEXT block is clearly the right page but is cut off, " +
      "references a section you cannot see, or you need the exact list, table, code or steps around it. " +
      "Returns the document markdown (long documents are truncated: ask again with `section` to get the rest).",
    parameters: {
      type: "object",
      properties: {
        source_id: {
          type: "string",
          description:
            "The document's source_id as shown in the context block (e.g. \"devportal:default/component/m3/m3/core-features/transfer-flow/\"), " +
            "or just the citation number of a context block (e.g. \"3\").",
        },
        section: {
          type: "string",
          description:
            "Optional heading to return instead of the whole document (matched loosely against the document's headings), " +
            "e.g. \"Retry policy\". Use it after a truncated result, picking a heading from the outline it listed.",
        },
      },
      required: ["source_id"],
    },
  },
};

/** Tool specs to send with the chat request; empty when tools are disabled. */
export function kbTools(): ToolSpec[] {
  if (!config.tools.enabled) return [];
  return config.tools.search ? [SEARCH_TOOL, FETCH_DOCUMENT_TOOL] : [FETCH_DOCUMENT_TOOL];
}

/** What the `search` tool needs from retrieval; the Retriever satisfies it, tests pass a stub. */
export interface Searcher {
  retrieve(query: string, opts?: RetrieveOptions): Promise<RetrievedChunk[]>;
}

export interface ToolContext {
  store: DocumentStore;
  /** Where `search` looks; without it the tool reports that it is unavailable. */
  searcher?: Searcher;
  /** The user's retrieval filters (source_type, kind, …), applied to tool searches as well. */
  filters?: RetrievalFilters;
  /** Citations already shown to the model; used to resolve "[3]", to number new blocks and to skip repeats. */
  citations: Citation[];
  /**
   * Lowest number a new block may take, minus one. A follow-up carries the numbers its chat already
   * handed out, and a carried block that no longer resolves is dropped — but its number stays spent,
   * or a new passage would take it and the `[n]` in the earlier answers would point at both.
   */
  numberFloor?: number;
  /** Character cap for this call, so a long answer cannot spend the whole context on tool results. */
  maxChars?: number;
  /**
   * Documents already read in this answer, as `sourceId::section` -> citation number. A model that
   * asks for the same page twice (often by the number the first result was given) gets a one-line
   * reminder instead of a second copy of the text.
   */
  fetched?: Map<string, number>;
  /** Queries already searched in this answer (normalised) -> the block numbers they produced. */
  searched?: Map<string, number[]>;
}

export interface ToolOutcome {
  /** The `role: "tool"` message to append to the conversation. */
  message: ChatMessage;
  /** Short human-readable line for the UI / CLI. */
  summary: string;
  ok: boolean;
  /** Numbers of the context blocks the result occupies (existing or new), when the call succeeded. */
  citationNumbers?: number[];
  /** New citations to append (absent when everything the call returned was already in the context). */
  newCitations?: Citation[];
}

function asString(v: unknown): string {
  if (typeof v === "number") return String(v);
  if (typeof v !== "string") return "";
  // A model that writes half its tool call as text leaves the next call's markup inside the
  // argument (`query="... </parameter></function><tool_call><function=search>..."`); cut it off.
  return (v.split("<")[0] ?? "").replace(/\s+/g, " ").trim();
}

/** `<function=name>` / `<parameter=key>` blocks, wrapped in `<tool_call>` or bare. */
const TEXT_CALL_RE = /<function=([\w.-]+)>([\s\S]*?)(?:<\/function>|<\/tool_call>|$)/g;
const TEXT_PARAM_RE = /<parameter=([\w.-]+)>([\s\S]*?)(?:<\/parameter>|$)/g;
const JSON_CALL_RE = /<tool_call>\s*(\{[\s\S]*?\})\s*(?:<\/tool_call>|$)/g;

/**
 * Tool calls a model wrote as prose instead of using the tool channel. Ollama only parses the tool
 * syntax into `tool_calls` when the request carries `tools`, and some models emit it as text even
 * when it does. Recovering them keeps the loop moving: a turn that is nothing but an unparsed call
 * would otherwise be read as the model's answer, so the answer would just stop.
 */
export function parseTextToolCalls(text: string): ToolCall[] {
  if (!text.includes("<function=") && !text.includes("<tool_call>")) return [];
  const calls: ToolCall[] = [];
  for (const m of text.matchAll(JSON_CALL_RE)) {
    try {
      const raw = JSON.parse(m[1] as string) as { name?: string; function?: { name?: string; arguments?: unknown }; arguments?: unknown };
      const name = raw.name ?? raw.function?.name;
      const args = (raw.arguments ?? raw.function?.arguments ?? {}) as Record<string, unknown>;
      if (name) calls.push({ function: { name, arguments: args && typeof args === "object" ? args : {} } });
    } catch {
      // not the JSON form; the pseudo-XML pass below may still find it
    }
  }
  for (const m of text.matchAll(TEXT_CALL_RE)) {
    const args: Record<string, unknown> = {};
    for (const p of (m[2] as string).matchAll(TEXT_PARAM_RE)) args[p[1] as string] = (p[2] as string).trim();
    calls.push({ function: { name: m[1] as string, arguments: args } });
  }
  return calls;
}

const blockList = (numbers: number[]): string => numbers.map((n) => `[${n}]`).join("");

/**
 * The number to give the next block. Taken from the highest number in use rather than the count of
 * citations: a follow-up carries the blocks its chat already gathered *with their original numbers*
 * (so the `[n]` in the earlier answers keep pointing at the same passage), and those numbers can
 * run well past the length of the list once trimming has dropped a few.
 */
export function nextBlockNumber(citations: Citation[], floor = 0): number {
  return citations.reduce((max, c) => Math.max(max, c.n), floor) + 1;
}

/** The citation for a whole document read with `fetch_document`, as block `n`. */
export function documentCitation(doc: FetchedDocument, n: number): Citation {
  return {
    n,
    chunkId: `${doc.sourceId}#document`,
    sourceId: doc.sourceId,
    title: doc.title,
    sourceUrl: doc.sourceUrl,
    sourceType: doc.sourceType,
    kind: doc.kind,
    authority: doc.authority,
    headingPath: doc.section ? `${doc.title} > ${doc.section}` : doc.title,
    relPath: doc.relPath,
    excerpt: doc.content.length > 600 ? `${doc.content.slice(0, 600)}…` : doc.content,
    lineStart: null,
    lineEnd: null,
    score: 0,
    section: doc.section,
  };
}

const failure = (name: string, msg: string, summary: string): ToolOutcome => ({
  ok: false,
  summary,
  message: { role: "tool", tool_name: name, content: `Error: ${msg}` },
});

/** A citation the model referred to by number ("3", "[3]"). */
function citationByNumber(ref: string, citations: Citation[]): Citation | undefined {
  const m = /^\[?(\d{1,3})\]?$/.exec(ref);
  return m ? citations.find((c) => c.n === Number(m[1])) : undefined;
}

/** Turn a fetched document into the text the model reads, numbered like every other context block. */
export function formatDocument(doc: FetchedDocument, n: number): string {
  const url = deepLink({ sourceUrl: doc.sourceUrl, kind: doc.kind, lineStart: null, lineEnd: null });
  const scope = doc.section ? `section "${doc.section}"` : "full document";
  const size = doc.truncated
    ? `${doc.returnedChars} of ${doc.totalChars} chars — TRUNCATED, call fetch_document again with a section from the outline to read further`
    : `${doc.returnedChars} chars`;
  const header = [
    `[${n}] ${doc.title} — ${doc.sourceId}`,
    `source_type=${doc.sourceType} kind=${doc.kind} authority=${doc.authority}` +
      `${doc.lastModified ? ` last_modified=${doc.lastModified}` : ""}${url ? ` url=${url}` : ""}`,
    doc.sectionNotFound
      ? `no section matching "${doc.sectionNotFound}" — returning the ${scope}, ${size}`
      : `${scope}, ${size}`,
    doc.outline.length ? `outline: ${doc.outline.slice(0, 40).join(" · ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `${header}\n\n${doc.content}`;
}

/** Run one tool call and produce the message to feed back to the model. */
export async function runToolCall(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
  const name = call.function.name;
  if (name === SEARCH_TOOL.function.name && config.tools.search) return runSearch(call, ctx);
  if (name === FETCH_DOCUMENT_TOOL.function.name) return runFetch(call, ctx);
  const available = kbTools().map((t) => t.function.name);
  return failure(
    name,
    `there is no tool called "${name}". Available tools: ${(available.length ? available : [FETCH_DOCUMENT_TOOL.function.name]).join(", ")}.`,
    `unknown tool ${name}`,
  );
}

// ---- search --------------------------------------------------------------------------------------

/** Two queries that differ only in case, punctuation or spacing are the same search. */
function normaliseQuery(q: string): string {
  return q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

const RETRY_HINT =
  "Try different words (a service or repository name, an acronym or its expansion, the term in the other language), " +
  "or answer from the CONTEXT and say what it does not cover.";

/**
 * `search(query)`: the same hybrid retrieval as the first pass, on the model's query, returning only
 * passages the model has not seen. A whole document the model already fetched counts as seen.
 */
async function runSearch(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
  const name = call.function.name;
  const args = call.function.arguments;
  const query = asString(args["query"]) || asString(args["q"]) || asString(args["question"]);
  if (!query) return failure(name, "search needs a query.", "search without query");
  if (!ctx.searcher) return failure(name, "search is not available for this answer; answer from the CONTEXT.", "search unavailable");

  const key = normaliseQuery(query);
  const before = ctx.searched?.get(key);
  if (before) {
    return {
      ok: true,
      citationNumbers: before,
      summary: `"${query}" was already searched (${before.length ? `blocks ${blockList(before)}` : "nothing new"})`,
      message: {
        role: "tool",
        tool_name: name,
        content:
          `You already searched "${query}"${before.length ? `: its results are blocks ${blockList(before)}` : " and it found nothing new"}. ` +
          `Use different words, or answer from the CONTEXT.`,
      },
    };
  }

  const want = Math.max(1, config.tools.searchTopK);
  let chunks: RetrievedChunk[];
  try {
    // Ask for more than needed: whatever is already in the context is dropped below.
    chunks = await ctx.searcher.retrieve(query, { topK: want + ctx.citations.length, filters: ctx.filters, noRerank: true });
  } catch (err) {
    return failure(name, `search failed (${(err as Error).message}).`, `search failed: ${query}`);
  }

  const seenChunks = new Set(ctx.citations.map((c) => c.chunkId));
  const wholeDocs = new Set<string>([
    ...ctx.citations.filter((c) => c.chunkId.endsWith("#document")).map((c) => c.sourceId),
    ...[...(ctx.fetched?.keys() ?? [])].filter((k) => k.endsWith("::")).map((k) => k.slice(0, -2)),
  ]);
  const fresh = chunks.filter((c) => !seenChunks.has(c.id) && !wholeDocs.has(c.sourceId)).slice(0, want);

  // Fit the budget: always at least one passage, then stop before the one that would overflow.
  const kept: RetrievedChunk[] = [];
  let size = 0;
  for (const c of fresh) {
    const len = c.content.length + 200;
    if (kept.length && ctx.maxChars !== undefined && size + len > ctx.maxChars) break;
    kept.push(c);
    size += len;
  }

  const start = nextBlockNumber(ctx.citations, ctx.numberFloor);
  const newCitations = kept.map((c, i) => toCitation(c, start + i));
  const numbers = newCitations.map((c) => c.n);
  ctx.searched?.set(key, numbers);

  if (!kept.length) {
    const allSeen = chunks.length > 0;
    return {
      ok: true,
      citationNumbers: [],
      summary: `"${query}" → nothing new${allSeen ? " (results already in the context)" : ""}`,
      message: {
        role: "tool",
        tool_name: name,
        content: allSeen
          ? `Search "${query}": no new passages, the results were already in the CONTEXT. ${RETRY_HINT}`
          : `Search "${query}": nothing found. ${RETRY_HINT}`,
      },
    };
  }

  const plural = kept.length === 1 ? "passage" : "passages";
  const body = kept.map((c, i) => formatBlock(c, start + i)).join(BLOCK_SEPARATOR);
  return {
    ok: true,
    citationNumbers: numbers,
    newCitations,
    summary: `"${query}" → ${kept.length} new ${plural} ${blockList(numbers)}`,
    message: { role: "tool", tool_name: name, content: `Search "${query}": ${kept.length} new ${plural}.\n\n${body}` },
  };
}

// ---- fetch_document ------------------------------------------------------------------------------

async function runFetch(call: ToolCall, ctx: ToolContext): Promise<ToolOutcome> {
  const name = call.function.name;
  const args = call.function.arguments;
  const requested = asString(args["source_id"]) || asString(args["sourceId"]) || asString(args["id"]);
  const section = asString(args["section"]) || null;
  const fail = (msg: string, summary: string): ToolOutcome => failure(name, msg, summary);

  if (!requested) return fail("fetch_document needs a source_id.", "fetch_document without source_id");

  // The model may pass a citation number, a source_id, or something close to one.
  const byNumber = citationByNumber(requested, ctx.citations);
  const target = byNumber?.sourceId ?? requested;

  const key = `${ctx.store.resolve(target) ?? target}::${section ?? ""}`;
  const already = ctx.fetched?.get(key);
  if (already) {
    return {
      ok: true,
      citationNumbers: [already],
      summary: `${target} was already read (block [${already}])`,
      message: {
        role: "tool",
        tool_name: name,
        content: `This document is already in the context as block [${already}]${section ? ` (section "${section}")` : ""}. Answer from it instead of fetching it again.`,
      },
    };
  }

  let doc: FetchedDocument;
  try {
    doc = await ctx.store.fetch(target, { section, maxChars: ctx.maxChars });
  } catch (err) {
    if (err instanceof DocumentNotFoundError) {
      const hint = ctx.citations.length
        ? ` Source ids in the context: ${[...new Set(ctx.citations.map((c) => c.sourceId))].slice(0, 8).join(", ")}.`
        : "";
      return fail(`${err.message}.${hint}`, `document not found: ${requested}`);
    }
    return fail(`could not read the document (${(err as Error).message}).`, `fetch failed: ${requested}`);
  }

  // A document that is already cited keeps its number, so the answer's [n] stay stable.
  const existing = ctx.citations.find((c) => c.sourceId === doc.sourceId);
  const n = existing?.n ?? nextBlockNumber(ctx.citations, ctx.numberFloor);
  const newCitation: Citation | undefined = existing ? undefined : documentCitation(doc, n);

  ctx.fetched?.set(`${doc.sourceId}::${doc.section ?? ""}`, n);
  if (key !== `${doc.sourceId}::${doc.section ?? ""}`) ctx.fetched?.set(key, n);

  return {
    ok: true,
    citationNumbers: [n],
    ...(newCitation ? { newCitations: [newCitation] } : {}),
    summary:
      `read ${doc.sourceId}${doc.section ? ` § ${doc.section}` : ""}${doc.sectionNotFound ? ` (no section "${doc.sectionNotFound}")` : ""} ` +
      `(${doc.returnedChars}/${doc.totalChars} chars, ~${doc.tokenEstimate} tokens) as [${n}]`,
    message: { role: "tool", tool_name: name, content: formatDocument(doc, n) },
  };
}
