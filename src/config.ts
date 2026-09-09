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
    // Embedding touches every chunk and is prompt-bound, so the model size is the floor on ingest time:
    // on an M5 Pro the 0.6b does ~24 chunks/s against ~2.9 for the 8b (1.3 h vs 11 h over 114k chunks).
    model: str("EMBEDDING_MODEL", "qwen3-embedding:0.6b"),
    dimensions: num("EMBEDDING_DIMENSIONS", 1024),
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
    /** Source files are cut at declaration boundaries; a function is the natural unit, so chunks are a bit larger. */
    code: {
      targetTokens: num("CODE_CHUNK_TARGET_TOKENS", 600),
      maxTokens: num("CODE_CHUNK_MAX_TOKENS", 900),
    },
  },

  /**
   * Contextual retrieval (https://www.anthropic.com/engineering/contextual-retrieval): before embedding, every
   * chunk is prefixed with a short context written by a chat model that has seen the whole document and a
   * project brief. The prefix is indexed by both the vector and the BM25 index. Costs one generation per chunk,
   * so the model can be a smaller one than CHAT_MODEL; results are cached in DATA_DIR/contexts.
   */
  context: {
    enabled: bool("CONTEXTUALIZE", true),
    /**
     * Generation is the whole cost of this stage and does not parallelise, so prefer a small model:
     * qwen3:1.7b sustains ~156 tok/s here against ~49 for an 8B. Models whose Ollama architecture is
     * `qwen35` (e.g. ornith-1.5:9b) are pinned to a single slot and are a poor fit.
     */
    model: str("CONTEXT_MODEL", "qwen3:1.7b"),
    /** Context window requested from Ollama for the contextualizer; the document window is sized to fit it. */
    numCtx: num("CONTEXT_NUM_CTX", 8192),
    /** Characters of the document shown to the model (larger documents get head + a window around the chunk). */
    maxDocChars: num("CONTEXT_MAX_DOC_CHARS", 16_000),
    /** Characters of the project brief / entity background shown to the model. */
    maxBackgroundChars: num("CONTEXT_MAX_BACKGROUND_CHARS", 1_800),
    /** Max tokens generated per context. */
    maxTokens: num("CONTEXT_MAX_TOKENS", 120),
    /** Which document kinds get an LLM context (others get a cheap deterministic one). */
    kinds: str("CONTEXT_KINDS", "doc,code,api").split(",").map((s) => s.trim()).filter(Boolean),
    /**
     * Chunk content characters per batched call. One call situates a whole group, so this trades prompt
     * size (grows with the group) against the number of prefills (shrinks with it). 16 000 chars ≈ 4 000
     * tokens of chunks, which leaves room in CONTEXT_NUM_CTX for the background, the head and the answer.
     */
    groupChars: num("CONTEXT_GROUP_CHARS", 16_000),
    /**
     * Per-kind override. API reference pages are dense and repetitive (schema after schema), and a 1.7B
     * asked to label 16 000 characters of them loses track and skips ids — 17 % of them, each costing a
     * single-chunk retry. Halving the group removes the skips and is a net win despite the extra prefill.
     */
    groupCharsByKind: { api: num("CONTEXT_GROUP_CHARS_API", 8_000) } as Record<string, number>,
    /** Word budget per context. Generation is the whole cost, so this is the main time/quality dial. */
    maxWords: num("CONTEXT_MAX_WORDS", 30),
    /** Documents with fewer chunks than this get a deterministic context. */
    minChunks: num("CONTEXT_MIN_CHUNKS", 2),
    /**
     * Per-kind override. Code chunks already carry "repo > file > symbol" in their indexed text and a
     * deterministic context naming the repo, path and language, so short files gain little from the model.
     */
    minChunksByKind: { code: num("CONTEXT_MIN_CHUNKS_CODE", 4) } as Record<string, number>,
    /** Documents are processed in batches of about this many chunks: contextualize the batch, then embed it. */
    batchChunks: num("INGEST_BATCH_CHUNKS", 256),
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

  /** `npm run sync`: where the knowledge base is gathered from. Scope lives in sources.yaml. */
  sync: {
    sourcesFile: path.resolve(root, str("SOURCES_FILE", "./sources.yaml")),
    concurrency: num("SYNC_CONCURRENCY", 4),
    devportal: {
      baseUrl: str("DEVPORTAL_BASE_URL", "https://development.teamsystem.com").replace(/\/$/, ""),
      token: str("DEVPORTAL_TOKEN", ""),
    },
    gitlab: {
      baseUrl: str("GITLAB_BASE_URL", "https://biosphere.teamsystem.com").replace(/\/$/, ""),
      token: str("GITLAB_TOKEN", ""),
    },
    /** Confluence is not indexed any more: it only enriches the GitLab project cards (see sources.yaml). */
    confluence: {
      baseUrl: str("CONFLUENCE_BASE_URL", "https://teamsystem.atlassian.net").replace(/\/$/, ""),
      email: str("CONFLUENCE_EMAIL", ""),
      token: str("CONFLUENCE_API_TOKEN", ""),
      /** Optional: forces the api.atlassian.com gateway (needed by scoped tokens; auto-detected when empty). */
      cloudId: str("CONFLUENCE_CLOUD_ID", ""),
    },
  },
} as const;

export type Config = typeof config;

export const paths = {
  lanceDb: path.join(config.dataDir, "lancedb"),
  bm25Index: path.join(config.dataDir, "bm25.json.gz"),
  manifest: path.join(config.dataDir, "manifest.json"),
  /** 2-D UMAP projection of the vector index, built by `npm run map`, rendered at /map.html. */
  kbMap: path.join(config.dataDir, "kb-map.json.gz"),
  /** Per-source sync state (data/sync/<source>.json). */
  syncState: path.join(config.dataDir, "sync"),
  /** Cache of the LLM-written chunk contexts (data/contexts/<shard>/<hash>.json), keyed by document and chunk hash. */
  contexts: path.join(config.dataDir, "contexts"),
};
