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

/**
 * Mock chat model for tests: echoes which context blocks it received and cites all of them.
 * Lets the pipeline (prompting, citation parsing, SSE streaming) be exercised without Ollama.
 * With `think: true` it also emits a short fake reasoning stream.
 */
export class MockChatProvider implements ChatProvider {
  async *stream(messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<ChatDelta> {
    const user = messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const ids = [...system.matchAll(/^\[(\d+)\]/gm)].map((m) => m[1]);
    const question = user.split("\n").at(-1) ?? user;
    if (opts.think) {
      for (const word of `(mock reasoning) Looking at ${ids.length} context blocks. `.split(/(?<=\s)/)) {
        yield { thinking: word };
      }
    }
    const text = `(mock answer) Question: "${question.trim()}". Context blocks seen: ${ids.length}. ${ids
      .map((i) => `[${i}]`)
      .join(" ")}`;
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
