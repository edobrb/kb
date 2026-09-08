import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * The manifest records what is currently indexed so `ingest` can be incremental:
 * unchanged documents are skipped, changed ones re-indexed, deleted ones removed.
 */
export interface ManifestEntry {
  sourceId: string;
  relPath: string;
  contentHash: string;
  chunkCount: number;
  indexedAt: string;
}

export interface Manifest {
  version: 1;
  embeddingModel: string;
  embeddingDimensions: number;
  chunking: { targetTokens: number; maxTokens: number; overlapTokens: number };
  docs: Record<string, ManifestEntry>;
}

export async function readManifest(file: string): Promise<Manifest | null> {
  try {
    const raw = await readFile(file, "utf8");
    const m = JSON.parse(raw) as Manifest;
    if (m.version !== 1 || typeof m.docs !== "object") return null;
    return m;
  } catch {
    return null;
  }
}

export async function writeManifest(file: string, manifest: Manifest): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2), "utf8");
  await rename(tmp, file);
}

export function emptyManifest(init: Omit<Manifest, "version" | "docs">): Manifest {
  return { version: 1, docs: {}, ...init };
}

/** True when the index must be rebuilt from scratch (different model / dims / chunking). */
export function manifestIncompatible(existing: Manifest, wanted: Omit<Manifest, "version" | "docs">): string | null {
  if (existing.embeddingModel !== wanted.embeddingModel)
    return `embedding model changed (${existing.embeddingModel} -> ${wanted.embeddingModel})`;
  if (existing.embeddingDimensions !== wanted.embeddingDimensions)
    return `embedding dimensions changed (${existing.embeddingDimensions} -> ${wanted.embeddingDimensions})`;
  const a = existing.chunking;
  const b = wanted.chunking;
  if (a.targetTokens !== b.targetTokens || a.maxTokens !== b.maxTokens || a.overlapTokens !== b.overlapTokens)
    return "chunking parameters changed";
  return null;
}
