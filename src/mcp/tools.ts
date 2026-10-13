import { randomUUID } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { config } from "../config.js";
import { REPORT_KINDS, type AgentReport, type ReportKind, type ReportSource } from "../feedback/index.js";
import { deepLink } from "../generation/prompt.js";
import { DOC_RELATIONS, RESOLUTION_REASONS, relationPhrase, type KbGraph, type Neighbor, type Relation } from "../graph/index.js";
import type { AdrStatusInfo } from "../ingest/adr-status.js";
import { DocumentNotFoundError, isAdrLike, type DocumentStore, type FetchedDocument } from "../retrieval/documents.js";
import type { RetrieveOptions } from "../retrieval/retriever.js";
import type { Authority, RetrievalFilters, RetrievedChunk } from "../types.js";

/**
 * The knowledge base as MCP tools: retrieval, plus a way to tell the maintainers what was wrong.
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
 *  - `report(kind, note)`    a note for the maintainers — a wrong or outdated document, a gap, a
 *                            search tip — appended to data/feedback/reports.jsonl. Not indexed and
 *                            never returned by search: a person reviews it first (see src/feedback).
 *
 * The budgets (see config.mcp) are deliberately larger than the local model's: the client's context
 * window is not ours to fit, and a truncated passage costs it a second round-trip.
 */

export interface Searcher {
  retrieve(query: string, opts?: RetrieveOptions): Promise<RetrievedChunk[]>;
  /** Values present in the index, to reject a filter value that can only match nothing. */
  facets?(): Promise<{ sourceTypes: Record<string, number>; kinds: Record<string, number>; authorities: Record<string, number>; langs: Record<string, number> }>;
}

export interface McpContext {
  searcher: Searcher;
  store: DocumentStore;
  /** Loaded on first use; null when the graph has not been built, which disables `related`. */
  graph: () => Promise<KbGraph | null>;
  /** Where `report` files its notes, and who is filing them. Absent when MCP_REPORT_TOOL is off. */
  feedback?: FeedbackSink;
}

export interface FeedbackSink {
  /** The server process taking the call: one per client session. */
  session: string | null;
  /** The client, "name/version" as it introduced itself. */
  client: string | null;
  append(report: AgentReport): Promise<void>;
  /** Reports already filed, to point out one the new report repeats. */
  existing?(): Promise<AgentReport[]>;
}

export interface McpToolResult {
  text: string;
  /** Reported to the client as `isError`, so the model sees the failure rather than a plain answer. */
  isError?: boolean;
  /** What the call found, for the event log (data/feedback/events.jsonl); never shown to the client. */
  trace?: Record<string, unknown>;
}

export type McpToolHandler = (args: Record<string, unknown>, ctx: McpContext) => Promise<McpToolResult>;

const FILTER_PROPERTIES = {
  source_type: {
    type: "array",
    items: { type: "string" },
    description:
      'Restrict to these source types: "devportal", "gitlab", "confluence", "adr" (the ADRs of oneplatform/adrs, ' +
      'which are not under "gitlab"), "manually-curated". Omit to search everything (the usual choice).',
  },
  kind: {
    type: "array",
    items: { type: "string", enum: ["doc", "code", "project", "api"] },
    description:
      'Restrict to these document kinds: "doc" prose documentation, "project" a repository card, "api" an OpenAPI/AsyncAPI/GraphQL ' +
        'definition (one section per operation and schema), "code" a source file (only when source code is indexed, which it is not by default).',
  },
  authority: {
    type: "array",
    items: { type: "string", enum: ["binding", "normative", "descriptive", "unknown"] },
    description: 'Restrict to these authority levels — ["binding","normative"] for ADRs and standards only.',
  },
  lang: { type: "array", items: { type: "string" }, description: 'Restrict to these languages, e.g. ["en"] or ["it"].' },
  contains: {
    type: "string",
    description:
      'Only passages containing this exact text, case-insensitive, like grep: an env var, error code, endpoint path, ' +
      'config key or class name, e.g. "ORDER_SERVICE_URL" or "/api/v1/orders". The query still ranks them. An empty ' +
      "result means no indexed passage contains it.",
  },
  modified_after: {
    type: "string",
    description:
      'Only documents last modified on or after this date: "2026-06-15", "2026-06" or "2026". Documents without a ' +
      "real edit date are left out: undated ones, and Dev Portal pages, whose date is the docs site's build. " +
      "Each result shows its last_modified and what that date is.",
  },
  modified_before: {
    type: "string",
    description: 'Only documents last modified before this date (exclusive), same formats: modified_after "2026-06" with modified_before "2026-07" is June.',
  },
} as const;

export const SEARCH_TOOL: Tool = {
  name: "search",
  title: "Search the OnePlatform knowledge base",
  description:
    "Search the TeamSystem OnePlatform knowledge base: Developer Portal documentation and API definitions, the " +
    "OnePlatform GitLab repositories (docs, API specs and project cards; not source code), ADRs and hand-written references. " +
    "Hybrid retrieval — embeddings plus BM25 — over the indexed passages; questions in Italian and English both " +
    "match. Returns the most relevant passages with their source_id, metadata and deep link. Use it before " +
    "answering anything about internal TeamSystem services, repositories, endpoints, settings or conventions, and " +
    "before saying the documentation does not cover something; then read the whole page with fetch_document. " +
    "Use `contains` to find an exact identifier and `modified_after` for what changed recently.",
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
    "truncated, so call again with `section` (a heading from the outline) or with the `offset` the reply gives. " +
    "An API definition comes as one section per operation (\"GET /items\") and per schema.",
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
          'Optional heading to return instead of the whole document, matched loosely against its headings, e.g. "Retry policy", ' +
          '"POST /api/v3/items" or a path when a heading repeats: "Ricerca delle gestite > Query Parameters".',
      },
      max_chars: {
        type: "integer",
        minimum: 500,
        description: `Character budget for the markdown returned (default ${config.mcp.docMaxChars}).`,
      },
      offset: {
        type: "integer",
        minimum: 0,
        description: "Start this many characters into the document (or the section): use the value a truncated reply gives.",
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

export const REPORT_TOOL: Tool = {
  name: "report",
  title: "Report a problem with the knowledge base",
  description:
    "File a note for the people who maintain this knowledge base. Call it when, while working, you find:\n" +
    '- "correction": a document that is wrong, outdated, or contradicted by the code, a test or another document;\n' +
    '- "gap": something the knowledge base should cover and does not, after searching for it in more than one way;\n' +
    '- "tip": a non-obvious way to find something — the term, filter or document that finally worked;\n' +
    '- "security": a page that publishes a credential (token, password, key, signed URL) or personal data — name the page, never copy the value;\n' +
    '- "indexing": this knowledge base\'s copy is broken while the source may be fine — a definition cut short, a table as raw HTML, a wrong label, a linked page missing.\n' +
    "One finding per report. Name the page to change in `target`, the words that are wrong in `quote` and the change in " +
    "`fix`; when two documents disagree and you cannot tell which is right, set `owner_decision`. Do not call it for " +
    "routine answers or to restate what a document says. A maintainer reviews every report before anything changes; " +
    "reports are not searchable and do not change your answer, so finish the task as usual.",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...REPORT_KINDS], description: "correction, gap, tip, security or indexing (see the tool description)." },
      note: {
        type: "string",
        description:
          "What you found, in a few sentences a maintainer can act on without this conversation: what the document " +
          "says, what is actually true or missing, and where it belongs. Write it in the language of the target document.",
      },
      question: { type: "string", description: "The question or task you were working on when you found it." },
      source_ids: {
        type: "array",
        items: { type: "string" },
        description:
          "Every document the note is about or rests on, exactly as search returned them: the one to change and the ones " +
          "that show it. Required except for a gap, where they are the pages that came closest.",
      },
      target: {
        type: "string",
        description: "The one document that should change, one of source_ids. Omit for a gap with no page to extend.",
      },
      section: { type: "string", description: "The heading of the target the note is about." },
      quote: { type: "string", description: "The exact words in the target that are wrong or outdated (short)." },
      fix: { type: "string", description: "What the target should say instead, or what to add — as you would write it." },
      owner_decision: {
        type: "boolean",
        description: "true when the documents disagree and only the team that owns them can say which one is right.",
      },
      evidence: {
        type: "string",
        description:
          "How you know beyond quoting source_ids: the code you read, a command and its output, an error message, " +
          "a source outside the knowledge base, and how much of each document you actually read.",
      },
      model: { type: "string", description: 'Your model id, e.g. "claude-opus-5-5".' },
    },
    required: ["kind", "note", "question", "model"],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
};

/** What the client is told this server is for; some clients show it to the model as system context. */
export const SERVER_INSTRUCTIONS =
  "Read-only access to the TeamSystem OnePlatform knowledge base (Developer Portal documentation and API " +
  "definitions, the OnePlatform GitLab repositories' documentation and project cards, ADRs, glossary). Everything here is " +
  "internal documentation that is not on the public web, so search it rather than answering from general " +
  "knowledge, and cite the source_id or the URL of the passages you used. Typical path: search(query) → " +
  "fetch_document(source_id) for the full page → related(source_id) when the topic continues elsewhere.";

/** Appended to SERVER_INSTRUCTIONS when `report` is offered. */
export const REPORT_INSTRUCTIONS =
  "When a document turns out to be wrong or outdated, or the knowledge base lacks something it should cover, " +
  "file it with report(kind, note, question, source_ids): it goes to the maintainers, not into search results.";

/** Tool specs the server advertises. `related` needs a graph on disk (`npm run graph`); `report` is MCP_REPORT_TOOL. */
export function mcpTools(opts: { graph?: boolean; report?: boolean } = {}): Tool[] {
  return [
    SEARCH_TOOL,
    FETCH_DOCUMENT_TOOL,
    ...(opts.graph === false ? [] : [RELATED_TOOL]),
    ...(opts.report === false ? [] : [REPORT_TOOL]),
  ];
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

/**
 * A date bound as the prefix `last_modified` is compared with: "2026", "2026-06" or "2026-06-15"; a
 * timestamp is cut to its day. Undefined when absent, null when it is not a date.
 */
function asDate(raw: string): string | null | undefined {
  if (!raw) return undefined;
  return /^\d{4}(?:-\d{2}(?:-\d{2})?)?(?=$|[T ])/.exec(raw)?.[0] ?? null;
}

function filtersFrom(args: Record<string, unknown>): { filters: RetrievalFilters; described: string; problem?: string } {
  const rawAfter = asString(args, "modified_after", "modifiedAfter", "since");
  const rawBefore = asString(args, "modified_before", "modifiedBefore", "until");
  const after = asDate(rawAfter);
  const before = asDate(rawBefore);
  // Not trimmed: a leading space can be part of what the client is looking for.
  const contains = pick(args, "contains", "exact");
  const filters: RetrievalFilters = {
    sourceTypes: asList(args, "source_type", "sourceTypes", "source_types"),
    kinds: asList(args, "kind", "kinds"),
    authorities: asList(args, "authority", "authorities") as Authority[] | undefined,
    langs: asList(args, "lang", "langs"),
    modifiedAfter: after ?? undefined,
    modifiedBefore: before ?? undefined,
    contains: typeof contains === "string" && contains.trim() ? contains : undefined,
  };
  const described = [
    ...Object.entries({
      source_type: filters.sourceTypes,
      kind: filters.kinds,
      authority: filters.authorities,
      lang: filters.langs,
    }).flatMap(([k, v]) => (v ? [`${k}=${v.join("|")}`] : [])),
    filters.modifiedAfter ? `modified_after=${filters.modifiedAfter}` : "",
    filters.modifiedBefore ? `modified_before=${filters.modifiedBefore}` : "",
    filters.contains ? `contains="${filters.contains}"` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const bad = after === null ? ["modified_after", rawAfter] : before === null ? ["modified_before", rawBefore] : null;
  const problem = bad ? `${bad[0]} must be a date like "2026-06-15", "2026-06" or "2026" (got "${bad[1]}").` : undefined;
  return { filters, described, problem };
}

// ---- formatting ----------------------------------------------------------------------------------

/**
 * What a document's last_modified is, where it is not the page's own last edit: sync stamps a Dev Portal
 * page with its TechDocs build, and a project card or API definition with the repository's latest commit.
 */
function lastModifiedField(date: string | null, sourceType: string, kind: string): string {
  if (!date) return "";
  const note =
    sourceType === "devportal" && kind === "doc" ? " (docs site build)" : sourceType === "gitlab" && kind !== "doc" ? " (repository's latest commit)" : "";
  return ` last_modified=${date}${note}`;
}

const SEPARATOR = "\n\n----------------------------------------\n\n";

const RETRY_HINT =
  "Try different words: a service, repository, endpoint or setting name; an acronym or its expansion; the term in " +
  "the other language (Italian/English).";

/** One passage: a header the model can cite from, then the passage text flush-left (it may be code). */
/** ` status=deprecated ("Deprecated — as of 2025-06-01")` for a decision record, so a stale ADR does not read as a rule. */
function statusField(info: AdrStatusInfo | null | undefined): string {
  return info ? ` status=${info.status}${info.raw && info.raw.toLowerCase() !== info.status ? ` ("${info.raw}")` : ""}` : "";
}

function formatChunk(c: RetrievedChunk, i: number, status?: AdrStatusInfo | null): string {
  const ranks = [c.vectorRank ? `vector #${c.vectorRank}` : "", c.bm25Rank ? `bm25 #${c.bm25Rank}` : ""].filter(Boolean).join(", ");
  const url = deepLink(c);
  const lines = [
    `${i}. ${c.title}${c.headingPath && c.headingPath !== c.title ? ` — ${c.headingPath}` : ""}`,
    `   source_id: ${c.sourceId}`,
    `   source_type=${c.sourceType} kind=${c.kind} authority=${c.authority}${statusField(status)} lang=${c.lang}` +
      `${lastModifiedField(c.lastModified, c.sourceType, c.kind)}` +
      `${c.lineStart ? ` lines=${c.lineStart}-${c.lineEnd ?? c.lineStart}` : ""}`,
    `   score=${c.score.toFixed(4)}${ranks ? ` (${ranks})` : ""}`,
    url ? `   url: ${url}` : `   kb path: ${c.relPath}`,
    c.duplicates?.length ? `   same text also in: ${c.duplicates.join(", ")}` : "",
  ].filter(Boolean);
  return `${lines.join("\n")}\n\n${c.content.trim()}`;
}

/** A fetched document as the client reads it: metadata, how much of it this is, outline, markdown. */
export function formatDocument(doc: FetchedDocument): string {
  const url = deepLink({ sourceUrl: doc.sourceUrl, kind: doc.kind, lineStart: null, lineEnd: null });
  const scope = doc.section ? `section "${doc.section}"` : doc.offset ? "document" : "full document";
  const from = doc.offset ? `from offset ${doc.offset}, ` : "";
  const next = doc.nextOffset !== null ? `offset=${doc.nextOffset}` : "";
  const size = doc.truncated
    ? `${from}${doc.returnedChars} of ${doc.totalChars} chars — TRUNCATED, call fetch_document again with ` +
      (doc.outline.length && !doc.section ? `a \`section\` from the outline below or ${next}` : next) +
      " to read further"
    : `${from}${doc.returnedChars} chars`;
  const header = [
    doc.title,
    `source_id: ${doc.sourceId}`,
    `source_type=${doc.sourceType} kind=${doc.kind} authority=${doc.authority}${statusField(doc.adrStatus)} lang=${doc.lang}` +
      lastModifiedField(doc.lastModified, doc.sourceType, doc.kind),
    url ? `url: ${url}` : `kb path: ${doc.relPath}`,
    doc.sectionNotFound
      ? `no section matching "${doc.sectionNotFound}" — returning the ${scope}, ${size}`
      : `${scope}, ${size}`,
    doc.sectionAlternatives.length
      ? `the same heading also appears as: ${doc.sectionAlternatives.map((a) => `"${a}"`).join(", ")} — ask for one of them by its path`
      : "",
    doc.cutAtSync
      ? `stored copy incomplete: sync kept ${doc.cutAtSync.kept} of ${doc.cutAtSync.total} chars of this definition, so a path or schema missing here may still exist`
      : "",
    doc.outline.length
      ? `outline${doc.outline.length > 60 ? ` (first 60 of ${doc.outline.length})` : ""}: ${doc.outline.slice(0, 60).join(" · ")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `${header}\n\n${doc.content}`;
}

// ---- search --------------------------------------------------------------------------------------

/** The index's facet values, read once per searcher (a full column scan each time otherwise). */
const facetCache = new WeakMap<Searcher, Promise<Awaited<ReturnType<NonNullable<Searcher["facets"]>>> | null>>();
function facetsOf(searcher: Searcher): Promise<Awaited<ReturnType<NonNullable<Searcher["facets"]>>> | null> {
  let hit = facetCache.get(searcher);
  if (!hit) {
    hit = searcher.facets ? searcher.facets().catch(() => null) : Promise.resolve(null);
    facetCache.set(searcher, hit);
  }
  return hit;
}

const runSearch: McpToolHandler = async (args, ctx) => {
  const topK = asInt(args, config.mcp.searchTopK, 1, config.mcp.maxTopK, "top_k", "topK", "k", "limit");
  const { filters, described, problem } = filtersFrom(args);
  if (problem) return { isError: true, text: problem };
  // A typo in source_type or lang silently matches nothing; say which values exist instead.
  if ((filters.sourceTypes?.length || filters.langs?.length || filters.kinds?.length) && ctx.searcher.facets) {
    const facets = await facetsOf(ctx.searcher);
    for (const [name, asked, known] of [
      ["source_type", filters.sourceTypes, facets?.sourceTypes],
      ["lang", filters.langs, facets?.langs],
      ["kind", filters.kinds, facets?.kinds],
    ] as const) {
      const unknown = known ? (asked ?? []).filter((v) => !(v in known)) : [];
      if (unknown.length) {
        return { isError: true, text: `${name} ${unknown.map((v) => `"${v}"`).join(", ")} is not in the index; it has ${Object.keys(known ?? {}).map((v) => `"${v}"`).join(", ")}.` };
      }
    }
  }
  // A bare `contains` is a grep: the text itself ranks the passages that contain it.
  const query = asString(args, "query", "q", "question") || filters.contains?.trim() || "";
  if (!query) return { isError: true, text: "search needs a `query`." };

  let chunks: RetrievedChunk[];
  try {
    // No LLM rerank: it would spend the local chat model on a request that came here to avoid it.
    chunks = await ctx.searcher.retrieve(query, { topK, filters, noRerank: true });
  } catch (err) {
    return { isError: true, text: `Search failed: ${(err as Error).message}` };
  }

  const scope = described ? ` (filters: ${described})` : "";
  if (!chunks.length) {
    // Every filter is applied before ranking, so an empty result is a fact about the index, not a ranking miss.
    const { contains, ...others } = filters;
    const narrowed = Object.values(others).some((v) => v !== undefined);
    const dated = Boolean(filters.modifiedAfter || filters.modifiedBefore);
    const hint = contains && dated
      ? `No passage both contains "${contains}" and has a last_modified date in the range. Documents without a date are ` +
        `left out by a date filter, so drop the date first; if that still finds nothing, the text is not indexed.`
      : contains
      ? `No indexed passage contains the exact text "${contains}"${narrowed ? " within the other filters" : ""}; drop \`contains\` to search by meaning.`
      : dated
        ? `Only documents with a real edit date inside the range are searched (Dev Portal pages, dated by their docs build, never are); widen it or drop it. ${RETRY_HINT}`
        : RETRY_HINT;
    return { text: `No passages matched "${query}"${scope}. ${hint}`, trace: { query, returned: 0 } };
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
  // Fused scores are ranks, so they cannot say "nothing here is about this"; the cosine similarity of the
  // best passage can, roughly. Short keyword queries and exact-text searches score low anyway: no hint there.
  const best = Math.max(...chunks.map((c) => c.similarity ?? 0));
  const weak = !filters.contains && query.trim().split(/\s+/).length >= 3 && best > 0 && best < config.mcp.weakMatchSimilarity;
  const header =
    (weak
      ? `Weak match: the closest passage is only loosely related (similarity ${best.toFixed(2)}; passages that answer a question ` +
        `usually score above 0.70). ` +
        (described
          ? `The filters may be what leaves the answer out — try without them before concluding anything.\n`
          : `The knowledge base may not cover this — try other wording or the other language, and if it still is not there, ` +
            `that is a gap worth reporting.\n`)
      : "") +
    `${kept.length} passage${kept.length === 1 ? "" : "s"} for "${query}"${scope}` +
    `${dropped ? `, ${dropped} more left out to stay inside the size budget (ask for a smaller top_k to see them ranked lower)` : ""}.` +
    ` Read a whole page with fetch_document(source_id); list the pages connected to it with related(source_id).`;

  const statuses = await Promise.all(kept.map((c) => (isAdrLike(c.sourceId, c.sourceType, c.title) ? ctx.store.adrStatus(c.sourceId) : null)));
  return {
    text: `${header}${SEPARATOR}${kept.map((c, i) => formatChunk(c, i + 1, statuses[i])).join(SEPARATOR)}`,
    trace: {
      query,
      returned: kept.length,
      dropped,
      best_similarity: best > 0 ? Number(best.toFixed(3)) : null,
      weak,
      hits: kept.map((c) => ({ source_id: c.sourceId, score: Number(c.score.toFixed(4)), vector_rank: c.vectorRank, bm25_rank: c.bm25Rank })),
    },
  };
};

// ---- fetch_document ------------------------------------------------------------------------------

const runFetchDocument: McpToolHandler = async (args, ctx) => {
  const requested = asString(args, "source_id", "sourceId", "id");
  if (!requested) return { isError: true, text: "fetch_document needs a `source_id` (as shown in a search result)." };
  const section = asString(args, "section") || null;
  const maxChars = asInt(args, config.mcp.docMaxChars, 500, 500_000, "max_chars", "maxChars");
  const offset = asInt(args, 0, 0, Number.MAX_SAFE_INTEGER, "offset");

  try {
    const doc = await ctx.store.fetch(requested, { section, maxChars, offset });
    return {
      text: formatDocument(doc),
      trace: { source_id: doc.sourceId, section: doc.section, section_not_found: doc.sectionNotFound, truncated: doc.truncated, offset: doc.offset },
    };
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

  let all = graph.neighbors(target, { ...(relations ? { relations } : {}), maxHubSize: config.graph.maxHubSize });
  // "all" skips groups too big to be a hint (GRAPH_MAX_HUB_SIZE). When that leaves room, fill it from the
  // same place anyway, smallest groups first: "all" must never list less than "same_place" would.
  if (scope === "all" && all.length < limit) {
    const seen = new Set(all.map((n) => n.sourceId));
    const place = graph.neighbors(target, { relations: SCOPES["same_place"] as Relation[], maxHubSize: config.graph.maxHubSize });
    all = [...all, ...place.filter((n) => !seen.has(n.sourceId))];
  }
  const kept = all.slice(0, limit);
  // Links the page makes to pages the index does not have: "this page points at X, which is missing" is
  // often the answer to a gap, and fetch_document cannot read them.
  const dangling = scope === "same_place" ? [] : graph.brokenLinksFrom(target).filter((b) => RESOLUTION_REASONS[b.reason]?.internal);

  // Where the page sits, in words — "part of the Workspace module" without handing out hub ids that
  // no tool would accept.
  const hubs = graph
    .hubsOf(target)
    .filter((h) => h.type !== "tag")
    .slice(0, 4)
    .map((h) => `${h.label} (${h.type}, ${h.size} documents)`);

  const danglingSection = dangling.length
    ? `links to pages that are not indexed (fetch_document cannot read them; if one holds what you need, that is a gap):\n` +
      dangling
        .slice(0, 20)
        .map((b) => `- ${b.text ? `${b.text} — ` : ""}${b.href} (${RESOLUTION_REASONS[b.reason]?.what ?? b.reason})`)
        .join("\n")
    : "";

  if (!kept.length) {
    return {
      text:
        `No indexed documents are connected to "${node.label}" (${target})${hubs.length ? `. It sits in: ${hubs.join(", ")}` : ""}. ` +
        `Use search(query) with different words instead.${danglingSection ? `\n\n${danglingSection}` : ""}`,
      trace: { source_id: target, returned: 0, dangling: dangling.length },
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
    `${all.length > kept.length ? ` — ${kept.length} of ${all.length}: direct links first, then the smallest groups (alphabetical within a group); raise \`limit\` for more` : ""}.` +
    `${hubs.length ? ` It sits in: ${hubs.join(", ")}.` : ""}` +
    ` Read any of them with fetch_document(source_id), except the ones marked as not indexed.`;

  const sections = [...groups.entries()].map(
    ([phrase, rows]) => `${phrase}:\n${rows.map((n) => relatedLine(n, ctx.store.resolve(n.sourceId) !== null)).join("\n")}`,
  );
  if (danglingSection) sections.push(danglingSection);
  return {
    text: `${header}\n\n${sections.join("\n\n")}`,
    trace: { source_id: target, returned: kept.length, total: all.length, dangling: dangling.length },
  };
};

// ---- report --------------------------------------------------------------------------------------

const NOTE_MAX_CHARS = 40000;
const REPORT_MAX_SOURCES = 10;

/** "Correction", "gaps" and "TIP" are all a kind; anything else is not. */
function asKind(raw: string): ReportKind | null {
  const k = raw.toLowerCase().replace(/s$/, "");
  return (REPORT_KINDS as readonly string[]).includes(k) ? (k as ReportKind) : null;
}

/**
 * File a note. Strict on purpose: a report nobody can act on, or one pinned to a document that does
 * not exist, costs the reviewer more than it gives, and the client can fix its call from the error.
 * Every source_id is resolved and stamped with the hashes of the version that is indexed now, so a
 * review can tell whether the page has changed since — which is why a correction or a tip without
 * one is refused.
 */
const runReport: McpToolHandler = async (args, ctx) => {
  if (!ctx.feedback) return { isError: true, text: "report is turned off on this server (MCP_REPORT_TOOL=false)." };

  const rawKind = asString(args, "kind", "type");
  const kind = asKind(rawKind);
  const note = asString(args, "note", "text", "comment");
  const question = asString(args, "question", "task");
  const evidence = asString(args, "evidence") || null;
  const model = asString(args, "model") || "unknown";
  const requested = asList(args, "source_ids", "sourceIds", "source_id", "sources") ?? [];
  const rawTarget = asString(args, "target", "target_source_id") || null;
  const section = asString(args, "section") || null;
  const quote = asString(args, "quote") || null;
  const fix = asString(args, "fix", "proposed_fix", "suggestion") || null;
  const ownerDecision = args["owner_decision"] === true || args["owner_decision"] === "true";
  // The target is one of the documents even when the agent forgot to list it twice.
  if (rawTarget && !requested.includes(rawTarget)) requested.unshift(rawTarget);

  const problems = [
    kind ? "" : `\`kind\` must be one of ${REPORT_KINDS.join(", ")}${rawKind ? ` (got "${rawKind}")` : ""}.`,
    note ? "" : "`note` is required: what you found, specific enough to act on without this conversation.",
    note.length > NOTE_MAX_CHARS ? `\`note\` is ${note.length} characters; keep it under ${NOTE_MAX_CHARS}.` : "",
    question ? "" : "`question` is required: the question or task you were working on.",
    kind && kind !== "gap" && !requested.length
      ? `A ${kind} needs the documents it is about in \`source_ids\`, exactly as search returned them.`
      : "",
    requested.length > REPORT_MAX_SOURCES ? `At most ${REPORT_MAX_SOURCES} source_ids per report.` : "",
  ];

  const sources: ReportSource[] = [];
  for (const id of requested.slice(0, REPORT_MAX_SOURCES)) {
    const sourceId = ctx.store.resolve(id);
    if (!sourceId) {
      const near = ctx.store.suggest(id, 3);
      problems.push(`"${id}" is not a document in the knowledge base${near.length ? ` — did you mean ${near.join(", ")}?` : "; use a source_id from a search result."}`);
    } else if (!sources.some((s) => s.source_id === sourceId)) {
      const entry = ctx.store.entry(sourceId);
      const onDisk = await ctx.store.fileHash(sourceId);
      sources.push({
        source_id: sourceId,
        content_hash: entry?.contentHash ?? null,
        embed_hash: entry?.embedHash ?? null,
        ...(onDisk && entry?.contentHash && onDisk !== entry.contentHash ? { kb_hash: onDisk } : {}),
      });
    }
  }
  const target = rawTarget ? ctx.store.resolve(rawTarget) : null;

  const refused = problems.filter(Boolean);
  if (refused.length || !kind) return { isError: true, text: `Report not recorded. ${refused.join(" ")}` };

  const report: AgentReport = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    status: "new",
    kind,
    note,
    question,
    evidence,
    sources,
    ...(target ? { target } : {}),
    ...(section ? { section } : {}),
    ...(quote ? { quote } : {}),
    ...(fix ? { fix } : {}),
    ...(ownerDecision ? { owner_decision: true } : {}),
    model,
    session: ctx.feedback.session,
    client: ctx.feedback.client,
  };

  // Reports on the same page, so a second agent does not file the first one's finding again.
  const about = new Set(target ? [target] : sources.map((s) => s.source_id));
  const earlier = ctx.feedback.existing
    ? (await ctx.feedback.existing().catch(() => [] as AgentReport[]))
        .filter((r) => r.status === "new" && (r.target ? about.has(r.target) : r.sources.some((s) => about.has(s.source_id))))
        .slice(-3)
    : [];

  try {
    await ctx.feedback.append(report);
  } catch (err) {
    return { isError: true, text: `Could not record the report: ${(err as Error).message}` };
  }

  const ids = sources.map((s) => s.source_id);
  const stale = sources.filter((s) => s.kb_hash).map((s) => s.source_id);
  const lines = [
    `Recorded ${kind} report ${report.id}` +
      (target ? ` on ${target}${ids.length > 1 ? ` (with ${ids.length - 1} more document${ids.length > 2 ? "s" : ""} as evidence)` : ""}` : ids.length ? ` on ${ids.join(", ")}` : "") +
      ". A maintainer reviews it before anything changes in the knowledge base, and it does not show up in search.",
    stale.length ? `Note: ${stale.join(", ")} changed on disk since it was indexed; the report keeps both versions' hashes.` : "",
    earlier.length
      ? `Already filed on the same page: ${earlier.map((r) => `${r.id.slice(0, 8)} (${r.kind}, ${r.ts.slice(0, 10)}): "${r.note.replace(/\s+/g, " ").slice(0, 140)}…"`).join("; ")}. ` +
        "If yours repeats one of them there is no need to file it again; if it adds something, it is recorded."
      : "",
    "Carry on with the task.",
  ];
  return {
    text: lines.filter(Boolean).join(" "),
    trace: { report_id: report.id, kind, source_ids: ids, target, earlier: earlier.map((r) => r.id) },
  };
};

const HANDLERS: Record<string, McpToolHandler> = {
  [SEARCH_TOOL.name]: runSearch,
  [FETCH_DOCUMENT_TOOL.name]: runFetchDocument,
  [RELATED_TOOL.name]: runRelated,
  [REPORT_TOOL.name]: runReport,
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
