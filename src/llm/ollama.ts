import { config } from "../config.js";
import type { ChatMessage, ToolCall } from "../types.js";

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

/** A function the model may call, in the JSON-schema shape Ollama and OpenAI both take. */
export interface ToolSpec {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
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
  /** Tools the model may call in this turn. Requires a model with tool support. */
  tools?: ToolSpec[];
}

interface ChatStreamChunk {
  message?: { role: string; content?: string; thinking?: string; tool_calls?: RawToolCall[] };
  done?: boolean;
  error?: string;
}

interface RawToolCall {
  function?: { name?: string; arguments?: unknown };
}

/** One streamed piece of an assistant turn: visible answer text, reasoning text, or tool calls. */
export interface ChatDelta {
  content?: string;
  /** Reasoning tokens, emitted by thinking models when `think` is enabled. */
  thinking?: string;
  /** Tool calls requested in this turn; the caller runs them and continues the conversation. */
  toolCalls?: ToolCall[];
}

/**
 * Ollama sends tool arguments as a JSON object, but some models emit them as a JSON string;
 * accept both so a tool call is never dropped over quoting.
 */
function normalizeToolCalls(raw: RawToolCall[]): ToolCall[] {
  return raw.flatMap((c) => {
    const name = c.function?.name;
    if (!name) return [];
    let args: Record<string, unknown> = {};
    const a = c.function?.arguments;
    if (typeof a === "string") {
      try {
        const parsed = JSON.parse(a);
        if (parsed && typeof parsed === "object") args = parsed as Record<string, unknown>;
      } catch {
        args = {};
      }
    } else if (a && typeof a === "object") {
      args = a as Record<string, unknown>;
    }
    return [{ function: { name, arguments: args } }];
  });
}

/** Model capabilities from /api/show ("tools", "thinking", "vision", ...), cached per model. */
const capabilityCache = new Map<string, Promise<string[]>>();
export function modelCapabilities(model = config.chat.model): Promise<string[]> {
  const cached = capabilityCache.get(model);
  if (cached) return cached;
  const p = request<{ capabilities?: string[] }>("/api/show", { model })
    .then((d) => d.capabilities ?? [])
    .catch(() => [] as string[]);
  capabilityCache.set(model, p);
  return p;
}

export async function modelSupportsTools(model = config.chat.model): Promise<boolean> {
  return (await modelCapabilities(model)).includes("tools");
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
        ...(opts.tools?.length ? { tools: opts.tools } : {}),
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
        const { content, thinking, tool_calls: toolCalls } = chunk.message ?? {};
        if (thinking) yield { thinking };
        if (content) yield { content };
        if (toolCalls?.length) {
          const calls = normalizeToolCalls(toolCalls);
          if (calls.length) yield { toolCalls: calls };
        }
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
