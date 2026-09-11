import { stat } from "node:fs/promises";
import { config, paths } from "../config.js";
import { buildGraph, KbGraph, loadPlaces } from "../graph/index.js";
import { getEmbedder } from "../llm/embeddings.js";
import { Bm25Index } from "../store/bm25.js";
import { VectorStore } from "../store/vector-store.js";
import type { Chunk, DocKind, Document, StoredChunk } from "../types.js";
import { chunkDocument } from "./chunker.js";
import { listMarkdownFiles, loadDocument } from "./loader.js";
import { emptyManifest, manifestIncompatible, readManifest, writeManifest, type Manifest, type ManifestEntry } from "./manifest.js";
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
}

export interface IngestReport {
  filesSeen: number;
  docsUnchanged: number;
  docsAdded: number;
  /** Existing documents that were chunked and embedded again. */
  docsUpdated: number;
  /** Existing documents whose rows were rewritten with new metadata, reusing the stored vectors. */
  docsRefreshed: number;
  docsRemoved: number;
  /** Chunks that went through the embedder. Rows rewritten from stored vectors are `docsRefreshed`. */
  chunksWritten: number;
  totalChunks: number;
  durationMs: number;
  /** Knowledge graph rebuilt at the end of the run (absent when GRAPH=false or it failed). */
  graph?: { nodes: number; edges: number; brokenLinks: number; bytes: number };
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
    content: chunk.content,
    text: chunk.text,
    line_start: chunk.lineStart ?? -1,
    line_end: chunk.lineEnd ?? -1,
    vector,
  };
}

/** Stable processing order: project cards, then prose, then API definitions, then the bulk of the code. */
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
  const wanted = {
    embeddingModel: `${config.embedding.provider}:${config.embedding.model}`,
    embeddingDimensions: embedder.dimensions,
    chunking: { targetTokens: config.chunking.targetTokens, maxTokens: config.chunking.maxTokens, overlapTokens: config.chunking.overlapTokens, code: { ...config.chunking.code } },
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
  const toEmbed: Document[] = [];
  // Files whose bytes changed but whose embedding inputs did not: candidates for a metadata-only refresh.
  const toRefresh: Document[] = [];
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
    const prev = manifest.docs[doc.meta.sourceId];
    if (prev && prev.contentHash === doc.meta.contentHash) {
      unchanged++;
      // Manifests written before embedHash existed get it filled in from the very file they describe:
      // the bytes match, so this is exactly what was indexed.
      prev.embedHash ??= doc.meta.embedHash;
      continue;
    }
    if (!prev) {
      added++;
      toEmbed.push(doc);
      continue;
    }
    updated++;
    // An unknown embedHash (older manifest) still goes down the refresh path: the stored chunk text decides.
    if (!prev.embedHash || prev.embedHash === doc.meta.embedHash) toRefresh.push(doc);
    else toEmbed.push(doc);
  }

  const removedIds = opts.only ? [] : Object.keys(manifest.docs).filter((id) => !seenSourceIds.has(id));
  log(`Unchanged: ${unchanged}, new: ${added}, changed: ${updated}, removed: ${removedIds.length}`);

  // 2. Chunk. The refresh candidates are chunked too: their chunks are what gets compared with the store.
  const chunkAll = (docs: Document[]): Work[] =>
    docs
      .sort((a, b) => KIND_ORDER[a.meta.kind] - KIND_ORDER[b.meta.kind] || a.meta.relPath.localeCompare(b.meta.relPath))
      .map((doc) => ({ doc, chunks: chunkDocument(doc, config.chunking) }));
  const work: Work[] = chunkAll(toEmbed);
  const refreshWork: Work[] = chunkAll(toRefresh);
  const all = [...work, ...refreshWork];
  if (all.length) {
    const sizes = all.flatMap((w) => w.chunks.map((c) => c.tokenEstimate));
    const { sum, max } = sizes.reduce((acc, n) => ({ sum: acc.sum + n, max: n > acc.max ? n : acc.max }), { sum: 0, max: 0 });
    const avg = sizes.length ? Math.round(sum / sizes.length) : 0;
    const byKind = all.reduce<Record<string, number>>((acc, w) => ((acc[w.doc.meta.kind] = (acc[w.doc.meta.kind] ?? 0) + w.chunks.length), acc), {});
    log(`Chunked ${all.length} docs into ${sizes.length} chunks (avg ~${avg} tokens, max ${max}; ${Object.entries(byKind).map(([k, n]) => `${k}=${n}`).join(", ")})`);
  }

  const report: IngestReport = {
    filesSeen: files.length,
    docsUnchanged: unchanged,
    docsAdded: added,
    docsUpdated: updated,
    docsRefreshed: 0,
    docsRemoved: removedIds.length,
    chunksWritten: 0,
    totalChunks: 0,
    durationMs: 0,
  };

  if (opts.dryRun) {
    for (const w of all.slice(0, 3)) {
      log(`\n--- ${w.doc.meta.relPath} (${w.doc.meta.kind}, ${w.chunks.length} chunks)`);
      for (const c of w.chunks.slice(0, 2)) log(`[${c.ordinal}] ${c.headingPath}${c.lineStart ? ` L${c.lineStart}-${c.lineEnd}` : ""} (${c.tokenEstimate} tok)\n${c.content.slice(0, 300)}...\n`);
    }
    report.totalChunks = await store.count();
    report.durationMs = Date.now() - started;
    return report;
  }

  // 3. Remove stale/changed docs from the vector store. The refresh candidates are left alone: their rows
  //    still hold the vectors that step 3b is about to reuse.
  const staleIds = [...removedIds, ...toEmbed.filter((d) => manifest.docs[d.meta.sourceId]).map((d) => d.meta.sourceId)];
  if (staleIds.length) {
    await store.deleteBySourceIds(staleIds);
    for (const id of removedIds) delete manifest.docs[id];
  }

  // The manifest records what is already indexed, so it must reach disk regularly: a crash then only
  // costs the documents written since the last flush. Writing it after *every* document would be O(n²)
  // at this scale, hence the time-based flush.
  const MANIFEST_FLUSH_MS = 5_000;
  let lastManifestWrite = Date.now();
  const flushManifest = async (force = false) => {
    if (!force && Date.now() - lastManifestWrite < MANIFEST_FLUSH_MS) return;
    await writeManifest(paths.manifest, manifest);
    lastManifestWrite = Date.now();
  };
  const now = new Date().toISOString();
  const entryFor = (doc: Document, chunkCount: number): ManifestEntry => ({
    sourceId: doc.meta.sourceId,
    relPath: doc.meta.relPath,
    contentHash: doc.meta.contentHash,
    embedHash: doc.meta.embedHash,
    chunkCount,
    indexedAt: now,
  });

  // 3b. Metadata-only rewrites — a fresh fetched_at, a City Map field, a renamed owner, a sync bookkeeping
  //     field. The chunk text is unchanged, so the vectors in the store are still the right ones: rewrite the
  //     rows with the new metadata instead of embedding the document again. A document is only reused when
  //     every chunk lines up with a stored row of exactly the same text, so a chunker change or a half-written
  //     document can never pair a vector with the wrong text — anything else falls through to step 4.
  let refreshedChunks = 0;
  if (refreshWork.length) {
    log(`Checking ${refreshWork.length.toLocaleString("en-US")} changed documents against the stored chunks before embedding them`);
    /** Rows for `w` built from the stored vectors, or null when anything does not line up exactly. */
    const reuseRows = (w: Work, have: Map<number, { text: string; vector: number[] }>): StoredChunk[] | null => {
      if (have.size !== w.chunks.length) return null;
      const rows: StoredChunk[] = [];
      for (const c of w.chunks) {
        const hit = have.get(c.ordinal);
        if (!hit || hit.text !== c.text || hit.vector.length !== embedder.dimensions) return null;
        rows.push(toStored(w.doc, c, hit.vector));
      }
      return rows;
    };

    const fellBack: string[] = [];
    for (let i = 0; i < refreshWork.length; ) {
      // Batch by rows, not documents: one store read and one write per ~2k chunks.
      const batch: Work[] = [];
      let batchRows = 0;
      while (i < refreshWork.length && (!batch.length || batchRows + (refreshWork[i] as Work).chunks.length <= 2_000)) {
        const w = refreshWork[i++] as Work;
        batch.push(w);
        batchRows += w.chunks.length;
      }
      // Ask for more rows than expected so a document whose chunk count moved reads back as a mismatch.
      const stored = await store.chunkVectorsBySourceIds(batch.map((w) => w.doc.meta.sourceId), batchRows * 2 + 100);
      const rows: StoredChunk[] = [];
      const reused: Work[] = [];
      for (const w of batch) {
        const have = stored.get(w.doc.meta.sourceId);
        const docRows = have ? reuseRows(w, have) : null;
        if (docRows) {
          reused.push(w);
          rows.push(...docRows);
        } else {
          work.push(w);
          fellBack.push(w.doc.meta.sourceId);
        }
      }
      if (reused.length) {
        await store.deleteBySourceIds(reused.map((w) => w.doc.meta.sourceId));
        await store.add(rows);
        for (const w of reused) manifest.docs[w.doc.meta.sourceId] = entryFor(w.doc, w.chunks.length);
        report.docsRefreshed += reused.length;
        refreshedChunks += rows.length;
        await flushManifest();
      }
    }
    // Their old rows were deliberately not deleted in step 3; drop them now that they go through the embedder.
    if (fellBack.length) await store.deleteBySourceIds(fellBack);
    report.docsUpdated -= report.docsRefreshed;
    log(
      `Reused stored embeddings for ${report.docsRefreshed} of ${refreshWork.length} changed documents ` +
        `(${refreshedChunks.toLocaleString("en-US")} chunks, metadata only)`,
    );
  }

  // 4. Embed + write, in batches of documents.
  const chunkTotal = work.reduce((n, w) => n + w.chunks.length, 0);

  let written = 0;
  let embedded = 0;
  let docsDone = 0;
  const phaseStarted = Date.now();
  // Wall-clock rate over embedded chunks. The window spans several batches so the ETA follows the real
  // throughput instead of the size of whichever document was written last.
  const overall = new RateTracker(30 * 60_000);
  overall.add(0, phaseStarted);

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
    log(`Indexing ${chunkTotal.toLocaleString("en-US")} chunks from ${work.length.toLocaleString("en-US")} documents: embeddings with ${model}`);
  }

  const processBatch = async (batch: Work[]) => {
    // One embedding request per batch (the embedder splits it into EMBED_BATCH_SIZE calls), then rows
    // and manifest entries per document.
    const texts = batch.flatMap((w) => w.chunks.map((c) => c.text));
    const vectors = texts.length ? await embedder.embedDocuments(texts) : [];
    let vi = 0;
    for (const { doc, chunks } of batch) {
      const rows = chunks.map((c) => toStored(doc, c, vectors[vi++] as number[]));
      if (rows.length) await store.add(rows);
      written += rows.length;
      embedded += chunks.length;
      docsDone++;
      manifest.docs[doc.meta.sourceId] = entryFor(doc, chunks.length);
      progress("embedding", embedded, doc.meta.relPath);
    }
    await flushManifest();
  };

  let batch: Work[] = [];
  let batchChunks = 0;
  for (const w of work) {
    batch.push(w);
    batchChunks += w.chunks.length;
    if (batchChunks >= Math.max(1, config.ingest.batchChunks)) {
      await processBatch(batch);
      batch = [];
      batchChunks = 0;
    }
  }
  if (batch.length) await processBatch(batch);
  await flushManifest(true);

  if (!written && !refreshedChunks && !staleIds.length) {
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

  // 6. Rebuild the knowledge graph from the manifest, for the same reason BM25 is rebuilt here: a
  // graph whose ids no longer exist in the index would send `related` and the map at nothing. Cheap
  // (a pass over the kb files, no embedding), and a failure must not fail the ingest.
  if (config.graph.enabled) {
    try {
      const docs = Object.values(manifest.docs).map((d) => ({ sourceId: d.sourceId, relPath: d.relPath }));
      const places = await loadPlaces(docs.map((d) => d.relPath), kbDir);
      const graph = await buildGraph({ kbDir, docs, places });
      const bytes = await KbGraph.save(graph);
      report.graph = { nodes: graph.stats.nodes, edges: graph.stats.edges, brokenLinks: graph.stats.brokenLinksTotal, bytes };
      log(
        `Knowledge graph rebuilt: ${graph.stats.nodes.toLocaleString("en-US")} nodes, ${graph.stats.edges.toLocaleString("en-US")} edges ` +
          `(${Math.round(bytes / 1024)} kB); ${graph.stats.brokenLinksTotal.toLocaleString("en-US")} dangling internal links`,
      );
    } catch (err) {
      log(`  ! knowledge graph not rebuilt: ${(err as Error).message}`);
    }
  }

  report.chunksWritten = written;
  report.totalChunks = await store.count();
  report.durationMs = Date.now() - started;
  return report;
}
