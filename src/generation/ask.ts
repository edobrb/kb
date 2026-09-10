import { config } from "../config.js";
import { getChatProvider } from "../llm/chat.js";
import { modelSupportsTools } from "../llm/ollama.js";
import { getDocumentStore } from "../retrieval/documents.js";
import { Retriever } from "../retrieval/retriever.js";
import type { AskEvent, AskRequest, ChatMessage, Citation, ToolCall } from "../types.js";
import { ANSWER_NOW_NOTE, buildMessages, extractCitedNumbers, stripToolCallText, toCitations } from "./prompt.js";
import { kbTools, parseTextToolCalls, runToolCall } from "./tools.js";

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
    const retriever = await getRetriever();

    yield { type: "status", message: "Searching the knowledge base…" };
    const searchQuery = await rewriteQuery(question, history, signal);
    timings.rewriteMs = Date.now() - t0;
    if (searchQuery !== question) yield { type: "status", message: `Search query: ${searchQuery}` };

    const t1 = Date.now();
    const chunks = await retriever.retrieve(searchQuery, { topK: req.topK, filters: req.filters });
    timings.retrieveMs = Date.now() - t1;
    let citations = toCitations(chunks);
    yield { type: "sources", citations };

    if (!chunks.length) {
      const msg = "I could not find anything relevant in the knowledge base for this question.";
      yield { type: "token", text: msg };
      yield { type: "done", answer: msg, thinking: "", usedCitations: [], timings };
      return;
    }

    const think = req.think ?? config.chat.think;
    const useTools = req.tools ?? (await toolsAvailable());
    const tools = useTools ? kbTools() : undefined;
    yield { type: "status", message: `Answering with ${config.chat.model}…` };
    const messages = buildMessages(history, question, chunks, { tools: tools?.map((t) => t.function.name) });
    // Same system message minus the tool instructions, swapped in on the last round: a prompt that
    // still invites a call while the request carries no tools gets the model's raw `<tool_call>`
    // text in the answer, since Ollama only parses tool syntax when tools are in the request.
    const finalSystem = tools ? buildMessages([], question, chunks, { toolsExhausted: true })[0]! : undefined;

    const t2 = Date.now();
    let answer = "";
    let thinking = "";
    let toolChars = 0;
    let toolCalls = 0;
    let searches = 0;
    const fetched = new Map<string, number>();
    const searched = new Map<string, number[]>();

    // Tool loop: the model may search again (search) or read whole documents (fetch_document) before
    // answering. The last round is always run without tools, so a model that keeps calling still
    // produces an answer.
    let forceAnswer = false;
    let nudged = false;
    for (let round = 0; ; round++) {
      const budgetLeft = config.tools.charBudget - toolChars;
      const lastRound = forceAnswer || !tools || round >= config.tools.maxRounds || budgetLeft < MIN_TOOL_RESULT_CHARS;
      if (lastRound && finalSystem) messages[0] = finalSystem;
      const calls: ToolCall[] = [];
      let turnText = "";
      let buffered = "";
      let flushed = false;
      let leaked = false;

      for await (const delta of getChatProvider().stream(messages, { signal, think, tools: lastRound ? undefined : tools })) {
        if (delta.thinking) {
          thinking += delta.thinking;
          yield { type: "thinking", text: delta.thinking };
        }
        if (delta.toolCalls?.length) calls.push(...delta.toolCalls);
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
        const budget = Math.max(0, config.tools.charBudget - toolChars);
        const outcome = await runToolCall(call, {
          store,
          searcher: retriever,
          filters: req.filters,
          citations,
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
    yield { type: "done", answer, thinking, usedCitations: extractCitedNumbers(answer, citations.length), timings };
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
  const tools: ToolTrace[] = [];
  for await (const ev of ask(req)) {
    if (ev.type === "sources") citations = ev.citations;
    else if (ev.type === "tool") tools.push({ name: ev.name, args: ev.args, summary: ev.summary, ok: ev.ok, ...(ev.citations ? { citations: ev.citations } : {}) });
    else if (ev.type === "done") ({ answer, thinking, usedCitations, timings } = ev);
    else if (ev.type === "error") throw new Error(ev.message);
  }
  return { answer, thinking, citations, usedCitations, timings, tools };
}
