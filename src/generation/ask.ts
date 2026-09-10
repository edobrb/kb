import { config } from "../config.js";
import { getChatProvider } from "../llm/chat.js";
import { modelSupportsTools } from "../llm/ollama.js";
import { DocumentNotFoundError, getDocumentStore } from "../retrieval/documents.js";
import { Retriever } from "../retrieval/retriever.js";
import type { AskEvent, AskMode, AskRequest, CarriedBlock, ChatMessage, Citation, TokenUsage, ToolCall } from "../types.js";
import {
  ANSWER_NOW_NOTE,
  type ContextBlock,
  blockFor,
  blocksFor,
  buildMessages,
  extractCitedNumbers,
  stripToolCallText,
} from "./prompt.js";
import { documentCitation, formatDocument, kbTools, parseTextToolCalls, runToolCall } from "./tools.js";

let retrieverPromise: Promise<Retriever> | null = null;
export function getRetriever(): Promise<Retriever> {
  if (!retrieverPromise) retrieverPromise = Retriever.open();
  return retrieverPromise;
}

/** Drop the cached retriever so the next question re-opens the (possibly re-ingested) index. */
export function resetRetriever(): void {
  retrieverPromise = null;
}

function lastUserQuestion(messages: ChatMessage[]): { question: string; history: ChatMessage[] } {
  const idx = messages.map((m) => m.role).lastIndexOf("user");
  if (idx < 0) throw new Error("Request must contain at least one user message");
  const question = (messages[idx] as ChatMessage).content.trim();
  if (!question) throw new Error("Question is empty");
  return { question, history: messages.slice(0, idx) };
}

/**
 * Turn a follow-up question ("and for M2M tokens?") into a standalone search query using
 * the conversation so far. Skipped when there is no history or QUERY_REWRITE=false.
 */
async function rewriteQuery(question: string, history: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const priorTurns = history.filter((m) => m.role !== "system").slice(-4);
  if (!config.retrieval.queryRewrite || priorTurns.length === 0 || config.chat.provider === "mock") return question;
  const transcript = priorTurns.map((m) => `${m.role}: ${m.content.slice(0, 800)}`).join("\n");
  const prompt =
    `Rewrite the last user question as a single self-contained search query, in the same language, ` +
    `resolving pronouns and references using the conversation. Output only the query.\n\n` +
    `Conversation:\n${transcript}\n\nLast question: ${question}`;
  try {
    const out = await getChatProvider().complete([{ role: "user", content: prompt }], {
      temperature: 0,
      think: false,
      signal,
    });
    const rewritten = out.trim().split("\n")[0]?.replace(/^["']|["']$/g, "").trim();
    return rewritten && rewritten.length < 400 ? rewritten : question;
  } catch {
    return question;
  }
}

/** Characters of a turn held back before streaming, in case the turn turns out to be a tool call. */
const PREAMBLE_HOLD = 240;

/**
 * Remaining TOOL_CHAR_BUDGET below which a round is not worth running: the document store floors a
 * read at 500 chars, so a nearly spent budget buys a stub of a page (`469/66475 chars`) and costs a
 * whole round. Stop and answer instead.
 */
const MIN_TOOL_RESULT_CHARS = 2000;

/** Below this, a turn that also wrote a tool call counts as a stub rather than an answer. */
const ANSWER_STUB_CHARS = 400;

/** A single turn asking for a dozen documents is a runaway, not a plan. */
const MAX_CALLS_PER_ROUND = 2;

/**
 * Retrieval width and tool head-room for one answer, widened by "extended research" mode. Every
 * value is taken as a maximum against the plain one: an .env that raises RETRIEVAL_TOP_K or
 * TOOL_MAX_ROUNDS above the research defaults must not make the research mode the narrower of the two.
 */
function effortFor(mode: AskMode): { topK: number; maxRounds: number; charBudget: number } {
  const base = { topK: config.retrieval.topK, maxRounds: config.tools.maxRounds, charBudget: config.tools.charBudget };
  if (mode !== "research") return base;
  return {
    topK: Math.max(base.topK, config.retrieval.researchTopK),
    maxRounds: Math.max(base.maxRounds, config.tools.research.maxRounds),
    charBudget: Math.max(base.charBudget, config.tools.research.charBudget),
  };
}

/** `<sourceId>#document` is how a whole page read with `fetch_document` is identified. */
const DOCUMENT_SUFFIX = "#document";

/**
 * Rebuild the CONTEXT blocks a chat has already gathered, from the ids the client sends back with
 * the follow-up (see `AskRequest.context`). Only ids travel, so nothing the server has to remember
 * between requests: passages are re-read from the index by chunk id, and a page an earlier turn
 * read whole is re-read from the document store.
 *
 * Each block keeps the number it had in the conversation, because the earlier answers are in the
 * transcript with their `[n]` and those have to keep pointing at the same passage. Blocks that no
 * longer resolve (a re-ingest changed their ids) are dropped rather than renumbered.
 */
async function carriedBlocks(carry: CarriedBlock[], retriever: Retriever, fetched: Map<string, number>): Promise<ContextBlock[]> {
  const seen = new Set<string>();
  const wanted = carry
    .filter((b) => typeof b.chunkId === "string" && b.chunkId && Number.isFinite(b.n) && !seen.has(b.chunkId) && seen.add(b.chunkId))
    // What survives the trim: the blocks the earlier answers actually cited, then the most recent.
    .sort((a, b) => Number(Boolean(b.cited)) - Number(Boolean(a.cited)) || b.n - a.n)
    .slice(0, config.retrieval.carryMaxBlocks);
  if (!wanted.length) return [];

  const chunkIds = wanted.filter((b) => !b.chunkId.endsWith(DOCUMENT_SUFFIX)).map((b) => b.chunkId);
  const rows = new Map((await retriever.chunksByIds(chunkIds)).map((c) => [c.id, c]));
  const store = await getDocumentStore();

  const resolved: (ContextBlock & { document?: { sourceId: string; section: string | null } })[] = [];
  for (const b of wanted) {
    if (!b.chunkId.endsWith(DOCUMENT_SUFFIX)) {
      const chunk = rows.get(b.chunkId);
      if (chunk) resolved.push(blockFor(chunk, b.n));
      continue;
    }
    const sourceId = b.chunkId.slice(0, -DOCUMENT_SUFFIX.length);
    const section = b.section ?? null;
    try {
      const doc = await store.fetch(sourceId, { section, maxChars: config.tools.docMaxChars });
      resolved.push({
        n: b.n,
        text: formatDocument(doc, b.n),
        citation: documentCitation(doc, b.n),
        document: { sourceId: doc.sourceId, section: doc.section },
      });
    } catch (err) {
      if (!(err instanceof DocumentNotFoundError)) throw err;
      // The page is gone from the knowledge base; the conversation continues without that block.
    }
  }

  // Fit the budget in the same priority order, then hand the blocks back in numbering order.
  const kept: typeof resolved = [];
  let chars = 0;
  for (const block of resolved) {
    if (kept.length && chars + block.text.length > config.retrieval.carryMaxChars) continue;
    kept.push(block);
    chars += block.text.length;
  }
  // A page already in the context must not be fetched again: the tool answers with a pointer to the
  // block instead of a second copy of the text (see runFetch).
  for (const block of kept) {
    if (block.document) fetched.set(`${block.document.sourceId}::${block.document.section ?? ""}`, block.n);
  }
  return kept.sort((a, b) => a.n - b.n).map(({ n, text, citation }) => ({ n, text, citation }));
}

/**
 * Tools are only offered when they are configured *and* the model can call them: Ollama silently
 * ignores `tools` on a model without tool support, which would leave the prompt promising a tool
 * that never fires.
 */
export async function toolsAvailable(): Promise<boolean> {
  if (!config.tools.enabled) return false;
  if (config.chat.provider === "mock") return true;
  return modelSupportsTools();
}

/**
 * The full RAG loop as an async stream of events, shared by the CLI and the SSE endpoint:
 * status -> sources -> (tool | token)* -> done   (or error)
 */
export async function* ask(req: AskRequest, signal?: AbortSignal): AsyncGenerator<AskEvent> {
  const timings: Record<string, number> = {};
  const t0 = Date.now();
  try {
    const { question, history } = lastUserQuestion(req.messages);
    const mode: AskMode = req.mode ?? "fast";
    const effort = effortFor(mode);
    const retriever = await getRetriever();

    const think = req.think ?? config.chat.think;
    const useTools = req.tools ?? (await toolsAvailable());
    const tools = useTools ? kbTools() : undefined;
    const fetched = new Map<string, number>();
    const searched = new Map<string, number[]>();

    // Continuing a chat is not a new question: the blocks it already gathered stay in place and no
    // search is run, so the answers keep building on the same passages instead of standing on a
    // fresh retrieval the user never asked for. `search` is what covers a question those blocks do
    // not reach — hence the requirement that the model actually have it, without which a follow-up
    // on a new topic would have no way at all to find its documents.
    let blocks: ContextBlock[] = [];
    if (history.length && req.context?.length && tools && !config.retrieval.followUpSearch) {
      yield { type: "status", message: "Continuing from this chat's sources…" };
      blocks = await carriedBlocks(req.context, retriever, fetched);
    }
    const carried = blocks.length > 0;

    if (!carried) {
      yield { type: "status", message: mode === "research" ? "Extended research: searching the knowledge base…" : "Searching the knowledge base…" };
      const searchQuery = await rewriteQuery(question, history, signal);
      timings.rewriteMs = Date.now() - t0;
      if (searchQuery !== question) yield { type: "status", message: `Search query: ${searchQuery}` };

      const t1 = Date.now();
      const chunks = await retriever.retrieve(searchQuery, { topK: req.topK ?? effort.topK, filters: req.filters });
      timings.retrieveMs = Date.now() - t1;
      blocks = blocksFor(chunks);
    }

    // Numbers the chat has already handed out, including any carried block that no longer resolves:
    // a number stays spent for the life of the conversation (see ToolContext.numberFloor).
    const numberFloor = carried ? (req.context ?? []).reduce((max, b) => Math.max(max, b.n), 0) : 0;
    let citations = blocks.map((b) => b.citation);
    yield { type: "sources", citations, ...(carried ? { carried: citations.map((c) => c.n) } : {}) };

    if (!blocks.length) {
      const msg = "I could not find anything relevant in the knowledge base for this question.";
      yield { type: "token", text: msg };
      yield { type: "done", answer: msg, thinking: "", usedCitations: [], timings };
      return;
    }
    if (carried) timings.carriedBlocks = blocks.length;

    yield { type: "status", message: `Answering with ${config.chat.model}…` };
    const messages = buildMessages(history, question, blocks, { tools: tools?.map((t) => t.function.name), mode, carried });
    // Same system message minus the tool instructions, swapped in on the last round: a prompt that
    // still invites a call while the request carries no tools gets the model's raw `<tool_call>`
    // text in the answer, since Ollama only parses tool syntax when tools are in the request.
    const finalSystem = tools ? buildMessages([], question, blocks, { toolsExhausted: true, carried })[0]! : undefined;

    const t2 = Date.now();
    let answer = "";
    let thinking = "";
    let toolChars = 0;
    let toolCalls = 0;
    let searches = 0;
    // Token accounting. The prompt grows with every tool result, so the *last* round's prompt is
    // what occupies the window; generated tokens accumulate over all of them.
    let promptTokens = 0;
    let completionTokens = 0;
    const usage = (): TokenUsage => ({ promptTokens, completionTokens, numCtx: config.chat.numCtx });
    // Ollama only reports the prompt size once a round is over, which is too late for a live meter,
    // so each round opens with a ~4-chars-per-token estimate of the prompt about to be sent.
    const estimatedUsage = (msgs: ChatMessage[]): TokenUsage => ({
      promptTokens: Math.ceil(msgs.reduce((n, m) => n + m.content.length + JSON.stringify(m.tool_calls ?? "").length, 0) / 4),
      completionTokens,
      numCtx: config.chat.numCtx,
      estimated: true,
    });
    // Tool loop: the model may search again (search) or read whole documents (fetch_document) before
    // answering. The last round is always run without tools, so a model that keeps calling still
    // produces an answer.
    let forceAnswer = false;
    let nudged = false;
    for (let round = 0; ; round++) {
      const budgetLeft = effort.charBudget - toolChars;
      const lastRound = forceAnswer || !tools || round >= effort.maxRounds || budgetLeft < MIN_TOOL_RESULT_CHARS;
      if (lastRound && finalSystem) messages[0] = finalSystem;
      yield { type: "usage", usage: estimatedUsage(messages) };
      const calls: ToolCall[] = [];
      let turnText = "";
      let buffered = "";
      let flushed = false;
      let leaked = false;
      let reported = false;   // did the runtime send token counts for this round?

      for await (const delta of getChatProvider().stream(messages, { signal, think, tools: lastRound ? undefined : tools })) {
        if (delta.thinking) {
          thinking += delta.thinking;
          yield { type: "thinking", text: delta.thinking };
        }
        if (delta.toolCalls?.length) calls.push(...delta.toolCalls);
        if (delta.usage) {
          // A runtime that reports nothing for a round (or a tool-call round it does not count)
          // must not zero the meter: keep the last measured prompt.
          if (delta.usage.promptTokens) {
            promptTokens = delta.usage.promptTokens;
            reported = true;
          }
          completionTokens += delta.usage.completionTokens;
        }
        if (delta.content) {
          turnText += delta.content;
          // A tool call written as text: keep the rest of the turn off screen (see stripToolCallText).
          if (leaked || (leaked = /<(?:tool_call|function=)/.test(turnText))) continue;
          // Hold the first few tokens back: a turn that ends in a tool call usually starts with a
          // throwaway preamble, and once it is on screen it has to stay part of the answer.
          if (flushed) {
            yield { type: "token", text: delta.content };
          } else {
            buffered += delta.content;
            if (buffered.length >= PREAMBLE_HOLD) {
              flushed = true;
              yield { type: "token", text: buffered };
            }
          }
        }
      }

      yield { type: "usage", usage: reported ? usage() : estimatedUsage(messages) };

      // A call the model wrote as text rather than through the tool channel: run it instead of
      // reading the turn as an answer, which is how a turn of pure markup ends up looking like a
      // one-line answer that stops.
      if (!calls.length && !lastRound && leaked) calls.push(...parseTextToolCalls(turnText));

      if (!calls.length) {
        const visible = stripToolCallText(turnText);
        // The turn was a tool call the model could not make, with no answer around it (typically a
        // one-line "let me read more"). Tell it plainly to answer and run one more round; without
        // this the stripped preamble is all the user gets.
        if (leaked && !nudged && visible.length < ANSWER_STUB_CHARS) {
          nudged = true;
          forceAnswer = true;
          messages.push({ role: "user", content: ANSWER_NOW_NOTE });
          continue;
        }
        if (!flushed && buffered) yield { type: "token", text: stripToolCallText(buffered) };
        answer += visible;
        break;
      }

      if (flushed) answer += stripToolCallText(turnText); // already shown to the user, so it is part of the answer
      // Every declared call must get a result back, so drop the extras before echoing the turn.
      const accepted = calls.slice(0, MAX_CALLS_PER_ROUND);
      // Echo the turn with the call in the structured field only: leaving the markup in the
      // content teaches the model to keep writing calls as text.
      messages.push({ role: "assistant", content: stripToolCallText(turnText), tool_calls: accepted });

      const store = await getDocumentStore();
      for (const call of accepted) {
        const isSearch = call.function.name === "search";
        if (isSearch) searches += 1;
        yield {
          type: "status",
          message: isSearch ? `Searching again: ${String(call.function.arguments["query"] ?? "").slice(0, 120)}…` : "Reading the document…",
        };
        const budget = Math.max(0, effort.charBudget - toolChars);
        const outcome = await runToolCall(call, {
          store,
          searcher: retriever,
          filters: req.filters,
          citations,
          numberFloor,
          fetched,
          searched,
          maxChars: Math.min(config.tools.docMaxChars, budget),
        });
        messages.push(outcome.message);
        toolChars += outcome.message.content.length;
        toolCalls += 1;
        if (outcome.newCitations?.length) {
          citations = [...citations, ...outcome.newCitations];
          yield { type: "sources", citations };
        }
        yield {
          type: "tool",
          name: call.function.name,
          args: call.function.arguments,
          summary: outcome.summary,
          ok: outcome.ok,
          ...(outcome.citationNumbers?.length ? { citations: outcome.citationNumbers } : {}),
        };
      }
      yield { type: "status", message: `Answering with ${config.chat.model}…` };
    }

    timings.generateMs = Date.now() - t2;
    timings.totalMs = Date.now() - t0;
    if (toolCalls) timings.toolCalls = toolCalls;
    if (searches) timings.searches = searches;
    yield { type: "done", answer, thinking, usedCitations: extractCitedNumbers(answer, citations.map((c) => c.n)), timings, usage: usage() };
  } catch (err) {
    if (signal?.aborted) return;
    yield { type: "error", message: (err as Error).message };
  }
}

/** One tool call as reported by `askOnce` (the streaming API emits these as `tool` events). */
export interface ToolTrace {
  name: string;
  args: Record<string, unknown>;
  summary: string;
  ok: boolean;
  citations?: number[];
}

/** Convenience: run `ask` to completion and return the final answer + citations. */
export async function askOnce(req: AskRequest) {
  let answer = "";
  let thinking = "";
  let citations: Citation[] = [];
  let usedCitations: number[] = [];
  let timings: Record<string, number> = {};
  let usage: TokenUsage | undefined;
  const tools: ToolTrace[] = [];
  for await (const ev of ask(req)) {
    if (ev.type === "sources") citations = ev.citations;
    else if (ev.type === "tool") tools.push({ name: ev.name, args: ev.args, summary: ev.summary, ok: ev.ok, ...(ev.citations ? { citations: ev.citations } : {}) });
    else if (ev.type === "done") ({ answer, thinking, usedCitations, timings, usage } = ev);
    else if (ev.type === "error") throw new Error(ev.message);
  }
  return { answer, thinking, citations, usedCitations, timings, tools, usage };
}
