/** Authority level declared in the kb frontmatter. Binding/normative docs get a retrieval boost. */
export type Authority = "binding" | "normative" | "descriptive" | "unknown";

/**
 * What a kb document is:
 *  - doc      prose documentation (TechDocs page, README, ADR, hand-written note)
 *  - code     a source file, stored as one fenced code block
 *  - project  the "project card" sync builds for each repository (description, owner, README excerpt, related Confluence pages)
 *  - api      an OpenAPI/AsyncAPI definition from the Dev Portal catalog
 */
export type DocKind = "doc" | "code" | "project" | "api";
export const DOC_KINDS: readonly DocKind[] = ["doc", "code", "project", "api"];

/** Document-level metadata, parsed from the YAML frontmatter of each kb/*.md file. */
export interface DocMeta {
  /** Stable id, e.g. "gitlab:oneplatform/adrs:Platform/ADR0010.md". */
  sourceId: string;
  /** Top-level kb folder / frontmatter source_type: devportal | gitlab | adr | manually-curated | ... */
  sourceType: string;
  kind: DocKind;
  title: string;
  sourceUrl: string | null;
  authority: Authority;
  lang: string;
  lastModified: string | null;
  /** sha256 of the file bytes; used to detect that a file changed at all between ingest runs. */
  contentHash: string;
  /**
   * sha256 of everything the chunker and the embedder actually see: kind, title, breadcrumb, project and
   * the cleaned body. Frontmatter bookkeeping (fetched_at, City Map fields, owner, build stamps...) is
   * deliberately outside it, so a metadata-only rewrite refreshes the stored rows instead of paying for
   * embeddings again. It is a hint, not a promise: the stored chunk text is what ingest finally compares.
   */
  embedHash: string;
  /** Path relative to the kb folder. */
  relPath: string;
}

export interface Document {
  meta: DocMeta;
  /** Markdown body without frontmatter. */
  body: string;
  /** Every frontmatter field as written by sync (project, entity, language, ...). */
  frontmatter: Record<string, unknown>;
}

/** A chunk ready to be embedded / indexed. `text` is what gets embedded (breadcrumb + content). */
export interface Chunk {
  id: string;
  sourceId: string;
  ordinal: number;
  /** "Title > H2 > H3" style heading path for the chunk ("project > file > symbol" for code). */
  headingPath: string;
  /** Raw chunk body (shown to users). */
  content: string;
  /** Embedding/index text: breadcrumb + content. */
  text: string;
  tokenEstimate: number;
  /** 1-based line range in the source file (code chunks only). */
  lineStart: number | null;
  lineEnd: number | null;
}

/** Row as stored in LanceDB (flattened so it can be filtered with SQL-like predicates). */
export interface StoredChunk {
  id: string;
  source_id: string;
  source_type: string;
  kind: string;
  title: string;
  source_url: string;
  authority: string;
  lang: string;
  last_modified: string;
  rel_path: string;
  ordinal: number;
  heading_path: string;
  content: string;
  text: string;
  /** -1 when not a code chunk. */
  line_start: number;
  line_end: number;
  vector: number[];
}

export interface RetrievalFilters {
  sourceTypes?: string[];
  kinds?: string[];
  authorities?: Authority[];
  langs?: string[];
}

export interface RetrievedChunk {
  id: string;
  sourceId: string;
  sourceType: string;
  kind: string;
  title: string;
  sourceUrl: string | null;
  authority: string;
  lang: string;
  relPath: string;
  ordinal: number;
  headingPath: string;
  content: string;
  lineStart: number | null;
  lineEnd: number | null;
  /** Final fused score (higher is better). */
  score: number;
  /** Debug info: rank in each retriever (1-based) or null when not returned by it. */
  vectorRank: number | null;
  bm25Rank: number | null;
}

/** A tool call as the model asked for it (Ollama/OpenAI shape). */
export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Tools the assistant asked to call in this turn; echoed back so the model sees its own request. */
  tool_calls?: ToolCall[];
  /** Which tool produced this message (role "tool"). */
  tool_name?: string;
}

/**
 * How hard the model works before answering.
 *
 * - `fast`: one retrieval pass, tools available but not pushed (the default).
 * - `research`: more passages, more tool rounds and a bigger tool budget, and the prompt tells the
 *   model to search from several angles and read whole documents before answering.
 */
export type AskMode = "fast" | "research";

/**
 * A CONTEXT block an earlier turn of the same chat already gathered, as the client saw it. Sent
 * back with a follow-up question so the conversation can continue on those passages instead of
 * running a fresh search (see `AskRequest.context`).
 */
export interface CarriedBlock {
  /** The number the block had in the conversation; kept stable so the [n] in earlier answers hold. */
  n: number;
  /** Index chunk id, or `<sourceId>#document` for a whole page read with `fetch_document`. */
  chunkId: string;
  /** Section of that page, when the block was a section rather than the whole document. */
  section?: string | null;
  /** True when an earlier answer cited it: those survive first when the carry has to be trimmed. */
  cited?: boolean;
}

export interface AskRequest {
  /** Full conversation; the last user message is the question. */
  messages: ChatMessage[];
  /**
   * Context blocks already gathered in this chat, from the previous turn's `sources` event. With
   * them a follow-up continues on that context instead of re-querying the knowledge base; without
   * them every turn retrieves (see config.retrieval.followUpSearch).
   */
  context?: CarriedBlock[];
  filters?: RetrievalFilters;
  topK?: number;
  /** Ask the model to emit reasoning tokens. Defaults to CHAT_THINK. */
  think?: boolean;
  /** Offer the knowledge-base tools (search, fetch_document). Defaults to CHAT_TOOLS and model support. */
  tools?: boolean;
  /** Effort level; defaults to `fast`. */
  mode?: AskMode;
}

export interface Citation {
  /** 1-based index used in the answer as [n]. */
  n: number;
  chunkId: string;
  sourceId: string;
  title: string;
  /** Deep link: for code chunks the GitLab blob URL carries a `#L<start>-<end>` anchor. */
  sourceUrl: string | null;
  sourceType: string;
  kind: string;
  authority: string;
  headingPath: string;
  relPath: string;
  excerpt: string;
  lineStart: number | null;
  lineEnd: number | null;
  score: number;
  /**
   * Section of the page the block covers, when it is a whole document read with `fetch_document`
   * and narrowed to one heading. Carried into the next turn so the same section comes back rather
   * than the whole page (see `CarriedBlock`).
   */
  section?: string | null;
}

/** Events streamed by the ask pipeline (used by CLI and SSE endpoint). */
/**
 * Token accounting for one answer, as reported by the model runtime. `promptTokens` is the last
 * round's prompt (what actually occupies the context window right now); `completionTokens` is the
 * sum over every round, reasoning included.
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  /** Context window the model is running with (Ollama `num_ctx`), so a UI can show saturation. */
  numCtx: number;
  /** True while the prompt size is a ~4-chars-per-token estimate: the round has not finished yet. */
  estimated?: boolean;
}

export type AskEvent =
  | { type: "status"; message: string }
  /** Token counts after a completed round; the UI updates its live meter from these. */
  | { type: "usage"; usage: TokenUsage }
  /**
   * The numbered blocks the answer may cite, re-sent whenever they change. `carried` blocks came
   * from earlier turns of the chat rather than from a search run for this question.
   */
  | { type: "sources"; citations: Citation[]; carried?: number[] }
  /** A reasoning delta, streamed before/while the answer is produced (thinking models only). */
  | { type: "thinking"; text: string }
  | { type: "token"; text: string }
  /** The model called a knowledge-base tool; `citations` are the context blocks its result occupies. */
  | { type: "tool"; name: string; args: Record<string, unknown>; summary: string; ok: boolean; citations?: number[] }
  | { type: "done"; answer: string; thinking: string; usedCitations: number[]; timings: Record<string, number>; usage?: TokenUsage }
  | { type: "error"; message: string };
