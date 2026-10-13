import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { KbGraph, RELATIONS, type KbGraphFile } from "../src/graph/index.js";
import type { AgentReport } from "../src/feedback/index.js";
import {
  FETCH_DOCUMENT_TOOL,
  RELATED_TOOL,
  REPORT_TOOL,
  SEARCH_TOOL,
  mcpTools,
  runMcpTool,
  type FeedbackSink,
  type McpContext,
  type Searcher,
} from "../src/mcp/tools.js";
import {
  DEFAULT_SERVER_NAME,
  bundleFile,
  desktopConfigPath,
  formatConfig,
  mergeServer,
  parseDesktopConfig,
  serverEntry,
} from "../src/mcp/desktop-config.js";
import { DocumentStore } from "../src/retrieval/documents.js";
import type { RetrievedChunk } from "../src/types.js";

const ADR = `---
source_id: "adr:client-credentials"
source_type: adr
title: ADR0010 Client Credentials
authority: binding
source_url: "https://example.com/adr0010"
lang: en
last_modified: "2026-02-01"
---

# ADR0010 Client Credentials

## Decision

Use client credentials for service-to-service calls.

## Consequences

The old M2M token is deprecated. Existing integrations keep working until the deadline, new ones
must use client credentials, and the platform team tracks the migration per service. This section
is padded so the whole page is comfortably longer than the 500-character floor that a fetch always
returns, which is what makes the truncation branch observable in a test. A couple more lines of
padding keep the page over that floor even after the frontmatter is stripped and blank lines are
collapsed by the loader, so the budget branch is the one under test rather than the floor.
`;

const CODE = `---
source_id: "gitlab:oneplatform/gateway:src/auth.ts"
source_type: gitlab
kind: code
title: src/auth.ts
authority: descriptive
source_url: "https://biosphere.teamsystem.com/oneplatform/gateway/-/blob/main/src/auth.ts"
lang: en
---

# src/auth.ts

\`\`\`ts
export const grant = "client_credentials";
\`\`\`
`;

const chunk = (over: Partial<RetrievedChunk> = {}): RetrievedChunk => ({
  id: "adr:client-credentials#1",
  sourceId: "adr:client-credentials",
  sourceType: "adr",
  kind: "doc",
  title: "ADR0010 Client Credentials",
  sourceUrl: "https://example.com/adr0010",
  authority: "binding",
  lang: "en",
  relPath: "adr/client-credentials.md",
  ordinal: 1,
  headingPath: "ADR0010 Client Credentials > Decision",
  content: "Use client credentials for service-to-service calls.",
  lineStart: null,
  lineEnd: null,
  lastModified: "2026-02-01",
  score: 0.0312,
  vectorRank: 2,
  bm25Rank: 5,
  ...over,
});

/** A searcher that records what it was asked for and replays a fixed list. */
function stubSearcher(results: RetrievedChunk[]): Searcher & { calls: { query: string; opts: unknown }[] } {
  const calls: { query: string; opts: unknown }[] = [];
  return {
    calls,
    async retrieve(query, opts) {
      calls.push({ query, opts });
      return results.slice(0, opts?.topK ?? results.length);
    },
  };
}

/** adr:client-credentials links to a wiki page that is NOT indexed, and shares a repo with the code file. */
function stubGraph(): KbGraph {
  const nodes = [
    { id: "adr:client-credentials", type: "doc" as const, label: "ADR0010 Client Credentials" },
    { id: "confluence:CTO:805961883", type: "doc" as const, label: "ADR0010 in the wiki" },
    { id: "gitlab:oneplatform/gateway:src/auth.ts", type: "doc" as const, label: "src/auth.ts" },
    { id: "repo:oneplatform/gateway", type: "repo" as const, label: "gateway" },
  ];
  const rel = (r: string): number => RELATIONS.indexOf(r as never);
  const edges = {
    from: [0, 0, 2],
    to: [1, 3, 3],
    rel: [rel("links_to"), rel("in_repo"), rel("in_repo")],
  };
  const file: KbGraphFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    docs: 3,
    nodes,
    relations: [...RELATIONS],
    edges,
    brokenLinks: [],
    stats: { nodes: nodes.length, edges: edges.from.length, byRelation: {}, unresolved: {}, scopeGaps: {}, connectedDocs: 3, largestComponent: 3, brokenLinksTotal: 0, durationMs: 1 },
  };
  return new KbGraph(file);
}

let store: DocumentStore;

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ai-wiki-mcp-"));
  const kbDir = path.join(root, "kb");
  await mkdir(path.join(kbDir, "adr"), { recursive: true });
  await mkdir(path.join(kbDir, "gitlab"), { recursive: true });
  await writeFile(path.join(kbDir, "adr", "client-credentials.md"), ADR, "utf8");
  await writeFile(path.join(kbDir, "gitlab", "auth.md"), CODE, "utf8");
  const manifest = path.join(root, "manifest.json");
  await writeFile(
    manifest,
    JSON.stringify({
      version: 1,
      docs: {
        "adr:client-credentials": { sourceId: "adr:client-credentials", relPath: "adr/client-credentials.md", contentHash: "c-adr", embedHash: "e-adr" },
        "gitlab:oneplatform/gateway:src/auth.ts": { sourceId: "gitlab:oneplatform/gateway:src/auth.ts", relPath: "gitlab/auth.md" },
      },
    }),
    "utf8",
  );
  store = await DocumentStore.open(manifest, kbDir);
});

const ctxWith = (searcher: Searcher, graph: KbGraph | null = stubGraph(), feedback?: FeedbackSink): McpContext => ({
  searcher,
  store,
  graph: () => Promise.resolve(graph),
  ...(feedback ? { feedback } : {}),
});

/** A feedback sink that keeps what it was given. */
function memorySink(): FeedbackSink & { reports: AgentReport[] } {
  const reports: AgentReport[] = [];
  return { session: "s-1", client: "claude-code/2.1.0", reports, append: async (r) => void reports.push(r) };
}

describe("the advertised tool set", () => {
  it("is retrieval plus report — there is no way to make the server generate an answer", () => {
    expect(mcpTools().map((t) => t.name)).toEqual(["search", "fetch_document", "related", "report"]);
    for (const tool of mcpTools({ report: false })) expect(tool.annotations?.readOnlyHint).toBe(true);
    // report writes only to the feedback log, and never deletes.
    expect(REPORT_TOOL.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it("hides `related` when the graph has not been built, and `report` when it is turned off", () => {
    expect(mcpTools({ graph: false, report: false }).map((t) => t.name)).toEqual(["search", "fetch_document"]);
  });

  it("requires the arguments the handlers insist on", () => {
    expect(SEARCH_TOOL.inputSchema.required).toEqual(["query"]);
    expect(FETCH_DOCUMENT_TOOL.inputSchema.required).toEqual(["source_id"]);
    expect(RELATED_TOOL.inputSchema.required).toEqual(["source_id"]);
    expect(REPORT_TOOL.inputSchema.required).toEqual(["kind", "note", "question", "model"]);
  });
});

describe("the trace each call leaves for the event log", () => {
  it("records what a search returned, rank by rank", async () => {
    const out = await runMcpTool("search", { query: "client credentials" }, ctxWith(stubSearcher([chunk()])));
    expect(out.trace).toEqual({
      query: "client credentials",
      returned: 1,
      dropped: 0,
      best_similarity: null,
      weak: false,
      hits: [{ source_id: "adr:client-credentials", score: 0.0312, vector_rank: 2, bm25_rank: 5 }],
    });
    const empty = await runMcpTool("search", { query: "leave days" }, ctxWith(stubSearcher([])));
    expect(empty.trace).toEqual({ query: "leave days", returned: 0 });
  });

  it("records which document a fetch resolved to", async () => {
    const out = await runMcpTool("fetch_document", { source_id: "adr/client-credentials.md", section: "nope" }, ctxWith(stubSearcher([])));
    expect(out.trace).toMatchObject({ source_id: "adr:client-credentials", section: null, section_not_found: "nope" });
  });
});

describe("search", () => {
  it("returns the passage with the handles a client needs to cite and follow it", async () => {
    const searcher = stubSearcher([chunk()]);
    const out = await runMcpTool("search", { query: "client credentials" }, ctxWith(searcher));
    expect(out.isError).toBeUndefined();
    expect(out.text).toContain('1 passage for "client credentials"');
    expect(out.text).toContain("source_id: adr:client-credentials");
    expect(out.text).toContain("source_type=adr kind=doc authority=binding lang=en");
    expect(out.text).toContain("score=0.0312 (vector #2, bm25 #5)");
    expect(out.text).toContain("url: https://example.com/adr0010");
    expect(out.text).toContain("Use client credentials for service-to-service calls.");
    // The local chat model is not in this path, so the rerank that would call it is off.
    expect(searcher.calls[0]?.opts).toMatchObject({ noRerank: true });
  });

  it("anchors a code passage on its line range and deep-links to the blob", async () => {
    const code = chunk({
      sourceId: "gitlab:oneplatform/gateway:src/auth.ts",
      kind: "code",
      title: "src/auth.ts",
      sourceUrl: "https://biosphere.teamsystem.com/oneplatform/gateway/-/blob/main/src/auth.ts",
      headingPath: "gateway > src/auth.ts > grant",
      lineStart: 12,
      lineEnd: 20,
    });
    const out = await runMcpTool("search", { query: "grant" }, ctxWith(stubSearcher([code])));
    expect(out.text).toContain("lines=12-20");
    expect(out.text).toContain("/-/blob/main/src/auth.ts#L12-20");
  });

  it("passes filters through, however the client spelled them, and says which it applied", async () => {
    const searcher = stubSearcher([chunk()]);
    const out = await runMcpTool(
      "search",
      { query: "tokens", source_type: "adr, gitlab", kinds: ["doc"], authority: ["binding"], top_k: "1" },
      ctxWith(searcher),
    );
    expect(searcher.calls[0]?.opts).toMatchObject({
      topK: 1,
      filters: { sourceTypes: ["adr", "gitlab"], kinds: ["doc"], authorities: ["binding"], langs: undefined },
    });
    expect(out.text).toContain("filters: source_type=adr|gitlab kind=doc authority=binding");
  });

  it("says what each last_modified date is, since not every source dates the page itself", async () => {
    const out = await runMcpTool(
      "search",
      { query: "x" },
      ctxWith(
        stubSearcher([
          chunk(),
          chunk({ id: "p#0", sourceId: "devportal:default/component/hermes/", sourceType: "devportal", lastModified: "2026-09-21" }),
          chunk({ id: "c#0", sourceId: "gitlab:oneplatform/gateway:__project", sourceType: "gitlab", kind: "project", lastModified: "2026-09-22" }),
          chunk({ id: "n#0", sourceId: "devportal:default/api/orders", sourceType: "devportal", kind: "api", lastModified: null }),
        ]),
      ),
    );
    expect(out.text).toContain("lang=en last_modified=2026-02-01\n");
    expect(out.text).toContain("last_modified=2026-09-21 (docs site build)");
    expect(out.text).toContain("last_modified=2026-09-22 (repository's latest commit)");
    expect(out.text).toContain("source_type=devportal kind=api authority=binding lang=en\n");
  });

  it("passes the date range and the literal text through, and says it applied them", async () => {
    const searcher = stubSearcher([chunk()]);
    const out = await runMcpTool(
      "search",
      { query: "order service", contains: "ORDER_SERVICE_URL", modified_after: "2026-06", modified_before: "2026-07-15T08:00:00Z" },
      ctxWith(searcher),
    );
    expect(searcher.calls[0]?.opts).toMatchObject({
      filters: { contains: "ORDER_SERVICE_URL", modifiedAfter: "2026-06", modifiedBefore: "2026-07-15" },
    });
    expect(out.text).toContain('filters: modified_after=2026-06 modified_before=2026-07-15 contains="ORDER_SERVICE_URL"');
  });

  it("searches for the literal text itself when `contains` comes without a query", async () => {
    const searcher = stubSearcher([chunk()]);
    await runMcpTool("search", { contains: "ORDER_SERVICE_URL" }, ctxWith(searcher));
    expect(searcher.calls[0]?.query).toBe("ORDER_SERVICE_URL");
  });

  it("rejects a date it cannot compare instead of silently searching everything", async () => {
    const searcher = stubSearcher([chunk()]);
    const out = await runMcpTool("search", { query: "x", modified_after: "last week" }, ctxWith(searcher));
    expect(out).toMatchObject({ isError: true });
    expect(out.text).toContain('modified_after must be a date like "2026-06-15"');
    expect(searcher.calls).toHaveLength(0);
    const aliased = await runMcpTool("search", { query: "x", until: "soon" }, ctxWith(searcher));
    expect(aliased.text).toContain('modified_before must be a date like "2026-06-15", "2026-06" or "2026" (got "soon")');
  });

  it("reads an empty `contains` result as the text not being in the index", async () => {
    const out = await runMcpTool("search", { query: "x", contains: "NOPE_NOT_HERE" }, ctxWith(stubSearcher([])));
    expect(out.text).toContain('No indexed passage contains the exact text "NOPE_NOT_HERE"; drop `contains`');
    const narrowed = await runMcpTool("search", { query: "x", contains: "NOPE", kind: ["api"] }, ctxWith(stubSearcher([])));
    expect(narrowed.text).toContain('"NOPE" within the other filters');
  });

  it("clamps top_k to the configured ceiling instead of trusting the client", async () => {
    const searcher = stubSearcher([chunk()]);
    await runMcpTool("search", { query: "x", top_k: 5000 }, ctxWith(searcher));
    expect((searcher.calls[0]?.opts as { topK: number }).topK).toBeLessThanOrEqual(25);
  });

  it("stays inside the size budget, and says how many passages it left out", async () => {
    const big = Array.from({ length: 40 }, (_, i) =>
      chunk({ id: `c${i}`, sourceId: `doc:${i}`, content: "x".repeat(5000), vectorRank: i + 1, bm25Rank: null }),
    );
    const out = await runMcpTool("search", { query: "everything", top_k: 25 }, ctxWith(stubSearcher(big)));
    expect(out.text.length).toBeLessThan(70_000);
    expect(out.text).toContain("left out to stay inside the size budget");
  });

  it("says nothing matched, with a hint, rather than returning an empty result", async () => {
    const out = await runMcpTool("search", { query: "kubernetes on mars" }, ctxWith(stubSearcher([])));
    expect(out.isError).toBeUndefined();
    expect(out.text).toContain('No passages matched "kubernetes on mars"');
    expect(out.text).toContain("acronym or its expansion");
  });

  it("reports a missing query and a broken index as tool errors, not as answers", async () => {
    expect(await runMcpTool("search", {}, ctxWith(stubSearcher([])))).toMatchObject({ isError: true });
    const broken: Searcher = { retrieve: () => Promise.reject(new Error("The index is empty. Run `npm run ingest` first.")) };
    const out = await runMcpTool("search", { query: "x" }, ctxWith(broken));
    expect(out.isError).toBe(true);
    expect(out.text).toContain("npm run ingest");
  });
});

describe("fetch_document", () => {
  it("returns the page with its metadata, outline and markdown", async () => {
    const out = await runMcpTool("fetch_document", { source_id: "adr:client-credentials" }, ctxWith(stubSearcher([])));
    expect(out.isError).toBeUndefined();
    expect(out.text).toContain("source_id: adr:client-credentials");
    expect(out.text).toContain("last_modified=2026-02-01");
    expect(out.text).toContain("outline: Decision · Consequences");
    expect(out.text).toContain("The old M2M token is deprecated.");
  });

  it("narrows to a section, matched loosely", async () => {
    const out = await runMcpTool("fetch_document", { source_id: "adr:client-credentials", section: "decision" }, ctxWith(stubSearcher([])));
    expect(out.text).toContain('section "Decision"');
    expect(out.text).toContain("Use client credentials for service-to-service calls.");
    expect(out.text).not.toContain("The old M2M token is deprecated.");
  });

  it("tells the client how to read the rest when the budget cut the page", async () => {
    const out = await runMcpTool("fetch_document", { source_id: "adr:client-credentials", max_chars: 600 }, ctxWith(stubSearcher([])));
    expect(out.text).toContain("TRUNCATED");
    expect(out.text).toContain("`section`");
  });

  it("fails with the suggestions the store found for a wrong id", async () => {
    const out = await runMcpTool("fetch_document", { source_id: "adr:client-credential" }, ctxWith(stubSearcher([])));
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Closest ids: adr:client-credentials");
  });
});

describe("weak matches", () => {
  it("says so when even the best passage is far from a real question", async () => {
    const far = { ...chunk(), similarity: 0.58 };
    const out = await runMcpTool("search", { query: "which Cosmos DB consistency level must a service use" }, ctxWith(stubSearcher([far])));
    expect(out.text).toMatch(/^Weak match: the closest passage is only loosely related \(similarity 0\.58/);
    expect(out.trace).toMatchObject({ weak: true, best_similarity: 0.58 });
    const close = await runMcpTool("search", { query: "which Cosmos DB consistency level must a service use" }, ctxWith(stubSearcher([{ ...far, similarity: 0.8 }])));
    expect(close.text).not.toContain("Weak match");
    // A keyword lookup or an exact-text search scores low by nature.
    const keyword = await runMcpTool("search", { query: "ncs" }, ctxWith(stubSearcher([far])));
    expect(keyword.text).not.toContain("Weak match");
  });
});

describe("search filter values", () => {
  it("rejects a source_type or lang the index does not have, listing the ones it has", async () => {
    const searcher = {
      ...stubSearcher([chunk()]),
      facets: async () => ({ sourceTypes: { devportal: 9, gitlab: 5, adr: 2 }, kinds: { doc: 16 }, authorities: { binding: 2 }, langs: { en: 10, it: 6 } }),
    };
    const typo = await runMcpTool("search", { query: "x", source_type: ["gitlab", "devportl"] }, ctxWith(searcher));
    expect(typo.isError).toBe(true);
    expect(typo.text).toContain('source_type "devportl" is not in the index; it has "devportal", "gitlab", "adr"');
    const ok = await runMcpTool("search", { query: "x", source_type: ["adr"], lang: ["it"] }, ctxWith(searcher));
    expect(ok.isError).toBeUndefined();
  });
});

describe("related", () => {
  it("groups the neighbourhood and flags what fetch_document cannot read", async () => {
    const out = await runMcpTool("related", { source_id: "adr:client-credentials" }, ctxWith(stubSearcher([])));
    expect(out.isError).toBeUndefined();
    expect(out.text).toContain('connected to "ADR0010 Client Credentials"');
    expect(out.text).toContain("It sits in: gateway (repo, 2 documents)");
    // Indexed: plain id. Linked but not in the manifest: marked, not silently dropped.
    expect(out.text).toMatch(/- src\/auth\.ts — gitlab:oneplatform\/gateway:src\/auth\.ts$/m);
    expect(out.text).toContain("- ADR0010 in the wiki — confluence:CTO:805961883 (linked, not indexed");
  });

  it("narrows to links only", async () => {
    const out = await runMcpTool("related", { source_id: "adr:client-credentials", scope: "links" }, ctxWith(stubSearcher([])));
    expect(out.text).toContain("confluence:CTO:805961883");
    expect(out.text).not.toContain("src/auth.ts");
  });

  it("still lists the rest of a big module by default, and the links that lead out of the index", async () => {
    // One page with no links of its own, in a module of 70 pages: above GRAPH_MAX_HUB_SIZE (60).
    const nodes = [
      ...Array.from({ length: 70 }, (_, i) => ({ id: `devportal:default/component/tse/p${String(i).padStart(2, "0")}/`, type: "doc" as const, label: `Page ${String(i).padStart(2, "0")}` })),
      { id: "entity:component/tse", type: "entity" as const, label: "tse-webapi-doc" },
    ];
    const rel = RELATIONS.indexOf("about_entity" as never);
    const edges = { from: nodes.slice(0, 70).map((_, i) => i), to: nodes.slice(0, 70).map(() => 70), rel: nodes.slice(0, 70).map(() => rel) };
    const page = "devportal:default/component/tse/p00/";
    const file: KbGraphFile = {
      version: 1,
      generatedAt: new Date().toISOString(),
      docs: 70,
      nodes,
      relations: [...RELATIONS],
      edges,
      brokenLinks: [{ from: page, href: "https://development.teamsystem.com/docs/default/component/tse/launchpad/", reason: "devportal-page", text: "Launchpad" }],
      stats: { nodes: nodes.length, edges: edges.from.length, byRelation: {}, unresolved: {}, scopeGaps: {}, connectedDocs: 0, largestComponent: 1, brokenLinksTotal: 1, durationMs: 1 },
    };
    const out = await runMcpTool("related", { source_id: page, limit: 10 }, ctxWith(stubSearcher([]), new KbGraph(file)));
    expect(out.text).not.toContain("No indexed documents are connected");
    expect(out.text).toContain("10 of 69");
    expect(out.text).toContain("devportal:default/component/tse/p01/");
    expect(out.text).toContain("links to pages that are not indexed");
    expect(out.text).toContain("- Launchpad — https://development.teamsystem.com/docs/default/component/tse/launchpad/ (Dev Portal page that is not indexed");
  });

  it("is an error, with a way forward, when the graph is missing or the id is not a document", async () => {
    const noGraph = await runMcpTool("related", { source_id: "adr:client-credentials" }, ctxWith(stubSearcher([]), null));
    expect(noGraph.isError).toBe(true);
    expect(noGraph.text).toContain("npm run graph");
    const unknown = await runMcpTool("related", { source_id: "repo:oneplatform/gateway" }, ctxWith(stubSearcher([])));
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("not a document in the knowledge base");
  });
});

describe("report", () => {
  const correction = {
    kind: "correction",
    note: "ADR0010 says the M2M token keeps working until the deadline, but the gateway already rejects it.",
    question: "Can a new service still use the M2M token?",
    source_ids: ["adr:client-credentials", "gitlab/auth.md"],
    evidence: "src/auth.ts only accepts client_credentials.",
    model: "claude-opus-5-5",
  };

  it("records the note pinned to the indexed version of each document, and who filed it", async () => {
    const sink = memorySink();
    const out = await runMcpTool("report", correction, ctxWith(stubSearcher([]), null, sink));
    expect(out.isError).toBeUndefined();
    expect(sink.reports).toHaveLength(1);
    const r = sink.reports[0] as AgentReport;
    expect(r).toMatchObject({
      status: "new",
      kind: "correction",
      note: correction.note,
      question: correction.question,
      evidence: correction.evidence,
      model: "claude-opus-5-5",
      session: "s-1",
      client: "claude-code/2.1.0",
      sources: [
        { source_id: "adr:client-credentials", content_hash: "c-adr", embed_hash: "e-adr" },
        // A kb path resolves to its source_id; a manifest without hashes leaves them null.
        { source_id: "gitlab:oneplatform/gateway:src/auth.ts", content_hash: null, embed_hash: null },
      ],
    });
    expect(Number.isNaN(Date.parse(r.ts))).toBe(false);
    expect(out.text).toContain(`Recorded correction report ${r.id}`);
    expect(out.text).toContain("does not show up in search");
    expect(out.trace).toEqual({ report_id: r.id, kind: "correction", source_ids: ["adr:client-credentials", "gitlab:oneplatform/gateway:src/auth.ts"], target: null, earlier: [] });
  });

  it("keeps the page to change apart from the evidence, with the words to fix", async () => {
    const sink = memorySink();
    const out = await runMcpTool(
      "report",
      {
        ...correction,
        source_ids: ["gitlab/auth.md"],
        target: "adr:client-credentials",
        section: "Decision",
        quote: "the M2M token keeps working until the deadline",
        fix: "The gateway rejects M2M tokens since 2026-05: use client credentials.",
        owner_decision: true,
      },
      ctxWith(stubSearcher([]), null, sink),
    );
    const r = sink.reports[0] as AgentReport;
    expect(r).toMatchObject({ target: "adr:client-credentials", section: "Decision", owner_decision: true });
    expect(r.quote).toContain("keeps working");
    expect(r.fix).toContain("client credentials");
    // The target is one of the sources even when only named as target.
    expect(r.sources.map((x) => x.source_id)).toEqual(["adr:client-credentials", "gitlab:oneplatform/gateway:src/auth.ts"]);
    expect(out.text).toContain("on adr:client-credentials (with 1 more document as evidence)");
  });

  it("pins the version on disk too when it is newer than the indexed one", async () => {
    const sink = memorySink();
    await runMcpTool("report", correction, ctxWith(stubSearcher([]), null, sink));
    // The fixture manifest says "c-adr", which is not the hash of the file sitting in kb/.
    expect(sink.reports[0]?.sources[0]?.kb_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("points out a report already filed on the same page", async () => {
    const sink = memorySink();
    const first = await runMcpTool("report", correction, ctxWith(stubSearcher([]), null, sink));
    expect(first.text).not.toContain("Already filed");
    const withHistory: FeedbackSink = { ...sink, existing: async () => [...sink.reports] };
    const second = await runMcpTool("report", { ...correction, note: "Same thing, said again." }, ctxWith(stubSearcher([]), null, withHistory));
    expect(second.isError).toBeUndefined();
    expect(second.text).toContain(`Already filed on the same page: ${sink.reports[0]?.id.slice(0, 8)} (correction`);
    expect(sink.reports).toHaveLength(2);
  });

  it("takes the security and indexing kinds", async () => {
    for (const kind of ["security", "indexing"]) {
      const sink = memorySink();
      const out = await runMcpTool("report", { ...correction, kind }, ctxWith(stubSearcher([]), null, sink));
      expect(out.isError).toBeUndefined();
      expect(sink.reports[0]?.kind).toBe(kind);
    }
    const none = await runMcpTool("report", { ...correction, kind: "security", source_ids: [] }, ctxWith(stubSearcher([]), null, memorySink()));
    expect(none.isError).toBe(true);
  });

  it("takes a gap without documents, since the point of a gap is that there is none", async () => {
    const sink = memorySink();
    const out = await runMcpTool(
      "report",
      { kind: "Gaps", note: "Nothing covers the retry policy of the billing webhooks.", question: "How often are webhooks retried?" },
      ctxWith(stubSearcher([]), null, sink),
    );
    expect(out.isError).toBeUndefined();
    expect(sink.reports[0]).toMatchObject({ kind: "gap", sources: [], evidence: null, model: "unknown" });
  });

  it("refuses a correction or a tip without documents, and an id that is not one, recording nothing", async () => {
    const sink = memorySink();
    const noSources = await runMcpTool("report", { ...correction, source_ids: [] }, ctxWith(stubSearcher([]), null, sink));
    expect(noSources.isError).toBe(true);
    expect(noSources.text).toContain("A correction needs the documents it is about in `source_ids`");
    const wrongId = await runMcpTool("report", { ...correction, kind: "tip", source_ids: ["adr:client-credential"] }, ctxWith(stubSearcher([]), null, sink));
    expect(wrongId.isError).toBe(true);
    expect(wrongId.text).toContain('"adr:client-credential" is not a document in the knowledge base — did you mean adr:client-credentials?');
    expect(sink.reports).toHaveLength(0);
  });

  it("says everything that is missing in one go", async () => {
    const out = await runMcpTool("report", { kind: "praise", model: "m" }, ctxWith(stubSearcher([]), null, memorySink()));
    expect(out.isError).toBe(true);
    expect(out.text).toContain('`kind` must be one of correction, gap, tip, security, indexing (got "praise")');
    expect(out.text).toContain("`note` is required");
    expect(out.text).toContain("`question` is required");
  });

  it("takes a note up to 40,000 characters", async () => {
    const sink = memorySink();
    const fits = await runMcpTool("report", { ...correction, note: "a".repeat(40_000) }, ctxWith(stubSearcher([]), null, sink));
    expect(fits.isError).toBeUndefined();
    const tooLong = await runMcpTool("report", { ...correction, note: "a".repeat(40_001) }, ctxWith(stubSearcher([]), null, sink));
    expect(tooLong.isError).toBe(true);
    expect(tooLong.text).toContain("keep it under 40000");
    expect(sink.reports).toHaveLength(1);
  });

  it("is an error when the tool is turned off or the log cannot be written", async () => {
    const off = await runMcpTool("report", correction, ctxWith(stubSearcher([]), null));
    expect(off.isError).toBe(true);
    expect(off.text).toContain("MCP_REPORT_TOOL=false");
    const broken: FeedbackSink = { session: null, client: null, append: () => Promise.reject(new Error("EACCES")) };
    const failed = await runMcpTool("report", correction, ctxWith(stubSearcher([]), null, broken));
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("Could not record the report: EACCES");
  });
});

describe("an unknown tool", () => {
  it("comes back as an error listing the real ones", async () => {
    const out = await runMcpTool("ask", { question: "why" }, ctxWith(stubSearcher([])));
    expect(out.isError).toBe(true);
    expect(out.text).toContain("search, fetch_document, related");
  });
});

describe("the Claude Desktop configuration", () => {
  const entry = serverEntry("/Users/x/ai-wiki", "/opt/node/bin/node");

  it("runs tsx through an absolute Node, because the app spawns servers with a minimal PATH", () => {
    expect(entry.command).toBe("/opt/node/bin/node");
    expect(entry.args).toEqual(["/Users/x/ai-wiki/node_modules/tsx/dist/cli.mjs", "/Users/x/ai-wiki/src/cli/mcp.ts"]);
    // No env: src/cli/mcp.ts moves to the project root itself, so .env and KB_DIR resolve there.
    expect(entry.env).toBeUndefined();
  });

  it("knows where each platform keeps the file", () => {
    expect(desktopConfigPath("darwin", {}, "/Users/x")).toBe("/Users/x/Library/Application Support/Claude/claude_desktop_config.json");
    expect(desktopConfigPath("linux", {}, "/home/x")).toBe("/home/x/.config/Claude/claude_desktop_config.json");
    expect(desktopConfigPath("win32", { APPDATA: "C:\\Users\\x\\AppData\\Roaming" }, "C:\\Users\\x")).toContain("Claude");
  });

  it("merges into a file that holds the app's own settings and other servers, changing neither", () => {
    const current = {
      deploymentMode: "1p",
      preferences: { sidebarMode: "chat" },
      mcpServers: { filesystem: { command: "npx", args: ["-y", "server-filesystem"] } },
    };
    const merged = mergeServer(current, entry);
    expect(merged.config["deploymentMode"]).toBe("1p");
    expect(merged.config["preferences"]).toEqual({ sidebarMode: "chat" });
    expect(merged.config.mcpServers?.["filesystem"]).toEqual(current.mcpServers.filesystem);
    expect(merged.config.mcpServers?.[DEFAULT_SERVER_NAME]).toEqual(entry);
    expect(merged.otherServers).toEqual(["filesystem"]);
    expect(merged.previous).toBeNull();
    expect(merged.unchanged).toBe(false);
    // The input is not mutated: a failed write must leave the caller's copy alone.
    expect(Object.keys(current.mcpServers)).toEqual(["filesystem"]);
  });

  it("recognises its own entry, and reports the stale one it replaces", () => {
    const { config } = mergeServer(null, entry);
    expect(mergeServer(config, entry).unchanged).toBe(true);
    const stale = mergeServer(config, serverEntry("/Users/x/moved", "/opt/node/bin/node"));
    expect(stale.unchanged).toBe(false);
    expect(stale.previous).toEqual(entry);
  });

  it("writes a standalone one-server file for copying by hand", () => {
    expect(JSON.parse(formatConfig(bundleFile(entry)))).toEqual({ mcpServers: { "ai-wiki": entry } });
    expect(formatConfig(bundleFile(entry)).endsWith("\n")).toBe(true);
  });

  it("refuses a file it cannot parse instead of replacing settings it did not write", () => {
    expect(() => parseDesktopConfig("{ oops", "cfg.json")).toThrow(/not valid JSON/);
    expect(() => parseDesktopConfig("[]", "cfg.json")).toThrow(/JSON object/);
  });
});
