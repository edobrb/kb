import { config } from "../config.js";
import { getChatProvider } from "../llm/chat.js";
import { Retriever } from "../retrieval/retriever.js";
import type { AskEvent, AskRequest, ChatMessage, Citation } from "../types.js";
import { buildMessages, extractCitedNumbers, toCitations } from "./prompt.js";

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

/**
 * The full RAG loop as an async stream of events, shared by the CLI and the SSE endpoint:
 * status -> sources -> token* -> done   (or error)
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
    const citations = toCitations(chunks);
    yield { type: "sources", citations };

    if (!chunks.length) {
      const msg = "I could not find anything relevant in the knowledge base for this question.";
      yield { type: "token", text: msg };
      yield { type: "done", answer: msg, thinking: "", usedCitations: [], timings };
      return;
    }

    const think = req.think ?? config.chat.think;
    yield { type: "status", message: `Answering with ${config.chat.model}…` };
    const messages = buildMessages(history, question, chunks);
    const t2 = Date.now();
    let answer = "";
    let thinking = "";
    for await (const delta of getChatProvider().stream(messages, { signal, think })) {
      if (delta.thinking) {
        thinking += delta.thinking;
        yield { type: "thinking", text: delta.thinking };
      }
      if (delta.content) {
        answer += delta.content;
        yield { type: "token", text: delta.content };
      }
    }
    timings.generateMs = Date.now() - t2;
    timings.totalMs = Date.now() - t0;
    yield { type: "done", answer, thinking, usedCitations: extractCitedNumbers(answer, citations.length), timings };
  } catch (err) {
    if (signal?.aborted) return;
    yield { type: "error", message: (err as Error).message };
  }
}

/** Convenience: run `ask` to completion and return the final answer + citations. */
export async function askOnce(req: AskRequest) {
  let answer = "";
  let thinking = "";
  let citations: Citation[] = [];
  let usedCitations: number[] = [];
  let timings: Record<string, number> = {};
  for await (const ev of ask(req)) {
    if (ev.type === "sources") citations = ev.citations;
    else if (ev.type === "done") ({ answer, thinking, usedCitations, timings } = ev);
    else if (ev.type === "error") throw new Error(ev.message);
  }
  return { answer, thinking, citations, usedCitations, timings };
}
