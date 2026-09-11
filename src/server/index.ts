import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { config, paths } from "../config.js";
import { ask, askOnce, getRetriever, resetRetriever, toolsAvailable } from "../generation/ask.js";
import { getGraph, resetGraph, type Relation } from "../graph/index.js";
import { ingest } from "../ingest/pipeline.js";
import { DocumentNotFoundError, getDocumentStore, resetDocumentStore } from "../retrieval/documents.js";
import type { AskMode, AskRequest, Authority, Citation, CarriedBlock, ChatMessage, RetrievalFilters } from "../types.js";
import { type BundleRequest, buildBundle } from "./bundle.js";

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

/**
 * Blocks the client says this chat already gathered, from the previous turn's `sources` event. They
 * are what lets a follow-up continue on that context instead of re-querying the knowledge base;
 * only ids are trusted — the passages themselves are re-read server-side (see `carriedBlocks`).
 */
function parseContext(body: unknown): CarriedBlock[] | undefined {
  const raw = (body as { context?: unknown })?.context;
  if (!Array.isArray(raw)) return undefined;
  const blocks = raw.flatMap((b: unknown) => {
    const bb = b as { n?: unknown; chunkId?: unknown; chunk_id?: unknown; section?: unknown; cited?: unknown };
    const chunkId = typeof bb.chunkId === "string" ? bb.chunkId : typeof bb.chunk_id === "string" ? bb.chunk_id : "";
    const n = typeof bb.n === "number" && Number.isInteger(bb.n) && bb.n > 0 ? bb.n : 0;
    if (!chunkId || !n) return [];
    return [{ n, chunkId, section: typeof bb.section === "string" ? bb.section : null, cited: Boolean(bb.cited) }];
  });
  return blocks.length ? blocks.slice(0, 200) : undefined;
}

function parseFilters(body: unknown): RetrievalFilters | undefined {
  const f = (body as { filters?: Record<string, unknown> })?.filters;
  if (!f || typeof f !== "object") return undefined;
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : undefined);
  return {
    sourceTypes: list(f["sourceTypes"]),
    kinds: list(f["kinds"]),
    authorities: list(f["authorities"]) as Authority[] | undefined,
    langs: list(f["langs"]),
  };
}

function parseAskRequest(body: unknown): AskRequest {
  const topKRaw = (body as { topK?: unknown })?.topK;
  const topK = typeof topKRaw === "number" && topKRaw > 0 && topKRaw <= 20 ? Math.floor(topKRaw) : undefined;
  const thinkRaw = (body as { think?: unknown })?.think;
  const think = typeof thinkRaw === "boolean" ? thinkRaw : undefined;
  const toolsRaw = (body as { tools?: unknown })?.tools;
  const tools = typeof toolsRaw === "boolean" ? toolsRaw : undefined;
  const modeRaw = (body as { mode?: unknown })?.mode;
  const mode: AskMode | undefined = modeRaw === "research" || modeRaw === "fast" ? modeRaw : undefined;
  return { messages: parseMessages(body), context: parseContext(body), filters: parseFilters(body), topK, think, tools, mode };
}

/**
 * One answer plus the citations the client holds, for `/api/export/bundle`. Only the source ids are
 * acted on — the documents themselves are re-read from `kb/`, so a stale excerpt in the browser
 * cannot end up in the bundle.
 */
function parseBundleRequest(body: unknown): BundleRequest {
  const b = (body ?? {}) as { question?: unknown; answer?: unknown; thinking?: unknown; citations?: unknown; usedCitations?: unknown; used_citations?: unknown; maxChars?: unknown };
  if (typeof b.question !== "string" || !b.question.trim()) throw new Error("`question` is required");
  if (!Array.isArray(b.citations)) throw new Error("`citations` (array) is required");
  const str = (v: unknown, fallback = "") => (typeof v === "string" ? v : fallback);
  const int = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : null);
  const citations: Citation[] = b.citations.flatMap((c: unknown, i: number) => {
    const cc = (c ?? {}) as Record<string, unknown>;
    const sourceId = str(cc["sourceId"]) || str(cc["source_id"]) || str(cc["relPath"]);
    if (!sourceId) return [];
    const n = int(cc["n"]);
    return [{
      n: n && n > 0 ? n : i + 1,
      chunkId: str(cc["chunkId"]) || str(cc["chunk_id"]),
      sourceId,
      title: str(cc["title"], sourceId),
      sourceUrl: str(cc["sourceUrl"]) || str(cc["source_url"]) || null,
      sourceType: str(cc["sourceType"]) || str(cc["source_type"]),
      kind: str(cc["kind"]),
      authority: str(cc["authority"]),
      headingPath: str(cc["headingPath"]) || str(cc["heading_path"]),
      relPath: str(cc["relPath"]) || str(cc["rel_path"]),
      excerpt: str(cc["excerpt"]),
      lineStart: int(cc["lineStart"] ?? cc["line_start"]),
      lineEnd: int(cc["lineEnd"] ?? cc["line_end"]),
      score: typeof cc["score"] === "number" ? cc["score"] : 0,
    }];
  });
  if (!citations.length) throw new Error("no citation carried a `sourceId`, so there is nothing to bundle");
  const usedRaw = Array.isArray(b.usedCitations) ? b.usedCitations : Array.isArray(b.used_citations) ? b.used_citations : [];
  const maxChars = int(b.maxChars);
  return {
    question: b.question,
    answer: str(b.answer),
    thinking: str(b.thinking),
    citations: citations.slice(0, 400),
    usedCitations: usedRaw.map((n) => int(n)).filter((n): n is number => n !== null && n > 0),
    ...(maxChars && maxChars > 0 ? { maxChars } : {}),
  };
}

// ---- routes -------------------------------------------------------------------

app.get("/api/health", async () => {
  const r = await getRetriever();
  const stats = await r.stats();
  const graph = config.graph.enabled ? await getGraph() : null;
  return {
    ok: true,
    embeddingModel: config.embedding.model,
    chatModel: config.chat.model,
    /** Context window the chat model runs with; the UI shows saturation against it. */
    numCtx: config.chat.numCtx,
    think: config.chat.think,
    tools: await toolsAvailable(),
    documents: (await getDocumentStore()).size,
    /** Knowledge graph, when it has been built (see src/graph). */
    graph: graph
      ? { nodes: graph.nodeCount, edges: graph.edgeCount, docs: graph.docCount, brokenLinks: graph.stats.brokenLinksTotal, generatedAt: graph.generatedAt }
      : null,
    ...stats,
  };
});

app.get("/api/facets", async () => (await getRetriever()).facets());

/**
 * Whole kb document by source_id — what the `fetch_document` tool reads, exposed so the UI (and
 * anything else holding a citation) can show the full page behind a passage.
 */
app.post("/api/document", async (req, reply) => {
  try {
    const body = (req.body ?? {}) as { sourceId?: unknown; source_id?: unknown; section?: unknown; maxChars?: unknown };
    const sourceId = typeof body.sourceId === "string" ? body.sourceId : typeof body.source_id === "string" ? body.source_id : "";
    if (!sourceId.trim()) return reply.code(400).send({ error: "`sourceId` is required" });
    const store = await getDocumentStore();
    const maxChars = typeof body.maxChars === "number" ? Math.min(200_000, Math.max(500, body.maxChars)) : undefined;
    return await store.fetch(sourceId, {
      section: typeof body.section === "string" ? body.section : null,
      ...(maxChars ? { maxChars } : {}),
    });
  } catch (err) {
    if (err instanceof DocumentNotFoundError) {
      return reply.code(404).send({ error: err.message, suggestions: err.suggestions });
    }
    return reply.code(500).send({ error: (err as Error).message });
  }
});

/**
 * Citations as a *knowledge bundle*: a zip with the answer and the full markdown of every document
 * behind it. What `Export .md` cannot do — its links only work for a reader inside the company —
 * so an answer can be handed to an external model, or kept as what it was really based on.
 */
app.post("/api/export/bundle", async (req, reply) => {
  let bundleReq: BundleRequest;
  try {
    bundleReq = parseBundleRequest(req.body);
  } catch (err) {
    return reply.code(400).send({ error: (err as Error).message });
  }
  try {
    const bundle = await buildBundle(bundleReq, await getDocumentStore());
    app.log.info(
      `bundle: ${bundle.report.documents} docs, ${(bundle.report.bytes / 1024).toFixed(0)} KiB` +
        (bundle.report.missing.length ? `, ${bundle.report.missing.length} missing` : "") +
        (bundle.report.skipped ? `, ${bundle.report.skipped} over the document cap` : ""),
    );
    return reply
      .type("application/zip")
      // RFC 5987 form as well: the filename carries the question, which is rarely pure ASCII.
      .header(
        "content-disposition",
        `attachment; filename="${bundle.filename.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(bundle.filename)}`,
      )
      .header("x-bundle-documents", String(bundle.report.documents))
      .header("x-bundle-missing", String(bundle.report.missing.length))
      .header("access-control-expose-headers", "content-disposition, x-bundle-documents, x-bundle-missing")
      .send(bundle.zip);
  } catch (err) {
    return reply.code(500).send({ error: (err as Error).message });
  }
});

/**
 * 2-D UMAP projection of the whole index, built offline by `npm run map`; rendered by /map.html.
 * Stored gzipped and passed through as-is, so the browser decompresses it instead of the payload
 * growing unbounded with the knowledge base.
 */
app.get("/api/map", async (_req, reply) => {
  try {
    const gz = await readFile(paths.kbMap);
    return reply.header("content-encoding", "gzip").header("cache-control", "no-cache").type("application/json; charset=utf-8").send(gz);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return reply.code(404).send({ error: `No map yet at ${paths.kbMap} — run \`npm run map\` after ingest.` });
    }
    return reply.code(500).send({ error: (err as Error).message });
  }
});

/**
 * Document-to-document edges of the knowledge graph, for the map overlay. Hub edges ("same
 * repository") are left out on purpose: drawing them would mean a line between every pair of
 * documents in a repository. Built once per process — the file only changes on an ingest.
 */
let edgePayload: { body: string; generatedAt: string } | null = null;
app.get("/api/graph", async (_req, reply) => {
  const graph = await getGraph();
  if (!graph) {
    return reply.code(404).send({ error: `No graph yet at ${paths.graph} — run \`npm run graph\` (or \`npm run ingest\`).` });
  }
  if (!edgePayload || edgePayload.generatedAt !== graph.generatedAt) {
    const payload = graph.docEdgesPayload();
    edgePayload = {
      generatedAt: graph.generatedAt,
      body: JSON.stringify({ version: 1, generatedAt: graph.generatedAt, docs: graph.docCount, stats: graph.stats, ...payload }),
    };
  }
  return reply.header("cache-control", "no-cache").type("application/json; charset=utf-8").send(edgePayload.body);
});

/** What one document is connected to: direct edges, hub siblings, and the hubs themselves. */
app.post("/api/graph/neighbors", async (req, reply) => {
  const graph = await getGraph();
  if (!graph) return reply.code(404).send({ error: "No graph yet — run `npm run graph`." });
  const body = (req.body ?? {}) as { sourceId?: unknown; source_id?: unknown; limit?: unknown; relations?: unknown };
  const sourceId = typeof body.sourceId === "string" ? body.sourceId : typeof body.source_id === "string" ? body.source_id : "";
  if (!sourceId.trim()) return reply.code(400).send({ error: "`sourceId` is required" });
  const node = graph.node(sourceId);
  if (!node) return reply.code(404).send({ error: `"${sourceId}" is not in the graph` });
  const limit = typeof body.limit === "number" ? Math.min(200, Math.max(1, body.limit)) : 40;
  const relations = Array.isArray(body.relations) ? (body.relations.map(String) as Relation[]) : undefined;
  return {
    node,
    hubs: graph.hubsOf(sourceId),
    neighbors: graph.neighbors(sourceId, { limit, ...(relations?.length ? { relations } : {}) }),
  };
});

/** Chunk text by id, so the map payload can stay metadata-only and load passages on demand. */
app.post("/api/chunk", async (req, reply) => {
  try {
    const body = req.body as { id?: unknown; ids?: unknown };
    const ids = Array.isArray(body?.ids) ? body.ids.map(String) : typeof body?.id === "string" ? [body.id] : [];
    if (!ids.length) return reply.code(400).send({ error: "`id` (string) or `ids` (array) is required" });
    if (ids.length > 50) return reply.code(400).send({ error: "at most 50 ids per request" });
    const chunks = await (await getRetriever()).chunksByIds(ids);
    return { chunks };
  } catch (err) {
    return reply.code(500).send({ error: (err as Error).message });
  }
});

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
    resetDocumentStore();
    // The ingest rebuilt the graph on disk; drop the cached one (and the map's edge payload) so the
    // next `related` call and the next map reload see it.
    resetGraph();
    edgePayload = null;
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
  app.log.info(`Map:      http://${config.server.host}:${config.server.port}/map.html (after \`npm run map\`)`);
  app.log.info(`Arch:     http://${config.server.host}:${config.server.port}/architecture.html`);
  app.log.info(`API:      POST /api/ask (SSE) · POST /api/ask/sync · POST /api/search · POST /api/document · GET /api/map · GET /api/graph · POST /api/graph/neighbors · POST /api/chunk · POST /api/export/bundle · GET /api/health`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
