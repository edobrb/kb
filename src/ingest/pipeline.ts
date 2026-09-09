import { stat } from "node:fs/promises";
import { config, paths } from "../config.js";
import { getEmbedder } from "../llm/embeddings.js";
import { Bm25Index } from "../store/bm25.js";
import { VectorStore } from "../store/vector-store.js";
import type { Chunk, DocKind, Document, StoredChunk } from "../types.js";
import { chunkDocument, composeChunkText } from "./chunker.js";
import { buildBackground, createContextualizer, ProjectCards, type Contextualizer } from "./contextualize.js";
import { listMarkdownFiles, loadDocument } from "./loader.js";
import { emptyManifest, manifestIncompatible, readManifest, writeManifest, type Manifest } from "./manifest.js";
import { RateTracker, type IngestProgress } from "./progress.js";

export interface IngestOptions {
  kbDir?: string;
  /** Drop the existing index and rebuild everything. */
  reset?: boolean;
  /** Only parse + chunk, print stats, do not embed or write. */
  dryRun?: boolean;
  /** Restrict to files whose relative path contains this substring (handy for debugging). */
  only?: string;
  log?: (msg: string) => void;
  /** Called after each document is processed, and once per phase change. Used to render progress/ETA. */
  onProgress?: (p: IngestProgress) => void;
  /** Override for tests; defaults to the configured one. */
  contextualizer?: Contextualizer;
}

export interface IngestReport {
  filesSeen: number;
  docsUnchanged: number;
  docsAdded: number;
  docsUpdated: number;
  docsRemoved: number;
  chunksWritten: number;
  totalChunks: number;
  /** Contextual-retrieval bookkeeping. */
  contextsGenerated: number;
  contextsCached: number;
  contextFailures: number;
  /** Chunks a batched call skipped or truncated and that were re-asked one by one. */
  contextRetries: number;
  /** Model calls made; well below `contextsGenerated` because one call situates a group of chunks. */
  contextCalls: number;
  durationMs: number;
}

function toStored(doc: Document, chunk: Chunk, vector: number[]): StoredChunk {
  return {
    id: chunk.id,
    source_id: doc.meta.sourceId,
    source_type: doc.meta.sourceType,
    kind: doc.meta.kind,
    title: doc.meta.title,
    source_url: doc.meta.sourceUrl ?? "",
    authority: doc.meta.authority,
    lang: doc.meta.lang,
    last_modified: doc.meta.lastModified ?? "",
    rel_path: doc.meta.relPath,
    ordinal: chunk.ordinal,
    heading_path: chunk.headingPath,
    context: chunk.context,
    content: chunk.content,
    text: chunk.text,
    line_start: chunk.lineStart ?? -1,
    line_end: chunk.lineEnd ?? -1,
    vector,
  };
}

/** Project cards first (they are the background of everything else), then prose, then code. */
const KIND_ORDER: Record<DocKind, number> = { project: 0, doc: 1, api: 2, code: 3 };

interface Work {
  doc: Document;
  chunks: Chunk[];
}

export async function ingest(opts: IngestOptions = {}): Promise<IngestReport> {
  const started = Date.now();
  const log = opts.log ?? (() => {});
  const kbDir = opts.kbDir ?? config.kbDir;

  try {
    if (!(await stat(kbDir)).isDirectory()) throw new Error();
  } catch {
    throw new Error(`Knowledge base folder not found: ${kbDir} (set KB_DIR in .env)`);
  }

  const embedder = getEmbedder();
  const contextualized = config.context.enabled;
  const wanted = {
    embeddingModel: `${config.embedding.provider}:${config.embedding.model}`,
    embeddingDimensions: embedder.dimensions,
    chunking: { targetTokens: config.chunking.targetTokens, maxTokens: config.chunking.maxTokens, overlapTokens: config.chunking.overlapTokens, code: { ...config.chunking.code } },
    contextualized,
  };

  const store = await VectorStore.open(paths.lanceDb, embedder.dimensions);
  let manifest: Manifest | null = opts.reset ? null : await readManifest(paths.manifest);
  if (manifest) {
    const reason = manifestIncompatible(manifest, wanted);
    if (reason) {
      log(`Existing index is incompatible (${reason}); rebuilding from scratch.`);
      manifest = null;
    }
  }
  if (!manifest) {
    if (!opts.dryRun) await store.reset();
    manifest = emptyManifest(wanted);
  }

  // 1. Discover files and decide what changed.
  let files = await listMarkdownFiles(kbDir);
  if (opts.only) files = files.filter((f) => f.includes(opts.only as string));
  log(`Found ${files.length} markdown files in ${kbDir}`);

  const seenSourceIds = new Set<string>();
  const toIndex: Document[] = [];
  const cards = new ProjectCards(kbDir);
  let unchanged = 0;
  let added = 0;
  let updated = 0;

  for (const rel of files) {
    const doc = await loadDocument(kbDir, rel);
    if (seenSourceIds.has(doc.meta.sourceId)) {
      log(`  ! duplicate source_id ${doc.meta.sourceId} in ${rel}; skipping`);
      continue;
    }
    seenSourceIds.add(doc.meta.sourceId);
    if (doc.meta.kind === "project" && typeof doc.frontmatter["project"] === "string") cards.set(doc.frontmatter["project"], doc.body);
    const prev = manifest.docs[doc.meta.sourceId];
    if (prev && prev.contentHash === doc.meta.contentHash) {
      unchanged++;
      continue;
    }
    if (prev) updated++;
    else added++;
    toIndex.push(doc);
  }

  const removedIds = opts.only ? [] : Object.keys(manifest.docs).filter((id) => !seenSourceIds.has(id));
  log(`Unchanged: ${unchanged}, new: ${added}, changed: ${updated}, removed: ${removedIds.length}`);

  // 2. Chunk. Cards first so they are on disk/in memory when the code that references them is contextualized.
  toIndex.sort((a, b) => KIND_ORDER[a.meta.kind] - KIND_ORDER[b.meta.kind] || a.meta.relPath.localeCompare(b.meta.relPath));
  const work: Work[] = toIndex.map((doc) => ({ doc, chunks: chunkDocument(doc, config.chunking) }));
  const chunkTotal = work.reduce((n, w) => n + w.chunks.length, 0);
  if (work.length) {
    const sizes = work.flatMap((w) => w.chunks.map((c) => c.tokenEstimate));
    const { sum, max } = sizes.reduce((acc, n) => ({ sum: acc.sum + n, max: n > acc.max ? n : acc.max }), { sum: 0, max: 0 });
    const avg = sizes.length ? Math.round(sum / sizes.length) : 0;
    const byKind = work.reduce<Record<string, number>>((acc, w) => ((acc[w.doc.meta.kind] = (acc[w.doc.meta.kind] ?? 0) + w.chunks.length), acc), {});
    log(`Chunked ${work.length} docs into ${chunkTotal} chunks (avg ~${avg} tokens, max ${max}; ${Object.entries(byKind).map(([k, n]) => `${k}=${n}`).join(", ")})`);
  }

  const contextualizer = contextualized ? (opts.contextualizer ?? createContextualizer(paths.contexts)) : null;
  const report: IngestReport = {
    filesSeen: files.length,
    docsUnchanged: unchanged,
    docsAdded: added,
    docsUpdated: updated,
    docsRemoved: removedIds.length,
    chunksWritten: 0,
    totalChunks: 0,
    contextsGenerated: 0,
    contextsCached: 0,
    contextFailures: 0,
    contextRetries: 0,
    contextCalls: 0,
    durationMs: 0,
  };

  if (opts.dryRun) {
    for (const w of work.slice(0, 3)) {
      log(`\n--- ${w.doc.meta.relPath} (${w.doc.meta.kind}, ${w.chunks.length} chunks)`);
      for (const c of w.chunks.slice(0, 2)) log(`[${c.ordinal}] ${c.headingPath}${c.lineStart ? ` L${c.lineStart}-${c.lineEnd}` : ""} (${c.tokenEstimate} tok)\n${c.content.slice(0, 300)}...\n`);
    }
    if (contextualizer) {
      const llmChunks = work.filter((w) => contextualizer.usesModel(w.doc, w.chunks.length)).reduce((n, w) => n + w.chunks.length, 0);
      log(`Contextual retrieval: ${llmChunks} of ${chunkTotal} chunks would be sent to ${config.context.model} (the rest get a deterministic context)`);
    }
    report.totalChunks = await store.count();
    report.durationMs = Date.now() - started;
    return report;
  }

  // 3. Remove stale/changed docs from the vector store.
  const staleIds = [...removedIds, ...toIndex.filter((d) => manifest.docs[d.meta.sourceId]).map((d) => d.meta.sourceId)];
  if (staleIds.length) {
    await store.deleteBySourceIds(staleIds);
    for (const id of removedIds) delete manifest.docs[id];
  }

  // 4. Contextualize + embed + write, in batches of documents.
  //
  // The manifest records what is already indexed, so it must reach disk regularly: a crash then only
  // costs the documents written since the last flush (contexts are cached separately, so even those are
  // cheap to redo). Writing it after *every* document would be O(n²) at this scale, hence the time-based flush.
  const MANIFEST_FLUSH_MS = 5_000;
  let lastManifestWrite = Date.now();
  const flushManifest = async (force = false) => {
    if (!force && Date.now() - lastManifestWrite < MANIFEST_FLUSH_MS) return;
    await writeManifest(paths.manifest, manifest);
    lastManifestWrite = Date.now();
  };

  let written = 0;
  let embedded = 0;
  let contextualizedChunks = 0;
  let docsDone = 0;
  const phaseStarted = Date.now();
  // One wall-clock tracker over chunks that completed BOTH phases: the phases alternate per batch, so a
  // per-phase rate would over- or under-state the real throughput. The window spans several batches for the
  // same reason — a short one would only ever see a contextualizing lull or an embedding burst.
  const overall = new RateTracker(30 * 60_000);
  overall.add(0, phaseStarted);
  const now = new Date().toISOString();

  const progress = (phase: IngestProgress["phase"], chunksDone: number, currentPath: string) => {
    const t = Date.now();
    overall.add(embedded, t);
    opts.onProgress?.({
      phase,
      docsDone,
      docsTotal: work.length,
      chunksDone,
      chunksTotal: chunkTotal,
      elapsedMs: t - phaseStarted,
      chunksPerSec: overall.perSecond(),
      etaMs: overall.etaMs(chunkTotal - embedded),
      currentPath,
    });
  };

  if (chunkTotal) {
    const model = config.embedding.provider === "ollama" ? config.embedding.model : `${config.embedding.provider}:${config.embedding.model}`;
    const llmChunks = contextualizer ? work.filter((w) => contextualizer.usesModel(w.doc, w.chunks.length)).reduce((n, w) => n + w.chunks.length, 0) : 0;
    log(
      `Indexing ${chunkTotal.toLocaleString("en-US")} chunks from ${work.length.toLocaleString("en-US")} documents: ` +
        (contextualizer ? `contexts for ${llmChunks.toLocaleString("en-US")} chunks with ${config.context.model}, ` : "") +
        `embeddings with ${model}`,
    );
  }

  const processBatch = async (batch: Work[]) => {
    // Phase A: contexts. One call per group of chunks (see contextualize.ts): generation is the whole
    // cost of this phase and it does not parallelise, so the win is in generating fewer tokens, not in
    // issuing more requests. Sequential, which also lets Ollama reuse the prefix across a document's groups.
    if (contextualizer) {
      for (const w of batch) {
        const project = typeof w.doc.frontmatter["project"] === "string" ? (w.doc.frontmatter["project"] as string) : null;
        const background = buildBackground(w.doc, project ? await cards.bodyFor(project) : null, config.context.maxBackgroundChars);
        const res = await contextualizer.contextualize(w.doc, w.chunks, background);
        w.chunks.forEach((c, i) => {
          c.context = res.contexts[i] ?? "";
          c.text = composeChunkText(c.headingPath, c.context, c.content);
        });
        // One call situates a group of chunks, so count chunks here and calls separately.
        report.contextsGenerated += res.generated;
        report.contextsCached += res.cacheHits;
        report.contextFailures += res.failures;
        report.contextRetries += res.retries;
        report.contextCalls += res.llmCalls;
        contextualizedChunks += w.chunks.length;
        progress("contextualizing", contextualizedChunks, w.doc.meta.relPath);
      }
    }
    // Phase B: embeddings for the whole batch, then rows + manifest per document.
    const texts = batch.flatMap((w) => w.chunks.map((c) => c.text));
    const vectors = texts.length ? await embedder.embedDocuments(texts) : [];
    let vi = 0;
    for (const { doc, chunks } of batch) {
      const rows = chunks.map((c) => toStored(doc, c, vectors[vi++] as number[]));
      if (rows.length) await store.add(rows);
      written += rows.length;
      embedded += chunks.length;
      docsDone++;
      manifest.docs[doc.meta.sourceId] = {
        sourceId: doc.meta.sourceId,
        relPath: doc.meta.relPath,
        contentHash: doc.meta.contentHash,
        chunkCount: chunks.length,
        indexedAt: now,
        contextModel: contextualizer && contextualizer.usesModel(doc, chunks.length) ? contextualizer.opts.model : "",
      };
      progress("embedding", embedded, doc.meta.relPath);
    }
    await flushManifest();
  };

  let batch: Work[] = [];
  let batchChunks = 0;
  for (const w of work) {
    batch.push(w);
    batchChunks += w.chunks.length;
    if (batchChunks >= Math.max(1, config.context.batchChunks)) {
      await processBatch(batch);
      batch = [];
      batchChunks = 0;
    }
  }
  if (batch.length) await processBatch(batch);
  await flushManifest(true);

  if (!written && !staleIds.length) {
    log("Nothing to do; index is up to date.");
  } else {
    await store.optimize();
  }

  // 5. Rebuild the keyword index from the table (single source of truth).
  const bm25Started = Date.now();
  const totalInStore = await store.count();
  log(`Rebuilding the keyword index over ${totalInStore.toLocaleString("en-US")} chunks`);
  const bm25Docs = [];
  for await (const r of store.scanForKeywordIndex()) {
    bm25Docs.push({ id: r.id, text: r.text, sourceType: r.source_type, kind: r.kind, authority: r.authority, lang: r.lang });
    if (bm25Docs.length % 5000 === 0) {
      opts.onProgress?.({
        phase: "indexing",
        docsDone: work.length,
        docsTotal: work.length,
        chunksDone: bm25Docs.length,
        chunksTotal: totalInStore,
        elapsedMs: Date.now() - bm25Started,
        chunksPerSec: 0,
        etaMs: null,
        currentPath: "",
      });
    }
  }
  const bm25 = Bm25Index.build(bm25Docs);
  await bm25.save(paths.bm25Index);
  await writeManifest(paths.manifest, manifest);
  log(`Keyword index rebuilt over ${bm25.size} chunks`);

  report.chunksWritten = written;
  report.totalChunks = await store.count();
  report.durationMs = Date.now() - started;
  return report;
}
