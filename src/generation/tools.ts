import { config } from "../config.js";
import type { ToolSpec } from "../llm/ollama.js";
import { DocumentNotFoundError, type DocumentStore, type FetchedDocument } from "../retrieval/documents.js";
import type { Citation, ChatMessage, ToolCall } from "../types.js";
import { deepLink } from "./prompt.js";

/**
 * Tools the answering model may call.
 *
 * Retrieval hands the model six ~450-token passages. `fetch_document` is the escape hatch for the
 * cases where that is not enough: the passage is the middle of a procedure, the retry table is in
 * the next section, the ADR's decision is quoted but not its consequences. The model asks for the
 * whole kb page by source_id (or by the citation number it was given) and gets it back as one more
 * context block, citable with the same [n] mechanism.
 */

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
  return config.tools.enabled ? [FETCH_DOCUMENT_TOOL] : [];
}

export interface ToolContext {
  store: DocumentStore;
  /** Citations already shown to the model; used to resolve "[3]" and to number new blocks. */
  citations: Citation[];
  /** Character cap for this call, so a long answer cannot spend the whole context on documents. */
  maxChars?: number;
  /**
   * Documents already read in this answer, as `sourceId::section` -> citation number. A model that
   * asks for the same page twice (often by the number the first result was given) gets a one-line
   * reminder instead of a second copy of the text.
   */
  fetched?: Map<string, number>;
}

export interface ToolOutcome {
  /** The `role: "tool"` message to append to the conversation. */
  message: ChatMessage;
  /** Short human-readable line for the UI / CLI. */
  summary: string;
  ok: boolean;
  /** Citation number the fetched document was given, when the call succeeded. */
  citationNumber?: number;
  /** A new citation to append (absent when the document was already a citation). */
  newCitation?: Citation;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
}

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
  if (name !== FETCH_DOCUMENT_TOOL.function.name) {
    return {
      ok: false,
      summary: `unknown tool ${name}`,
      message: {
        role: "tool",
        tool_name: name,
        content: `Error: there is no tool called "${name}". Available tools: ${FETCH_DOCUMENT_TOOL.function.name}.`,
      },
    };
  }

  const args = call.function.arguments;
  const requested = asString(args["source_id"]) || asString(args["sourceId"]) || asString(args["id"]);
  const section = asString(args["section"]) || null;
  const fail = (msg: string, summary: string): ToolOutcome => ({
    ok: false,
    summary,
    message: { role: "tool", tool_name: name, content: `Error: ${msg}` },
  });

  if (!requested) return fail("fetch_document needs a source_id.", "fetch_document without source_id");

  // The model may pass a citation number, a source_id, or something close to one.
  const byNumber = citationByNumber(requested, ctx.citations);
  const target = byNumber?.sourceId ?? requested;

  const key = `${ctx.store.resolve(target) ?? target}::${section ?? ""}`;
  const already = ctx.fetched?.get(key);
  if (already) {
    return {
      ok: true,
      citationNumber: already,
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
  const n = existing?.n ?? ctx.citations.length + 1;
  const newCitation: Citation | undefined = existing
    ? undefined
    : {
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
      };

  ctx.fetched?.set(`${doc.sourceId}::${doc.section ?? ""}`, n);
  if (key !== `${doc.sourceId}::${doc.section ?? ""}`) ctx.fetched?.set(key, n);

  return {
    ok: true,
    citationNumber: n,
    newCitation,
    summary:
      `read ${doc.sourceId}${doc.section ? ` § ${doc.section}` : ""}${doc.sectionNotFound ? ` (no section "${doc.sectionNotFound}")` : ""} ` +
      `(${doc.returnedChars}/${doc.totalChars} chars, ~${doc.tokenEstimate} tokens) as [${n}]`,
    message: { role: "tool", tool_name: name, content: formatDocument(doc, n) },
  };
}
