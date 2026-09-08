import "dotenv/config";
import path from "node:path";

// LanceDB (Rust) logs an INFO/WARN line when it creates a table; keep the console clean.
process.env["LANCE_LOG"] ??= "error";

function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} must be a number, got "${v}"`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const v = str(name, fallback) as T;
  if (!allowed.includes(v)) throw new Error(`Env ${name} must be one of ${allowed.join(", ")}, got "${v}"`);
  return v;
}

const root = process.cwd();

export const config = {
  kbDir: path.resolve(root, str("KB_DIR", "./kb")),
  dataDir: path.resolve(root, str("DATA_DIR", "./data")),

  ollama: {
    host: str("OLLAMA_HOST", "http://127.0.0.1:11434").replace(/\/$/, ""),
  },

  embedding: {
    provider: oneOf("EMBEDDING_PROVIDER", ["ollama", "mock"] as const, "ollama"),
    model: str("EMBEDDING_MODEL", "qwen3-embedding:8b"),
    dimensions: num("EMBEDDING_DIMENSIONS", 4096),
    batchSize: num("EMBED_BATCH_SIZE", 16),
    // Qwen3-Embedding is instruction-aware: queries get an instruction prefix, documents do not.
    queryInstruction: str(
      "EMBEDDING_QUERY_INSTRUCTION",
      "Given a question about TeamSystem internal documentation, retrieve relevant passages that answer the question",
    ),
  },

  chat: {
    provider: oneOf("CHAT_PROVIDER", ["ollama", "mock"] as const, "ollama"),
    model: str("CHAT_MODEL", "qwen3:8b"),
    think: bool("CHAT_THINK", false),
    numCtx: num("CHAT_NUM_CTX", 16384),
    temperature: num("CHAT_TEMPERATURE", 0.2),
  },

  chunking: {
    targetTokens: num("CHUNK_TARGET_TOKENS", 450),
    maxTokens: num("CHUNK_MAX_TOKENS", 700),
    overlapTokens: num("CHUNK_OVERLAP_TOKENS", 60),
  },

  retrieval: {
    candidates: num("RETRIEVAL_CANDIDATES", 24),
    topK: num("RETRIEVAL_TOP_K", 6),
    vectorWeight: num("RETRIEVAL_VECTOR_WEIGHT", 1.0),
    bm25Weight: num("RETRIEVAL_BM25_WEIGHT", 1.0),
    maxChunksPerDoc: num("RETRIEVAL_MAX_CHUNKS_PER_DOC", 3),
    rerank: oneOf("RERANK", ["none", "llm"] as const, "none"),
    /** Rewrite follow-up questions into standalone search queries using the chat history. */
    queryRewrite: bool("QUERY_REWRITE", true),
  },

  server: {
    port: num("PORT", 8787),
    host: str("HOST", "127.0.0.1"),
  },

  eval: {
    /** Model used by `npm run eval -- --judge`. Defaults to the chat model; a bigger one grades more reliably. */
    judgeModel: str("JUDGE_MODEL", str("CHAT_MODEL", "qwen3:8b")),
  },
} as const;

export type Config = typeof config;

export const paths = {
  lanceDb: path.join(config.dataDir, "lancedb"),
  bm25Index: path.join(config.dataDir, "bm25.json.gz"),
  manifest: path.join(config.dataDir, "manifest.json"),
};
