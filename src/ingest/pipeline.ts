import { stat } from "node:fs/promises";
import { config, paths } from "../config.js";
import { getEmbedder } from "../llm/embeddings.js";
import { Bm25Index } from "../store/bm25.js";
import { VectorStore } from "../store/vector-store.js";
import type { Chunk, Document, StoredChunk } from "../types.js";
import { chunkDocument } from "./chunker.js";
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
  /** Called after each document is embedded, and once per phase change. Used to render progress/ETA. */
  onProgress?: (p: IngestProgress) => void;
}

export interface IngestReport {
  filesSeen: number;
  docsUnchanged: number;
  docsAdded: number;
  docsUpdated: number;
  docsRemoved: number;
  chunksWritten: number;
  totalChunks: number;
  durationMs: number;
}

function toStored(doc: Document, chunk: Chunk, vector: number[]): StoredChunk {
  return {
    id: chunk.id,
    source_id: doc.meta.sourceId,
    source_type: doc.meta.sourceType,
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
    vector,
  };
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
    chunking: { ...config.chunking },
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
      continue;
    }
    if (prev) updated++;
    else added++;
    toIndex.push(doc);
  }

  const removedIds = opts.only ? [] : Object.keys(manifest.docs).filter((id) => !seenSourceIds.has(id));
  log(`Unchanged: ${unchanged}, new: ${added}, changed: ${updated}, removed: ${removedIds.length}`);

  // 2. Chunk.
  const work: { doc: Document; chunks: Chunk[] }[] = toIndex.map((doc) => ({
    doc,
    chunks: chunkDocument(doc, config.chunking),
  }));
  const chunkTotal = work.reduce((n, w) => n + w.chunks.length, 0);
  if (work.length) {
    const sizes = work.flatMap((w) => w.chunks.map((c) => c.tokenEstimate));
    const { sum, max } = sizes.reduce((acc, n) => ({ sum: acc.sum + n, max: n > acc.max ? n : acc.max }), { sum: 0, max: 0 });
    const avg = sizes.length ? Math.round(sum / sizes.length) : 0;
    log(`Chunked ${work.length} docs into ${chunkTotal} chunks (avg ~${avg} tokens, max ${max})`);
  }

  if (opts.dryRun) {
    for (const w of work.slice(0, 3)) {
      log(`\n--- ${w.doc.meta.relPath} (${w.chunks.length} chunks)`);
      for (const c of w.chunks.slice(0, 2)) log(`[${c.ordinal}] ${c.headingPath} (${c.tokenEstimate} tok)\n${c.content.slice(0, 300)}...\n`);
    }
    return {
      filesSeen: files.length,
      docsUnchanged: unchanged,
      docsAdded: added,
      docsUpdated: updated,
      docsRemoved: removedIds.length,
      chunksWritten: 0,
      totalChunks: await store.count(),
      durationMs: Date.now() - started,
    };
  }

  // 3. Remove stale/changed docs from the vector store.
  const staleIds = [...removedIds, ...toIndex.filter((d) => manifest.docs[d.meta.sourceId]).map((d) => d.meta.sourceId)];
  if (staleIds.length) {
    await store.deleteBySourceIds(staleIds);
    for (const id of removedIds) delete manifest.docs[id];
  }

  // 4. Embed + write, document by document.
  //
  // The manifest records what is already indexed, so it must reach disk regularly: a crash then only
  // costs the documents written since the last flush (they are simply re-embedded next run). Writing it
  // after *every* document is O(n²) though — at 31k docs the file is ~10 MB, so that would serialise
  // ~160 GB over a run — hence the time-based flush.
  const MANIFEST_FLUSH_MS = 5_000;
  let lastManifestWrite = Date.now();
  const flushManifest = async (force = false) => {
    if (!force && Date.now() - lastManifestWrite < MANIFEST_FLUSH_MS) return;
    await writeManifest(paths.manifest, manifest);
    lastManifestWrite = Date.now();
  };

  let written = 0;
  let embedded = 0;
  let docsDone = 0;
  const embedStarted = Date.now();
  const rate = new RateTracker();
  rate.add(0, embedStarted);
  const now = new Date().toISOString();

  if (chunkTotal) {
    const model = config.embedding.provider === "ollama" ? config.embedding.model : `${config.embedding.provider}:${config.embedding.model}`;
    log(`Embedding ${chunkTotal.toLocaleString("en-US")} chunks from ${work.length.toLocaleString("en-US")} documents with ${model}`);
  }

  for (const { doc, chunks } of work) {
    if (!chunks.length) {
      manifest.docs[doc.meta.sourceId] = {
        sourceId: doc.meta.sourceId,
        relPath: doc.meta.relPath,
        contentHash: doc.meta.contentHash,
        chunkCount: 0,
        indexedAt: now,
      };
      docsDone++;
      continue;
    }
    const vectors = await embedder.embedDocuments(chunks.map((c) => c.text));
    const rows = chunks.map((c, i) => toStored(doc, c, vectors[i] as number[]));
    await store.add(rows);
    written += rows.length;
    embedded += chunks.length;
    docsDone++;
    manifest.docs[doc.meta.sourceId] = {
      sourceId: doc.meta.sourceId,
      relPath: doc.meta.relPath,
      contentHash: doc.meta.contentHash,
      chunkCount: chunks.length,
      indexedAt: now,
    };

    const t = Date.now();
    rate.add(embedded, t);
    opts.onProgress?.({
      phase: "embedding",
      docsDone,
      docsTotal: work.length,
      chunksDone: embedded,
      chunksTotal: chunkTotal,
      elapsedMs: t - embedStarted,
      chunksPerSec: rate.perSecond(),
      etaMs: rate.etaMs(chunkTotal - embedded),
      currentPath: doc.meta.relPath,
    });

    await flushManifest();
  }
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
    bm25Docs.push({ id: r.id, text: r.text, sourceType: r.source_type, authority: r.authority, lang: r.lang });
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

  return {
    filesSeen: files.length,
    docsUnchanged: unchanged,
    docsAdded: added,
    docsUpdated: updated,
    docsRemoved: removedIds.length,
    chunksWritten: written,
    totalChunks: await store.count(),
    durationMs: Date.now() - started,
  };
}
