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
  /** sha256 of the file bytes; used to detect changes between ingest runs. */
  contentHash: string;
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
