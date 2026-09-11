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

// Base effort knobs, read once: the "extended research" defaults are multiples of them, so raising
// TOOL_MAX_ROUNDS / TOOL_CHAR_BUDGET / RETRIEVAL_TOP_K lifts research mode with them.
const toolMaxRounds = num("TOOL_MAX_ROUNDS", 3);
const toolCharBudget = num("TOOL_CHAR_BUDGET", 24000);
const retrievalTopK = num("RETRIEVAL_TOP_K", 6);

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
    model: str("EMBEDDING_MODEL", "qwen3-embedding:8b"),
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
    numCtx: num("CHAT_NUM_CTX", 32768),
    /**
     * Cap on generated tokens (Ollama `num_predict`). Reserved out of CHAT_NUM_CTX: keep
     * the prompt (passages + tool results) under numCtx - maxTokens or answers get clipped.
     */
    maxTokens: num("CHAT_MAX_TOKENS", 4096),
    temperature: num("CHAT_TEMPERATURE", 0.2),
  },

  /** Tools the chat model may call while answering (see src/generation/tools.ts). */
  tools: {
    /** Ignored when the chat model has no tool support; `npm run doctor` reports it. */
    enabled: bool("CHAT_TOOLS", true),
    /** How many times the model may call tools before it must answer. */
    maxRounds: toolMaxRounds,
    /** Offer `search(query)`: further knowledge-base searches on queries of the model's choosing. */
    search: bool("TOOL_SEARCH", true),
    /** New passages one `search` call returns (passages already in the context are skipped). */
    searchTopK: num("TOOL_SEARCH_TOP_K", 4),
    /** Character budget for one `fetch_document` result (~4 chars/token). */
    docMaxChars: num("DOC_TOOL_MAX_CHARS", 20000),
    /**
     * Total characters tool results may add to one answer. Keep it well under CHAT_NUM_CTX * 4
     * minus the retrieved passages, or the model's context will overflow mid-answer.
     */
    charBudget: toolCharBudget,
    /**
     * "Extended research" mode: the same tools, given room to be used — more rounds and a larger
     * budget, plus a prompt that tells the model to keep searching and reading (see
     * toolInstructions). Never applied below the plain values (see effortFor in generation/ask.ts).
     * Watch the window: researchTopK passages + researchCharBudget/4 + CHAT_MAX_TOKENS must fit in
     * CHAT_NUM_CTX.
     */
    research: {
      maxRounds: num("RESEARCH_TOOL_MAX_ROUNDS", toolMaxRounds * 2),
      charBudget: num("RESEARCH_TOOL_CHAR_BUDGET", Math.round(toolCharBudget * 1.5)),
    },
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
   * The knowledge graph over kb/ (src/graph): what links a document to another and which
   * repository, space, entity, team, tag or City Map node it belongs to. Built from frontmatter and
   * body links at the end of every ingest, so it never drifts from the index.
   */
  graph: {
    /** Build it during ingest, load it for the `related` tool and the map overlay. */
    enabled: bool("GRAPH", true),
    /** Offer `related(source_id)` to the answering model. */
    tool: bool("TOOL_RELATED", true),
    /** Related documents one `related` call may list. */
    toolLimit: num("TOOL_RELATED_LIMIT", 12),
    /**
     * Hubs bigger than this contribute no "same repository / space / module" neighbours: in a repo
     * of eight documents that is a real hint, in one of three hundred it is noise.
     */
    maxHubSize: num("GRAPH_MAX_HUB_SIZE", 60),
  },

  /** Documents are embedded in batches of about this many chunks; the manifest is flushed after each batch. */
  ingest: {
    batchChunks: num("INGEST_BATCH_CHUNKS", 256),
  },

  retrieval: {
    candidates: num("RETRIEVAL_CANDIDATES", 24),
    topK: retrievalTopK,
    /** Passages the first pass returns in "extended research" mode (see tools.research). */
    researchTopK: num("RESEARCH_TOP_K", Math.round(retrievalTopK * 1.5)),
    vectorWeight: num("RETRIEVAL_VECTOR_WEIGHT", 1.0),
    bm25Weight: num("RETRIEVAL_BM25_WEIGHT", 1.0),
    maxChunksPerDoc: num("RETRIEVAL_MAX_CHUNKS_PER_DOC", 3),
    rerank: oneOf("RERANK", ["none", "llm"] as const, "none"),
    /** Rewrite follow-up questions into standalone search queries using the chat history. */
    queryRewrite: bool("QUERY_REWRITE", true),
    /**
     * A follow-up question in an ongoing chat reuses the CONTEXT blocks the chat already gathered
     * instead of running a fresh retrieval pass: the conversation continues on the passages the
     * earlier answers were built from, and the model calls `search(query)` itself when the question
     * moves somewhere they do not cover. Set FOLLOWUP_SEARCH=true to search again on every turn
     * (the old behaviour); a first question, or a follow-up whose caller carried no context, always
     * retrieves.
     */
    followUpSearch: bool("FOLLOWUP_SEARCH", false),
    /** Blocks a follow-up may carry over; the cited ones are kept first, then the most recent. */
    carryMaxBlocks: num("FOLLOWUP_CARRY_MAX_BLOCKS", 24),
    /** Characters those blocks may occupy, so a long chat cannot fill the window with old context. */
    carryMaxChars: num("FOLLOWUP_CARRY_MAX_CHARS", toolCharBudget),
  },

  server: {
    port: num("PORT", 8787),
    host: str("HOST", "127.0.0.1"),
  },

  /** `Export .zip`: one answer packaged with the full text of its sources (see src/server/bundle.ts). */
  bundle: {
    /**
     * Character cap per document in a bundle. Unlike DOC_TOOL_MAX_CHARS this is not a context
     * budget — nothing here goes to a model — so it is generous enough to hold whole pages.
     */
    maxChars: num("BUNDLE_MAX_CHARS", 200_000),
    /** Documents one bundle may carry, a valve on a pathological citation list. */
    maxDocs: num("BUNDLE_MAX_DOCS", 100),
  },

  eval: {
    /** Model used by `npm run eval -- --judge`. Defaults to the chat model; a bigger one grades more reliably. */
    judgeModel: str("JUDGE_MODEL", str("CHAT_MODEL", "qwen3:8b")),
  },

  /** `npm run sync`: where the knowledge base is gathered from. Scope lives in sources.yaml. */
  sync: {
    sourcesFile: path.resolve(root, str("SOURCES_FILE", "./sources.yaml")),
    /** Hand-written City Map placements for sources the Dev Portal catalog does not describe (see src/citymap.ts). */
    taxonomyFile: path.resolve(root, str("TAXONOMY_FILE", "./taxonomy.yaml")),
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
  /** Knowledge graph over the indexed documents, rebuilt at the end of every ingest. */
  graph: path.join(config.dataDir, "graph.json.gz"),
  /** Per-source sync state (data/sync/<source>.json). */
  syncState: path.join(config.dataDir, "sync"),
};
