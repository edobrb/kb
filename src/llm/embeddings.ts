import { createHash } from "node:crypto";
import { config } from "../config.js";
import { ollamaEmbed } from "./ollama.js";

export interface Embedder {
  readonly dimensions: number;
  /** Embed passages (no instruction). */
  embedDocuments(texts: string[], onProgress?: (done: number, total: number) => void): Promise<number[][]>;
  /** Embed a search query (instruction-prefixed for Qwen3-Embedding). */
  embedQuery(text: string): Promise<number[]>;
}

/** L2-normalise in place and return the same array. */
export function normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const n = Math.sqrt(sum) || 1;
  for (let i = 0; i < v.length; i++) v[i] = (v[i] as number) / n;
  return v;
}

/**
 * Matryoshka truncation: Qwen3-Embedding models are trained so that the first N dimensions
 * of the vector are themselves a good embedding. Truncate + renormalise.
 */
function fitDimensions(v: number[], dims: number): number[] {
  if (v.length === dims) return normalize(v);
  if (v.length < dims) {
    throw new Error(`Embedding model returned ${v.length} dims but EMBEDDING_DIMENSIONS=${dims} is larger`);
  }
  return normalize(v.slice(0, dims));
}

/** Qwen3-Embedding query format. Documents are embedded as-is. */
export function formatQuery(query: string): string {
  return `Instruct: ${config.embedding.queryInstruction}\nQuery: ${query}`;
}

class OllamaEmbedder implements Embedder {
  readonly dimensions = config.embedding.dimensions;

  async embedDocuments(texts: string[], onProgress?: (done: number, total: number) => void): Promise<number[][]> {
    const out: number[][] = [];
    const batch = Math.max(1, config.embedding.batchSize);
    for (let i = 0; i < texts.length; i += batch) {
      const slice = texts.slice(i, i + batch);
      const vectors = await ollamaEmbed(slice);
      for (const v of vectors) out.push(fitDimensions(v, this.dimensions));
      onProgress?.(Math.min(i + batch, texts.length), texts.length);
    }
    return out;
  }

  async embedQuery(text: string): Promise<number[]> {
    const [v] = await ollamaEmbed([formatQuery(text)]);
    if (!v) throw new Error("Empty embedding response");
    return fitDimensions(v, this.dimensions);
  }
}

/**
 * Deterministic hashed bag-of-words embedder. No model needed: used by tests and CI so the
 * whole pipeline (chunking, LanceDB, BM25, fusion, API) can run without Ollama.
 * Retrieval quality is "keyword-ish", not semantic.
 */
export class MockEmbedder implements Embedder {
  readonly dimensions: number;
  constructor(dimensions = 256) {
    this.dimensions = dimensions;
  }

  private embedOne(text: string): number[] {
    const v = new Array<number>(this.dimensions).fill(0);
    const tokens = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    for (const tok of tokens) {
      const h = createHash("md5").update(tok).digest();
      const idx = h.readUInt32LE(0) % this.dimensions;
      const sign = (h[4] as number) & 1 ? 1 : -1;
      v[idx] = (v[idx] as number) + sign;
    }
    return normalize(v);
  }

  async embedDocuments(texts: string[], onProgress?: (done: number, total: number) => void): Promise<number[][]> {
    const out = texts.map((t) => this.embedOne(t));
    onProgress?.(texts.length, texts.length);
    return out;
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.embedOne(text);
  }
}

let cached: Embedder | null = null;
export function getEmbedder(): Embedder {
  if (cached) return cached;
  cached = config.embedding.provider === "mock" ? new MockEmbedder() : new OllamaEmbedder();
  return cached;
}
