import { config } from "../config.js";
import { getChatProvider } from "../llm/chat.js";
import { modelSupportsTools } from "../llm/ollama.js";
import { getDocumentStore } from "../retrieval/documents.js";
import { Retriever } from "../retrieval/retriever.js";
import type { AskEvent, AskRequest, ChatMessage, Citation, ToolCall } from "../types.js";
import { buildMessages, extractCitedNumbers, toCitations } from "./prompt.js";
import { kbTools, runToolCall } from "./tools.js";

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
    const messages = buildMessages(history, question, chunks, { tools: useTools });

    const t2 = Date.now();
    let answer = "";
    let thinking = "";
    let toolChars = 0;
    let toolCalls = 0;
    const fetched = new Map<string, number>();

    // Tool loop: the model may read whole documents (fetch_document) before answering. The last
    // round is always run without tools, so a model that keeps calling still produces an answer.
    for (let round = 0; ; round++) {
      const lastRound = !tools || round >= config.tools.maxRounds || toolChars >= config.tools.charBudget;
      const calls: ToolCall[] = [];
      let turnText = "";
      let buffered = "";
      let flushed = false;

      for await (const delta of getChatProvider().stream(messages, { signal, think, tools: lastRound ? undefined : tools })) {
        if (delta.thinking) {
          thinking += delta.thinking;
          yield { type: "thinking", text: delta.thinking };
        }
        if (delta.toolCalls?.length) calls.push(...delta.toolCalls);
        if (delta.content) {
          turnText += delta.content;
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

      if (!calls.length) {
        if (!flushed && buffered) yield { type: "token", text: buffered };
        answer += turnText;
        break;
      }

      if (flushed) answer += turnText; // already shown to the user, so it is part of the answer
      // Every declared call must get a result back, so drop the extras before echoing the turn.
      const accepted = calls.slice(0, MAX_CALLS_PER_ROUND);
      messages.push({ role: "assistant", content: turnText, tool_calls: accepted });

      yield { type: "status", message: "Reading the knowledge base…" };
      const store = await getDocumentStore();
      for (const call of accepted) {
        const budget = Math.max(0, config.tools.charBudget - toolChars);
        const outcome = await runToolCall(call, {
          store,
          citations,
          fetched,
          maxChars: Math.min(config.tools.docMaxChars, budget),
        });
        messages.push(outcome.message);
        toolChars += outcome.message.content.length;
        toolCalls += 1;
        if (outcome.newCitation) {
          citations = [...citations, outcome.newCitation];
          yield { type: "sources", citations };
        }
        yield {
          type: "tool",
          name: call.function.name,
          args: call.function.arguments,
          summary: outcome.summary,
          ok: outcome.ok,
          ...(outcome.citationNumber ? { citation: outcome.citationNumber } : {}),
        };
      }
      yield { type: "status", message: `Answering with ${config.chat.model}…` };
    }

    timings.generateMs = Date.now() - t2;
    timings.totalMs = Date.now() - t0;
    if (toolCalls) timings.toolCalls = toolCalls;
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
  citation?: number;
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
    else if (ev.type === "tool") tools.push({ name: ev.name, args: ev.args, summary: ev.summary, ok: ev.ok, ...(ev.citation ? { citation: ev.citation } : {}) });
    else if (ev.type === "done") ({ answer, thinking, usedCitations, timings } = ev);
    else if (ev.type === "error") throw new Error(ev.message);
  }
  return { answer, thinking, citations, usedCitations, timings, tools };
}
