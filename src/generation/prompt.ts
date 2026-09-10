import type { AskMode, ChatMessage, Citation, RetrievedChunk } from "../types.js";

export const SYSTEM_PROMPT = `You are the internal knowledge assistant for TeamSystem OnePlatform. Your knowledge base contains the Developer Portal documentation (TechDocs pages, API definitions), the OnePlatform GitLab repositories (README and docs, project cards, and the SOURCE CODE itself) and a few hand-written references (glossary, manifesto, ADRs).

Rules:
- Answer ONLY from the CONTEXT blocks below (plus any document you read with a tool). Do not use outside knowledge about TeamSystem.
- If the context does not contain the answer, say so plainly (e.g. "The knowledge base does not cover this") and, if useful, say which related topics the context does cover. Never invent names, dates, endpoints, values, code or policies.
- Cite your sources: after each sentence or bullet that relies on a context block, add its number like [1] or [2][4]. Only cite blocks you actually used.
- Prefer blocks marked authority=binding or normative (ADRs, standards) when they conflict with descriptive pages, and mention the conflict.
- When the answer comes from source code (kind=code), name the repository and file path, quote the relevant lines in a code block, and describe what the code does rather than paraphrasing it loosely. Distinguish what the code does from what the documentation says when they differ.
- Reply in the same language as the user's question (Italian or English). Keep the same terminology used in the documents.
- Be concise and concrete: use short paragraphs, code blocks for code/config, and tables only when the context has tabular data.`;

/** GitLab blob URL with a line anchor for code chunks; other URLs unchanged. */
export function deepLink(c: Pick<RetrievedChunk, "sourceUrl" | "kind" | "lineStart" | "lineEnd">): string | null {
  if (!c.sourceUrl) return null;
  if (c.kind === "code" && c.lineStart && /\/-\/blob\//.test(c.sourceUrl)) {
    return `${c.sourceUrl}#L${c.lineStart}${c.lineEnd && c.lineEnd > c.lineStart ? `-${c.lineEnd}` : ""}`;
  }
  return c.sourceUrl;
}

/** One retrieved chunk as citation number `n`. */
export function toCitation(c: RetrievedChunk, n: number): Citation {
  return {
    n,
    chunkId: c.id,
    sourceId: c.sourceId,
    title: c.title,
    sourceUrl: deepLink(c),
    sourceType: c.sourceType,
    kind: c.kind,
    authority: c.authority,
    headingPath: c.headingPath,
    relPath: c.relPath,
    excerpt: c.content.length > 600 ? `${c.content.slice(0, 600)}…` : c.content,
    lineStart: c.lineStart,
    lineEnd: c.lineEnd,
    score: c.score,
  };
}

/** One numbered context block: heading path, kind, authority and URL, then the passage. */
export function formatBlock(c: RetrievedChunk, n: number): string {
  const url = deepLink(c);
  const header = [
    `[${n}] ${c.headingPath}${c.kind === "code" && c.lineStart ? ` (lines ${c.lineStart}-${c.lineEnd})` : ""}`,
    `source_type=${c.sourceType} kind=${c.kind} authority=${c.authority}${url ? ` url=${url}` : ""}`,
  ].join("\n");
  return `${header}\n${c.content}`;
}

export const BLOCK_SEPARATOR = "\n\n-----\n\n";

/**
 * One numbered CONTEXT block, paired with the citation that describes it.
 *
 * Blocks reach an answer from three places — the retrieval pass, a `search`/`fetch_document` call,
 * and (on a follow-up) the blocks the chat already gathered — so the number cannot be derived from
 * a position in the list: it is carried explicitly, which is what keeps the `[n]` in earlier
 * answers pointing at the same passage.
 */
export interface ContextBlock {
  n: number;
  /** The block as the model reads it, already headed with `[n]`. */
  text: string;
  citation: Citation;
}

/** One retrieved chunk as context block `n`. */
export function blockFor(c: RetrievedChunk, n: number): ContextBlock {
  return { n, text: formatBlock(c, n), citation: toCitation(c, n) };
}

/** Retrieved chunks as consecutive blocks, numbered from `start` (ranking order). */
export function blocksFor(chunks: RetrievedChunk[], start = 1): ContextBlock[] {
  return chunks.map((c, i) => blockFor(c, start + i));
}

export function formatContext(blocks: ContextBlock[]): string {
  return blocks.map((b) => b.text).join(BLOCK_SEPARATOR);
}

/**
 * Appended to the system prompt when the model is given tools. Imperative and short on purpose: a
 * local model with thinking off has nowhere to put deliberation, and a prompt that invites it to
 * weigh whether to call a tool gets that deliberation back as the answer.
 */
export function toolInstructions(tools: string[], mode: AskMode = "fast", carried = false): string {
  const search = tools.includes("search");
  const fetch = tools.includes("fetch_document");
  if (!search && !fetch) return "";
  const lines = [
    carried
      ? `Tools. Each CONTEXT block is a passage of a larger page, gathered earlier in this conversation: no search was run for this question, so the blocks cover what was asked before and not necessarily what is asked now.`
      : `Tools. Each CONTEXT block is a passage of a larger page, found by one search on the user's question.`,
  ];
  // The one thing the model must take from a carried context: nothing has looked this question up,
  // so if the blocks fall short it has to say so itself. Without the search tool there is no call to
  // point it at, and the bullet is left out rather than promising one it cannot make.
  if (carried && search) {
    lines.push(
      `- This question has NOT been searched for. If the CONTEXT does not already cover it — a new topic, a service or document it does not mention — call search(query) before you answer, instead of answering from the nearest block.`,
    );
  }
  if (search) {
    lines.push(
      `- search(query): search the knowledge base again. Call it when the CONTEXT does not answer the question, or answers only part of it, and always before saying the knowledge base does not cover something. Use the words the documents would use, not the user's: the service, repository, endpoint, setting or error name; an acronym or its expansion; the Italian or English term; a term you saw in a CONTEXT block. One short query per call.`,
    );
  }
  if (fetch) {
    lines.push(
      `- fetch_document(source_id, section?): read a whole page. Call it when a block is the right page but the answer needs what surrounds the passage: the rest of a procedure, a full list or table, exact values, a section the text refers to. Pass that block's source_id, or its number ("3"). A truncated result lists the page outline; call again with one of those sections. Never invent a source_id.`,
    );
  }
  lines.push(
    `- Otherwise answer straight from the CONTEXT. Do not explain or announce your decision about the tools, and never describe the CONTEXT block by block: either call a tool or write the answer.`,
    `- Tool results arrive as numbered blocks like the others and are cited the same way.`,
  );
  if (mode === "research") lines.push(researchNote(search, fetch));
  return lines.join("\n");
}

/**
 * Extra tool instructions for "extended research" mode. The user asked for a thorough answer, so the
 * default "answer straight from the CONTEXT when you can" is inverted: search before answering, from
 * more than one angle, and read the pages the passages were cut from. Kept imperative like the rest
 * (see the note on toolInstructions).
 */
function researchNote(search: boolean, fetch: boolean): string {
  const steps = [
    search ? `search again with a different wording (a synonym, the English or Italian term, the service or repository name) before you answer, even when the CONTEXT looks sufficient` : "",
    fetch ? `read the full page behind every CONTEXT block you intend to cite, with fetch_document` : "",
  ].filter(Boolean);
  return (
    `- EXTENDED RESEARCH is on for this question: the user wants a thorough, well-sourced answer and accepts a slower one. ` +
    `Before writing it, ${steps.join(", and ")}. Cover every part of a multi-part question, and check whether an ADR or standard ` +
    `constrains what the descriptive pages say. Only answer once further calls stop adding anything, then answer at length, ` +
    `citing every source you used.`
  );
}

/**
 * Where the CONTEXT came from, on the rounds that carry no tools (the final round, or a model
 * without tool support). A follow-up continues on the blocks the chat already gathered rather than
 * swapping them out under the user, so nothing has looked this question up — and with no tool left
 * to fix that, the model has to be told to admit the gap instead of stretching a near-miss block
 * into an answer.
 */
export const CARRIED_CONTEXT_NOTE =
  `Context. The CONTEXT blocks were gathered earlier in this conversation; no search was run for ` +
  `this question. Answer from them where they cover it, and say plainly what they do not cover.`;

/**
 * Replaces the tool instructions on the final round, once the rounds or the character budget are
 * spent and the request goes out with no `tools`. Ollama only parses tool-call syntax into
 * `tool_calls` when tools are in the request, so a prompt that still invites a call gets the
 * model's raw `<tool_call>` text streamed into the answer.
 */
export const NO_TOOLS_NOTE =
  `Tools. You have already searched and read what you could; no tool is available now. ` +
  `Answer from the CONTEXT blocks. Do not write a tool call, and do not mention tools or searching.`;

/**
 * A model that wants a tool it no longer has writes the call as plain text (`<tool_call>
 * <function=search> ...`). Ollama does not parse it back into `tool_calls` when the request
 * carries no tools, so it would otherwise end up in the visible answer.
 */
const TOOL_CALL_TEXT = /<tool_call>[\s\S]*?<\/tool_call>|<(?:tool_call|function=|parameter=)[\s\S]*$/g;

export function stripToolCallText(text: string): string {
  return TOOL_CALL_TEXT.test(text) ? text.replace(TOOL_CALL_TEXT, "").trimEnd() : text;
}

/**
 * Last resort when the model answers the final round with a tool call it can no longer make: a
 * plain user turn stops the pattern where swapping the system prompt does not, because the model
 * has its own tool calls in the transcript above and keeps imitating them.
 */
export const ANSWER_NOW_NOTE =
  `Stop. No tool is available and no further search will run. Write the full answer now, ` +
  `from the CONTEXT blocks above, with citations. Do not write a tool call.`;

export interface BuildOptions {
  /** Keep at most this many prior turns. */
  maxHistory?: number;
  /** Names of the tools the model is given (`search`, `fetch_document`); adds their instructions. */
  tools?: string[];
  /** Final round: tools were offered earlier but are withdrawn now, so say so (`NO_TOOLS_NOTE`). */
  toolsExhausted?: boolean;
  /** `research` pushes the model to search and read more before answering. Defaults to `fast`. */
  mode?: AskMode;
  /** The context came from earlier turns of the chat, not from a search on this question. */
  carried?: boolean;
}

function toolSection(opts: BuildOptions): string {
  const carriedNote = opts.carried ? `\n\n${CARRIED_CONTEXT_NOTE}` : "";
  if (opts.toolsExhausted) return `\n\n${NO_TOOLS_NOTE}${carriedNote}`;
  if (!opts.tools?.length) return carriedNote;
  return `\n\n${toolInstructions(opts.tools, opts.mode, opts.carried)}`;
}

/**
 * Build the chat transcript sent to the model. Retrieved context goes into the system prompt;
 * prior turns are kept (trimmed) so follow-up questions work.
 */
export function buildMessages(
  history: ChatMessage[],
  question: string,
  blocks: ContextBlock[],
  opts: BuildOptions = {},
): ChatMessage[] {
  const maxHistory = opts.maxHistory ?? 6;
  const system: ChatMessage = {
    role: "system",
    content: `${SYSTEM_PROMPT}${toolSection(opts)}\n\nCONTEXT:\n\n${formatContext(blocks)}`,
  };
  const prior = history.filter((m) => m.role !== "system").slice(-maxHistory);
  return [...[system], ...prior, { role: "user", content: question }];
}

/**
 * Extract the `[n]` citation numbers the model actually used, in first-use order.
 *
 * `valid` is the numbers the context really has, not a count: a follow-up carries the numbers its
 * chat handed out, so 24 blocks can be numbered up to `[26]` and a range check would throw away
 * every citation above the count. Numbers with no block behind them (the model invented one, or its
 * block was dropped as stale) are left out.
 */
export function extractCitedNumbers(answer: string, valid: Iterable<number>): number[] {
  const known = new Set(valid);
  const seen = new Set<number>();
  for (const m of answer.matchAll(/\[(\d{1,3})\]/g)) {
    const n = Number(m[1]);
    if (known.has(n)) seen.add(n);
  }
  return [...seen];
}
