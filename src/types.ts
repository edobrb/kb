/** Authority level declared in the kb frontmatter. Binding/normative docs get a retrieval boost. */
export type Authority = "binding" | "normative" | "descriptive" | "unknown";

/** Document-level metadata, parsed from the YAML frontmatter of each kb/*.md file. */
export interface DocMeta {
  /** Stable id, e.g. "adr:repo-oneplatform-adrs-platform-adr0010-client-credentials". */
  sourceId: string;
  /** Top-level kb folder / frontmatter source_type: confluence | git-md | adr | manually-curated | ... */
  sourceType: string;
  title: string;
  sourceUrl: string | null;
  authority: Authority;
  lang: string;
  lastModified: string | null;
  /** sha256 of the file bytes; used to detect changes between ingest runs. */
  contentHash: string;
  /** Path relative to the kb folder. */
  relPath: string;
}

export interface Document {
  meta: DocMeta;
  /** Markdown body without frontmatter. */
  body: string;
}

/** A chunk ready to be embedded / indexed. `text` is what gets embedded (with breadcrumb header). */
export interface Chunk {
  id: string;
  sourceId: string;
  ordinal: number;
  /** "Title > H2 > H3" style heading path for the chunk. */
  headingPath: string;
  /** Raw chunk body (shown to users). */
  content: string;
  /** Embedding/index text: breadcrumb + content. */
  text: string;
  tokenEstimate: number;
}

/** Row as stored in LanceDB (flattened so it can be filtered with SQL-like predicates). */
export interface StoredChunk {
  id: string;
  source_id: string;
  source_type: string;
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
  vector: number[];
}

export interface RetrievalFilters {
  sourceTypes?: string[];
  authorities?: Authority[];
  langs?: string[];
}

export interface RetrievedChunk {
  id: string;
  sourceId: string;
  sourceType: string;
  title: string;
  sourceUrl: string | null;
  authority: string;
  lang: string;
  relPath: string;
  ordinal: number;
  headingPath: string;
  content: string;
  /** Final fused score (higher is better). */
  score: number;
  /** Debug info: rank in each retriever (1-based) or null when not returned by it. */
  vectorRank: number | null;
  bm25Rank: number | null;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AskRequest {
  /** Full conversation; the last user message is the question. */
  messages: ChatMessage[];
  filters?: RetrievalFilters;
  topK?: number;
  /** Ask the model to emit reasoning tokens. Defaults to CHAT_THINK. */
  think?: boolean;
}

export interface Citation {
  /** 1-based index used in the answer as [n]. */
  n: number;
  chunkId: string;
  sourceId: string;
  title: string;
  sourceUrl: string | null;
  sourceType: string;
  authority: string;
  headingPath: string;
  relPath: string;
  excerpt: string;
  score: number;
}

/** Events streamed by the ask pipeline (used by CLI and SSE endpoint). */
export type AskEvent =
  | { type: "status"; message: string }
  | { type: "sources"; citations: Citation[] }
  /** A reasoning delta, streamed before/while the answer is produced (thinking models only). */
  | { type: "thinking"; text: string }
  | { type: "token"; text: string }
  | { type: "done"; answer: string; thinking: string; usedCitations: number[]; timings: Record<string, number> }
  | { type: "error"; message: string };
