import { config } from "../config.js";
import type { ChatMessage } from "../types.js";
import { ollamaChatStream, type ChatDelta, type ChatOptions } from "./ollama.js";

export type { ChatDelta } from "./ollama.js";

export interface ChatProvider {
  /** Stream an assistant turn as `content` / `thinking` deltas. */
  stream(messages: ChatMessage[], opts?: ChatOptions): AsyncGenerator<ChatDelta>;
  /** Run `stream` to completion and return the visible answer (reasoning discarded). */
  complete(messages: ChatMessage[], opts?: ChatOptions): Promise<string>;
}

class OllamaChatProvider implements ChatProvider {
  stream(messages: ChatMessage[], opts?: ChatOptions): AsyncGenerator<ChatDelta> {
    return ollamaChatStream(messages, opts);
  }
  async complete(messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
    let out = "";
    for await (const d of this.stream(messages, opts)) out += d.content ?? "";
    return out;
  }
}

/** `FETCH:<source_id>` in a mock question makes the mock model ask for that document once. */
const MOCK_FETCH_RE = /FETCH:(\S+)/;
/** `SEARCH:<query>` (underscores for spaces) makes the mock model run that search once. */
const MOCK_SEARCH_RE = /SEARCH:(\S+)/;

/**
 * Mock chat model for tests: echoes which context blocks it received and cites all of them.
 * Lets the pipeline (prompting, citation parsing, SSE streaming) be exercised without Ollama.
 * With `think: true` it also emits a short fake reasoning stream, and a question containing
 * `FETCH:<source_id>` or `SEARCH:<query>` exercises the tool loop.
 */
export class MockChatProvider implements ChatProvider {
  async *stream(messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<ChatDelta> {
    const user = messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const ids = [...system.matchAll(/^\[(\d+)\]/gm)].map((m) => m[1]);
    const question = user.split("\n").at(-1) ?? user;

    // Tool round: run the requested search / read the requested document, but only until a tool
    // result comes back.
    const wanted = MOCK_FETCH_RE.exec(question)?.[1];
    const wantedSearch = MOCK_SEARCH_RE.exec(question)?.[1];
    if (opts.tools?.length && !messages.some((m) => m.role === "tool")) {
      if (wantedSearch) {
        yield { toolCalls: [{ function: { name: "search", arguments: { query: wantedSearch.replace(/_/g, " ") } } }] };
        return;
      }
      if (wanted) {
        yield { toolCalls: [{ function: { name: "fetch_document", arguments: { source_id: wanted } } }] };
        return;
      }
    }
    const toolBlocks = messages
      .filter((m) => m.role === "tool")
      .flatMap((m) => [...m.content.matchAll(/^\[(\d+)\]/gm)].map((x) => x[1] as string));
    if (opts.think) {
      for (const word of `(mock reasoning) Looking at ${ids.length} context blocks. `.split(/(?<=\s)/)) {
        yield { thinking: word };
      }
    }
    const seen = [...ids, ...toolBlocks];
    const text =
      `(mock answer) Question: "${question.trim()}". Context blocks seen: ${seen.length}. ` +
      `${[...new Set(seen)].map((i) => `[${i}]`).join(" ")}`;
    for (const word of text.split(/(?<=\s)/)) {
      yield { content: word };
    }
  }
  async complete(messages: ChatMessage[], opts?: ChatOptions): Promise<string> {
    let out = "";
    for await (const d of this.stream(messages, opts)) out += d.content ?? "";
    return out;
  }
}

let cached: ChatProvider | null = null;
export function getChatProvider(): ChatProvider {
  if (cached) return cached;
  cached = config.chat.provider === "mock" ? new MockChatProvider() : new OllamaChatProvider();
  return cached;
}
