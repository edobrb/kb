import { config } from "../config.js";
import type { ChatMessage } from "../types.js";

/**
 * Minimal Ollama HTTP client (no SDK dependency).
 * Docs: https://github.com/ollama/ollama/blob/main/docs/api.md
 */

export class OllamaError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "OllamaError";
  }
}

async function request<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${config.ollama.host}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw new OllamaError(
      `Cannot reach Ollama at ${config.ollama.host} (${(err as Error).message}). Is \`ollama serve\` running?`,
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OllamaError(`Ollama ${path} failed: ${res.status} ${res.statusText} ${text}`.trim(), res.status);
  }
  return (await res.json()) as T;
}

export async function listModels(): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${config.ollama.host}/api/tags`);
  } catch (err) {
    throw new OllamaError(`Cannot reach Ollama at ${config.ollama.host} (${(err as Error).message})`);
  }
  if (!res.ok) throw new OllamaError(`Ollama /api/tags failed: ${res.status}`);
  const data = (await res.json()) as { models?: { name: string }[] };
  return (data.models ?? []).map((m) => m.name);
}

interface EmbedResponse {
  embeddings: number[][];
}

/** Embed a batch of texts with /api/embed. Returns one vector per input, in order. */
export async function ollamaEmbed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  if (texts.length === 0) return [];
  const data = await request<EmbedResponse>(
    "/api/embed",
    {
      model: config.embedding.model,
      input: texts,
      truncate: true,
      keep_alive: "10m",
    },
    signal,
  );
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
    throw new OllamaError(`Ollama returned ${data.embeddings?.length ?? 0} embeddings for ${texts.length} inputs`);
  }
  return data.embeddings;
}

export interface ChatOptions {
  temperature?: number;
  numCtx?: number;
  think?: boolean;
  signal?: AbortSignal;
  /** Override the configured chat model for this call (e.g. a stronger model as eval judge). */
  model?: string;
  /** Cap on generated tokens (Ollama `num_predict`). */
  maxTokens?: number;
}

interface ChatStreamChunk {
  message?: { role: string; content?: string; thinking?: string };
  done?: boolean;
  error?: string;
}

/** One streamed piece of an assistant turn: either visible answer text or reasoning text. */
export interface ChatDelta {
  content?: string;
  /** Reasoning tokens, emitted by thinking models when `think` is enabled. */
  thinking?: string;
}

/** Stream an assistant turn from /api/chat as `content` / `thinking` deltas. */
export async function* ollamaChatStream(messages: ChatMessage[], opts: ChatOptions = {}): AsyncGenerator<ChatDelta> {
  let res: Response;
  try {
    res = await fetch(`${config.ollama.host}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: opts.model ?? config.chat.model,
        messages,
        stream: true,
        think: opts.think ?? config.chat.think,
        keep_alive: "10m",
        options: {
          temperature: opts.temperature ?? config.chat.temperature,
          num_ctx: opts.numCtx ?? config.chat.numCtx,
          ...(opts.maxTokens ? { num_predict: opts.maxTokens } : {}),
        },
      }),
      signal: opts.signal,
    });
  } catch (err) {
    throw new OllamaError(
      `Cannot reach Ollama at ${config.ollama.host} (${(err as Error).message}). Is \`ollama serve\` running?`,
    );
  }
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new OllamaError(`Ollama /api/chat failed: ${res.status} ${res.statusText} ${text}`.trim(), res.status);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const chunk = JSON.parse(line) as ChatStreamChunk;
        if (chunk.error) throw new OllamaError(chunk.error);
        const { content, thinking } = chunk.message ?? {};
        if (thinking) yield { thinking };
        if (content) yield { content };
        if (chunk.done) return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Non-streaming helper. Returns the visible answer only (reasoning is discarded). */
export async function ollamaChat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  let out = "";
  for await (const d of ollamaChatStream(messages, opts)) out += d.content ?? "";
  return out;
}
