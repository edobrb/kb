import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { config } from "../config.js";
import { ask, askOnce, getRetriever, resetRetriever } from "../generation/ask.js";
import { ingest } from "../ingest/pipeline.js";
import type { AskRequest, Authority, ChatMessage, RetrievalFilters } from "../types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const app = Fastify({ logger: { level: process.env["LOG_LEVEL"] ?? "info" } });
await app.register(cors, { origin: true });
await app.register(fastifyStatic, { root: path.join(here, "public"), prefix: "/" });

// ---- validation helpers ------------------------------------------------------

function parseMessages(body: unknown): ChatMessage[] {
  const b = body as { messages?: unknown; question?: unknown };
  if (typeof b?.question === "string") return [{ role: "user", content: b.question }];
  if (!Array.isArray(b?.messages) || !b.messages.length) throw new Error("Body must contain `question` or a non-empty `messages` array");
  return b.messages.map((m: unknown) => {
    const mm = m as { role?: unknown; content?: unknown };
    if (!["user", "assistant", "system"].includes(String(mm.role)) || typeof mm.content !== "string") {
      throw new Error("Each message needs role (user|assistant|system) and string content");
    }
    return { role: mm.role as ChatMessage["role"], content: mm.content };
  });
}

function parseFilters(body: unknown): RetrievalFilters | undefined {
  const f = (body as { filters?: Record<string, unknown> })?.filters;
  if (!f || typeof f !== "object") return undefined;
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : undefined);
  return {
    sourceTypes: list(f["sourceTypes"]),
    authorities: list(f["authorities"]) as Authority[] | undefined,
    langs: list(f["langs"]),
  };
}

function parseAskRequest(body: unknown): AskRequest {
  const topKRaw = (body as { topK?: unknown })?.topK;
  const topK = typeof topKRaw === "number" && topKRaw > 0 && topKRaw <= 20 ? Math.floor(topKRaw) : undefined;
  const thinkRaw = (body as { think?: unknown })?.think;
  const think = typeof thinkRaw === "boolean" ? thinkRaw : undefined;
  return { messages: parseMessages(body), filters: parseFilters(body), topK, think };
}

// ---- routes -------------------------------------------------------------------

app.get("/api/health", async () => {
  const r = await getRetriever();
  const stats = await r.stats();
  return {
    ok: true,
    embeddingModel: config.embedding.model,
    chatModel: config.chat.model,
    think: config.chat.think,
    ...stats,
  };
});

app.get("/api/facets", async () => (await getRetriever()).facets());

/** Retrieval only — useful for debugging and for other tools that bring their own LLM. */
app.post("/api/search", async (req, reply) => {
  try {
    const body = req.body as { query?: unknown; topK?: unknown };
    if (typeof body?.query !== "string" || !body.query.trim()) return reply.code(400).send({ error: "`query` is required" });
    const topK = typeof body.topK === "number" ? Math.min(50, Math.max(1, body.topK)) : 10;
    const r = await getRetriever();
    return { results: await r.retrieve(body.query, { topK, filters: parseFilters(body) }) };
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

/** Streaming answer as Server-Sent Events: status, sources, thinking, token, done, error. */
app.post("/api/ask", async (req, reply) => {
  let askReq: AskRequest;
  try {
    askReq = parseAskRequest(req.body);
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }

  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "access-control-allow-origin": "*",
  });
  reply.raw.flushHeaders?.();

  // Abort generation only when the *response* socket goes away. `req.raw`'s "close" fires as soon
  // as the request body has been read (Node >= 16), which would kill every answer instantly.
  const abort = new AbortController();
  reply.raw.on("close", () => {
    if (!reply.raw.writableFinished) abort.abort();
  });

  const send = (event: string, data: unknown) => {
    if (!reply.raw.writableEnded) reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  // Comment frames keep the connection alive through proxies during long retrieval/generation gaps.
  const heartbeat = setInterval(() => {
    if (!reply.raw.writableEnded) reply.raw.write(": ping\n\n");
  }, 15_000);

  try {
    for await (const ev of ask(askReq, abort.signal)) {
      send(ev.type, ev);
      if (ev.type === "done" || ev.type === "error") break;
    }
  } catch (err) {
    if (!abort.signal.aborted) send("error", { type: "error", message: (err as Error).message });
  } finally {
    clearInterval(heartbeat);
    if (!reply.raw.writableEnded) reply.raw.end();
  }
  return reply;
});

/** Non-streaming variant for simple integrations. */
app.post("/api/ask/sync", async (req, reply) => {
  try {
    return await askOnce(parseAskRequest(req.body));
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
});

/** Re-index the knowledge base (incremental). Guarded so two ingests never overlap. */
let ingestRunning = false;
app.post("/api/ingest", async (req, reply) => {
  if (ingestRunning) return reply.code(409).send({ error: "ingest already running" });
  ingestRunning = true;
  try {
    const body = (req.body ?? {}) as { reset?: boolean };
    const report = await ingest({ reset: Boolean(body.reset), log: (m) => app.log.info(m) });
    resetRetriever();
    return report;
  } catch (err) {
    return reply.code(500).send({ error: (err as Error).message });
  } finally {
    ingestRunning = false;
  }
});

// ---- start -------------------------------------------------------------------

try {
  await app.listen({ port: config.server.port, host: config.server.host });
  app.log.info(`Chat UI:  http://${config.server.host}:${config.server.port}/`);
  app.log.info(`API:      POST /api/ask (SSE) · POST /api/ask/sync · POST /api/search · GET /api/health`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
