import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { config } from "../config.js";
import { deepLink } from "../generation/prompt.js";
import { DOC_RELATIONS, relationPhrase, type KbGraph, type Neighbor, type Relation } from "../graph/index.js";
import { DocumentNotFoundError, type DocumentStore, type FetchedDocument } from "../retrieval/documents.js";
import type { RetrieveOptions } from "../retrieval/retriever.js";
import type { Authority, RetrievalFilters, RetrievedChunk } from "../types.js";

/**
 * The knowledge base as MCP tools: retrieval only.
 *
 * `npm run serve` answers questions with the local model; this exposes the layer *underneath* that
 * — hybrid search, whole documents, the knowledge graph — to an outside client (Claude Code, the
 * Claude desktop app), which brings its own model. So there is no `ask` tool and no generation
 * here: nothing in src/mcp calls a chat model, and the only Ollama traffic is the query embedding.
 *
 *  - `search(query)`         the same hybrid retrieval as the web UI (vectors + BM25, RRF-fused),
 *                            returning ~450-token passages with their source_id and deep link.
 *  - `fetch_document(id)`    the whole kb page a passage came from, optionally one section.
 *  - `related(id)`           one hop in the knowledge graph: what links here, what this links to,
 *                            the rest of its repository / space / module. Titles and ids only.
 *
 * The budgets (see config.mcp) are deliberately larger than the local model's: the client's context
 * window is not ours to fit, and a truncated passage costs it a second round-trip.
 */

export interface Searcher {
  retrieve(query: string, opts?: RetrieveOptions): Promise<RetrievedChunk[]>;
}

export interface McpContext {
  searcher: Searcher;
  store: DocumentStore;
  /** Loaded on first use; null when the graph has not been built, which disables `related`. */
  graph: () => Promise<KbGraph | null>;
}

export interface McpToolResult {
  text: string;
  /** Reported to the client as `isError`, so the model sees the failure rather than a plain answer. */
  isError?: boolean;
}

export type McpToolHandler = (args: Record<string, unknown>, ctx: McpContext) => Promise<McpToolResult>;

const FILTER_PROPERTIES = {
  source_type: {
    type: "array",
    items: { type: "string" },
    description:
      'Restrict to these source types, e.g. ["devportal"], ["gitlab"], ["adr"]. Omit to search everything (the usual choice).',
  },
  kind: {
    type: "array",
    items: { type: "string", enum: ["doc", "code", "project", "api"] },
    description:
      'Restrict to these document kinds: "doc" prose documentation, "code" a source file, "project" a repository card, "api" an OpenAPI/AsyncAPI definition.',
  },
  authority: {
    type: "array",
    items: { type: "string", enum: ["binding", "normative", "descriptive", "unknown"] },
    description: 'Restrict to these authority levels — ["binding","normative"] for ADRs and standards only.',
  },
  lang: { type: "array", items: { type: "string" }, description: 'Restrict to these languages, e.g. ["en"] or ["it"].' },
} as const;

export const SEARCH_TOOL: Tool = {
  name: "search",
  title: "Search the OnePlatform knowledge base",
  description:
    "Search the TeamSystem OnePlatform knowledge base: Developer Portal documentation and API definitions, the " +
    "OnePlatform GitLab repositories (docs, project cards and source code), ADRs and hand-written references. " +
    "Hybrid retrieval — embeddings plus BM25 — over the indexed passages; questions in Italian and English both " +
    "match. Returns the most relevant passages with their source_id, metadata and deep link. Use it before " +
    "answering anything about internal TeamSystem services, repositories, endpoints, settings or conventions, and " +
    "before saying the documentation does not cover something; then read the whole page with fetch_document.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "What to look for. A question works, and so does a bare name: a service, repository, endpoint, setting or " +
          "error. If a first search finds nothing, try the other wording — an acronym or its expansion, the Italian " +
          "or English term, a term seen in a result.",
      },
      top_k: {
        type: "integer",
        minimum: 1,
        maximum: config.mcp.maxTopK,
        description: `Passages to return (1-${config.mcp.maxTopK}, default ${config.mcp.searchTopK}).`,
      },
      ...FILTER_PROPERTIES,
    },
    required: ["query"],
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

export const FETCH_DOCUMENT_TOOL: Tool = {
  name: "fetch_document",
  title: "Read a knowledge-base document",
  description:
    "Read a whole knowledge-base document by its source_id, as returned by search. Use it when a passage is clearly " +
    "the right page but is cut off, refers to a section you cannot see, or you need the exact list, table, code or " +
    "steps around it. Returns the document's markdown with its metadata and heading outline; a long document is " +
    "truncated, so call again with `section` (a heading from the outline) to read further.",
  inputSchema: {
    type: "object",
    properties: {
      source_id: {
        type: "string",
        description:
          'The source_id shown in a search result, e.g. "gitlab:oneplatform/adrs:Platform/ADR0010.md" or ' +
          '"devportal:default/component/hermes/CHANGELOG/". A kb-relative path works too.',
      },
      section: {
        type: "string",
        description:
          'Optional heading to return instead of the whole document, matched loosely against its headings, e.g. "Retry policy".',
      },
      max_chars: {
        type: "integer",
        minimum: 500,
        description: `Character budget for the markdown returned (default ${config.mcp.docMaxChars}).`,
      },
    },
    required: ["source_id"],
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

export const RELATED_TOOL: Tool = {
  name: "related",
  title: "List connected documents",
  description:
    "List the documents connected to one knowledge-base document: the pages it links to and that link to it, its " +
    "parent page, the project card of its repository, and the rest of its repository, Confluence space or product " +
    "module. This is structure written in the documents themselves, not similarity, so it answers what search " +
    "cannot: whether an ADR, a sibling page or another file of the same repository covers the missing part. " +
    "Returns titles and source_ids only — read one with fetch_document.",
  inputSchema: {
    type: "object",
    properties: {
      source_id: { type: "string", description: "The source_id shown in a search result, or a kb-relative path." },
      scope: {
        type: "string",
        enum: ["all", "links", "same_place"],
        description:
          '"links" for pages linked to or from this one only, "same_place" for the rest of its repository / space / ' +
          'module, "all" (the default) for both.',
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: 100,
        description: `Documents to list (default ${config.mcp.relatedLimit}).`,
      },
    },
    required: ["source_id"],
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
};

/** What the client is told this server is for; some clients show it to the model as system context. */
export const SERVER_INSTRUCTIONS =
  "Read-only access to the TeamSystem OnePlatform knowledge base (Developer Portal documentation and API " +
  "definitions, the OnePlatform GitLab repositories including source code, ADRs, glossary). Everything here is " +
  "internal documentation that is not on the public web, so search it rather than answering from general " +
  "knowledge, and cite the source_id or the URL of the passages you used. Typical path: search(query) → " +
  "fetch_document(source_id) for the full page → related(source_id) when the topic continues elsewhere.";

/** Tool specs the server advertises. `related` needs a graph on disk (`npm run graph`). */
export function mcpTools(opts: { graph?: boolean } = {}): Tool[] {
  return opts.graph === false ? [SEARCH_TOOL, FETCH_DOCUMENT_TOOL] : [SEARCH_TOOL, FETCH_DOCUMENT_TOOL, RELATED_TOOL];
}

// ---- argument coercion ---------------------------------------------------------------------------

/** First value present under any of `names`, so `top_k` and `topK` are the same argument. */
function pick(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) {
    const v = args[n];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function asString(args: Record<string, unknown>, ...names: string[]): string {
  const v = pick(args, ...names);
  if (typeof v === "number") return String(v);
  return typeof v === "string" ? v.trim() : "";
}

function asInt(args: Record<string, unknown>, fallback: number, min: number, max: number, ...names: string[]): number {
  const v = pick(args, ...names);
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** A list argument, tolerating the single string and the comma-separated string a model may send. */
function asList(args: Record<string, unknown>, ...names: string[]): string[] | undefined {
  const v = pick(args, ...names);
  const raw = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",") : [];
  const out = raw.map((s) => s.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

function filtersFrom(args: Record<string, unknown>): { filters: RetrievalFilters; described: string } {
  const filters: RetrievalFilters = {
    sourceTypes: asList(args, "source_type", "sourceTypes", "source_types"),
    kinds: asList(args, "kind", "kinds"),
    authorities: asList(args, "authority", "authorities") as Authority[] | undefined,
    langs: asList(args, "lang", "langs"),
  };
  const described = Object.entries({
    source_type: filters.sourceTypes,
    kind: filters.kinds,
    authority: filters.authorities,
    lang: filters.langs,
  })
    .flatMap(([k, v]) => (v ? [`${k}=${v.join("|")}`] : []))
    .join(" ");
  return { filters, described };
}

// ---- formatting ----------------------------------------------------------------------------------

const SEPARATOR = "\n\n----------------------------------------\n\n";

const RETRY_HINT =
  "Try different words: a service, repository, endpoint or setting name; an acronym or its expansion; the term in " +
  "the other language (Italian/English).";

/** One passage: a header the model can cite from, then the passage text flush-left (it may be code). */
function formatChunk(c: RetrievedChunk, i: number): string {
  const ranks = [c.vectorRank ? `vector #${c.vectorRank}` : "", c.bm25Rank ? `bm25 #${c.bm25Rank}` : ""].filter(Boolean).join(", ");
  const url = deepLink(c);
  const lines = [
    `${i}. ${c.title}${c.headingPath && c.headingPath !== c.title ? ` — ${c.headingPath}` : ""}`,
    `   source_id: ${c.sourceId}`,
    `   source_type=${c.sourceType} kind=${c.kind} authority=${c.authority} lang=${c.lang}` +
      `${c.lineStart ? ` lines=${c.lineStart}-${c.lineEnd ?? c.lineStart}` : ""}`,
    `   score=${c.score.toFixed(4)}${ranks ? ` (${ranks})` : ""}`,
    url ? `   url: ${url}` : `   kb path: ${c.relPath}`,
  ];
  return `${lines.join("\n")}\n\n${c.content.trim()}`;
}

/** A fetched document as the client reads it: metadata, how much of it this is, outline, markdown. */
export function formatDocument(doc: FetchedDocument): string {
  const url = deepLink({ sourceUrl: doc.sourceUrl, kind: doc.kind, lineStart: null, lineEnd: null });
  const scope = doc.section ? `section "${doc.section}"` : "full document";
  const size = doc.truncated
    ? `${doc.returnedChars} of ${doc.totalChars} chars — TRUNCATED, call fetch_document again with a \`section\` from the outline below to read further`
    : `${doc.returnedChars} chars`;
  const header = [
    doc.title,
    `source_id: ${doc.sourceId}`,
    `source_type=${doc.sourceType} kind=${doc.kind} authority=${doc.authority} lang=${doc.lang}` +
      `${doc.lastModified ? ` last_modified=${doc.lastModified}` : ""}`,
    url ? `url: ${url}` : `kb path: ${doc.relPath}`,
    doc.sectionNotFound
      ? `no section matching "${doc.sectionNotFound}" — returning the ${scope}, ${size}`
      : `${scope}, ${size}`,
    doc.outline.length ? `outline: ${doc.outline.slice(0, 60).join(" · ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `${header}\n\n${doc.content}`;
}

// ---- search --------------------------------------------------------------------------------------

const runSearch: McpToolHandler = async (args, ctx) => {
  const query = asString(args, "query", "q", "question");
  if (!query) return { isError: true, text: "search needs a `query`." };

  const topK = asInt(args, config.mcp.searchTopK, 1, config.mcp.maxTopK, "top_k", "topK", "k", "limit");
  const { filters, described } = filtersFrom(args);

  let chunks: RetrievedChunk[];
  try {
    // No LLM rerank: it would spend the local chat model on a request that came here to avoid it.
    chunks = await ctx.searcher.retrieve(query, { topK, filters, noRerank: true });
  } catch (err) {
    return { isError: true, text: `Search failed: ${(err as Error).message}` };
  }

  const scope = described ? ` (filters: ${described})` : "";
  if (!chunks.length) {
    return { text: `No passages matched "${query}"${scope}. ${RETRY_HINT}` };
  }

  // Fit the budget: always at least one passage, then stop before the one that would overflow.
  const kept: RetrievedChunk[] = [];
  let size = 0;
  for (const c of chunks) {
    const len = c.content.length + 400;
    if (kept.length && size + len > config.mcp.searchMaxChars) break;
    kept.push(c);
    size += len;
  }

  const dropped = chunks.length - kept.length;
  const header =
    `${kept.length} passage${kept.length === 1 ? "" : "s"} for "${query}"${scope}` +
    `${dropped ? `, ${dropped} more left out to stay inside the size budget (ask for a smaller top_k to see them ranked lower)` : ""}.` +
    ` Read a whole page with fetch_document(source_id); list the pages connected to it with related(source_id).`;

  return { text: `${header}${SEPARATOR}${kept.map((c, i) => formatChunk(c, i + 1)).join(SEPARATOR)}` };
};

// ---- fetch_document ------------------------------------------------------------------------------

const runFetchDocument: McpToolHandler = async (args, ctx) => {
  const requested = asString(args, "source_id", "sourceId", "id");
  if (!requested) return { isError: true, text: "fetch_document needs a `source_id` (as shown in a search result)." };
  const section = asString(args, "section") || null;
  const maxChars = asInt(args, config.mcp.docMaxChars, 500, 500_000, "max_chars", "maxChars");

  try {
    const doc = await ctx.store.fetch(requested, { section, maxChars });
    return { text: formatDocument(doc) };
  } catch (err) {
    if (err instanceof DocumentNotFoundError) {
      return {
        isError: true,
        text: `${err.message}. Run search(query) and use a source_id exactly as it appears in a result.`,
      };
    }
    return { isError: true, text: `Could not read the document: ${(err as Error).message}` };
  }
};

// ---- related -------------------------------------------------------------------------------------

/** Which relations each `scope` value covers. */
const SCOPES: Record<string, readonly Relation[] | null> = {
  all: null,
  links: DOC_RELATIONS,
  same_place: ["in_repo", "in_space", "under", "about_entity", "owned_by", "tagged", "in_module", "in_subarea", "in_area"],
};

/**
 * One neighbour, with its id. The graph also knows documents that are *linked* but not indexed (a
 * Confluence page, say: the wiki only enriches project cards now), and `fetch_document` cannot read
 * those — so they are marked rather than dropped, since "this ADR lives in the wiki" is an answer.
 */
const relatedLine = (n: Neighbor, fetchable: boolean): string =>
  `- ${n.title} — ${n.sourceId}${fetchable ? "" : " (linked, not indexed: fetch_document cannot read it)"}`;

const runRelated: McpToolHandler = async (args, ctx) => {
  const requested = asString(args, "source_id", "sourceId", "id");
  if (!requested) return { isError: true, text: "related needs a `source_id` (as shown in a search result)." };

  const graph = await ctx.graph();
  if (!graph) {
    return {
      isError: true,
      text: "The knowledge graph has not been built (run `npm run graph` in the ai-wiki project). Use search and fetch_document instead.",
    };
  }

  const scopeArg = asString(args, "scope").toLowerCase() || "all";
  const scope = scopeArg in SCOPES ? scopeArg : "all";
  const relations = SCOPES[scope] ?? undefined;
  const limit = asInt(args, config.mcp.relatedLimit, 1, 100, "limit", "top_k", "topK");

  const target = ctx.store.resolve(requested) ?? requested;
  const node = graph.node(target);
  if (!node || !graph.has(target)) {
    return { isError: true, text: `"${requested}" is not a document in the knowledge base. Run search(query) to get a valid source_id.` };
  }

  const all = graph.neighbors(target, { ...(relations ? { relations } : {}), maxHubSize: config.graph.maxHubSize });
  const kept = all.slice(0, limit);

  // Where the page sits, in words — "part of the Workspace module" without handing out hub ids that
  // no tool would accept.
  const hubs = graph
    .hubsOf(target)
    .filter((h) => h.type !== "tag")
    .slice(0, 4)
    .map((h) => `${h.label} (${h.type}, ${h.size} documents)`);

  if (!kept.length) {
    return {
      text:
        `No documents are connected to "${node.label}" (${target})${hubs.length ? `. It sits in: ${hubs.join(", ")}` : ""}. ` +
        `Use search(query) with different words instead.`,
    };
  }

  // Grouped by how each one is connected, so the list reads as structure rather than as a ranking.
  const groups = new Map<string, Neighbor[]>();
  for (const n of kept) {
    const phrase = n.direction === "sibling" && n.via ? `same ${n.via.type} (${n.via.label}, ${n.via.size} documents)` : relationPhrase(n);
    const bucket = groups.get(phrase);
    if (bucket) bucket.push(n);
    else groups.set(phrase, [n]);
  }

  const header =
    `${kept.length} document${kept.length === 1 ? "" : "s"} connected to "${node.label}" (${target})` +
    `${all.length > kept.length ? ` — the ${kept.length} closest of ${all.length}` : ""}.` +
    `${hubs.length ? ` It sits in: ${hubs.join(", ")}.` : ""}` +
    ` Read any of them with fetch_document(source_id), except the ones marked as not indexed.`;

  const sections = [...groups.entries()].map(
    ([phrase, rows]) => `${phrase}:\n${rows.map((n) => relatedLine(n, ctx.store.resolve(n.sourceId) !== null)).join("\n")}`,
  );
  return { text: `${header}\n\n${sections.join("\n\n")}` };
};

const HANDLERS: Record<string, McpToolHandler> = {
  [SEARCH_TOOL.name]: runSearch,
  [FETCH_DOCUMENT_TOOL.name]: runFetchDocument,
  [RELATED_TOOL.name]: runRelated,
};

/** Run one tool call. An unknown name is an error result, not a thrown exception. */
export async function runMcpTool(name: string, args: Record<string, unknown>, ctx: McpContext): Promise<McpToolResult> {
  const handler = HANDLERS[name];
  if (!handler) {
    return { isError: true, text: `There is no tool called "${name}". Available: ${Object.keys(HANDLERS).join(", ")}.` };
  }
  try {
    return await handler(args, ctx);
  } catch (err) {
    return { isError: true, text: `${name} failed: ${(err as Error).message}` };
  }
}
