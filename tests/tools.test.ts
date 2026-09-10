import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { FETCH_DOCUMENT_TOOL, SEARCH_TOOL, kbTools, parseTextToolCalls, runToolCall, type Searcher } from "../src/generation/tools.js";
import { KbGraph, RELATIONS, type KbGraphFile } from "../src/graph/index.js";
import { DocumentStore } from "../src/retrieval/documents.js";
import type { Citation, RetrievedChunk, ToolCall } from "../src/types.js";

const PAGE = `---
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

const citation = (n: number, sourceId: string): Citation => ({
  n,
  chunkId: `${sourceId}#0`,
  sourceId,
  title: "T",
  sourceUrl: null,
  sourceType: "adr",
  kind: "doc",
  authority: "binding",
  headingPath: "T > H",
  relPath: "adr/x.md",
  excerpt: "…",
  lineStart: null,
  lineEnd: null,
  score: 1,
});

const call = (args: Record<string, unknown>, name = "fetch_document"): ToolCall => ({ function: { name, arguments: args } });

let store: DocumentStore;

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ai-wiki-tools-"));
  const kbDir = path.join(root, "kb");
  await mkdir(path.join(kbDir, "adr"), { recursive: true });
  await writeFile(path.join(kbDir, "adr", "adr0010.md"), PAGE, "utf8");
  const manifestFile = path.join(root, "manifest.json");
  await writeFile(
    manifestFile,
    JSON.stringify({
      version: 1,
      embeddingModel: "mock",
      embeddingDimensions: 8,
      chunking: { targetTokens: 450, maxTokens: 700, overlapTokens: 60 },
      docs: {
        "adr:client-credentials": {
          sourceId: "adr:client-credentials",
          relPath: "adr/adr0010.md",
          contentHash: "sha256:x",
          chunkCount: 1,
          indexedAt: "2026-09-10T00:00:00.000Z",
        },
      },
    }),
    "utf8",
  );
  store = await DocumentStore.open(manifestFile, kbDir);
});

describe("fetch_document tool", () => {
  it("declares a schema Ollama accepts", () => {
    expect(FETCH_DOCUMENT_TOOL.type).toBe("function");
    expect(FETCH_DOCUMENT_TOOL.function.parameters.required).toEqual(["source_id"]);
    expect(Object.keys(FETCH_DOCUMENT_TOOL.function.parameters.properties)).toEqual(["source_id", "section"]);
  });

  it("returns the document as a new numbered block", async () => {
    const citations = [citation(1, "devportal:other")];
    const out = await runToolCall(call({ source_id: "adr:client-credentials" }), { store, citations });
    expect(out.ok).toBe(true);
    expect(out.citationNumbers).toEqual([2]);
    expect(out.newCitations?.[0]?.sourceId).toBe("adr:client-credentials");
    expect(out.message.role).toBe("tool");
    expect(out.message.tool_name).toBe("fetch_document");
    expect(out.message.content).toMatch(/^\[2\] ADR0010 Client Credentials — adr:client-credentials/);
    expect(out.message.content).toContain("authority=binding");
    expect(out.message.content).toContain("last_modified=2026-02-01");
    expect(out.message.content).toContain("outline: Decision · Consequences");
    expect(out.message.content).toContain("The old M2M token is deprecated.");
  });

  it("accepts a citation number instead of a source_id, and keeps that number", async () => {
    const citations = [citation(1, "devportal:other"), citation(2, "adr:client-credentials")];
    const out = await runToolCall(call({ source_id: "[2]" }), { store, citations });
    expect(out.ok).toBe(true);
    expect(out.citationNumbers).toEqual([2]);
    expect(out.newCitations).toBeUndefined(); // already a citation: no duplicate source
    expect(out.message.content).toMatch(/^\[2\] /);
  });

  it("returns a single section when asked", async () => {
    const out = await runToolCall(call({ source_id: "adr:client-credentials", section: "Consequences" }), {
      store,
      citations: [],
    });
    expect(out.message.content).toContain('section "Consequences"');
    expect(out.message.content).toContain("The old M2M token is deprecated.");
    expect(out.message.content).not.toContain("Use client credentials for service-to-service calls.");
  });

  it("honours the character budget and tells the model the result was cut", async () => {
    const out = await runToolCall(call({ source_id: "adr:client-credentials" }), {
      store,
      citations: [],
      maxChars: 60,
    });
    expect(out.message.content).toContain("TRUNCATED");
    expect(out.message.content).toContain("outline: Decision · Consequences");
  });

  it("turns a wrong source_id into an error the model can recover from", async () => {
    const citations = [citation(1, "devportal:other")];
    const out = await runToolCall(call({ source_id: "adr:made-up" }), { store, citations });
    expect(out.ok).toBe(false);
    expect(out.newCitations).toBeUndefined();
    expect(out.message.content).toContain("Error:");
    expect(out.message.content).toContain("devportal:other"); // the ids it may actually ask for
  });

  it("rejects a missing argument and an unknown tool", async () => {
    const noArg = await runToolCall(call({}), { store, citations: [] });
    expect(noArg.ok).toBe(false);
    expect(noArg.message.content).toContain("needs a source_id");

    const unknown = await runToolCall(call({ query: "x" }, "search_the_web"), { store, citations: [] });
    expect(unknown.ok).toBe(false);
    expect(unknown.message.content).toContain("no tool called");
  });
});

describe("repeat fetches", () => {
  it("answers a second request for the same document with a pointer, not a second copy", async () => {
    const fetched = new Map<string, number>();
    const citations = [citation(1, "adr:client-credentials")];
    const first = await runToolCall(call({ source_id: "adr:client-credentials" }), { store, citations, fetched });
    expect(first.message.content).toContain("Use client credentials");

    // The model often asks again using the number the first result was given.
    const second = await runToolCall(call({ source_id: "1" }), { store, citations, fetched });
    expect(second.ok).toBe(true);
    expect(second.citationNumbers).toEqual([1]);
    expect(second.message.content).toContain("already in the context as block [1]");
    expect(second.message.content).not.toContain("Use client credentials");

    // A different section of the same page is still a real read.
    const third = await runToolCall(call({ source_id: "adr:client-credentials", section: "Decision" }), {
      store,
      citations,
      fetched,
    });
    expect(third.message.content).toContain("Use client credentials");
  });
});

// ---- search ------------------------------------------------------------------------------------

const passage = (id: string, sourceId: string, content: string): RetrievedChunk => ({
  id,
  sourceId,
  sourceType: "devportal",
  kind: "doc",
  title: "Page",
  sourceUrl: `https://example.com/${id}`,
  authority: "descriptive",
  lang: "en",
  relPath: `devportal/${id}.md`,
  ordinal: 0,
  headingPath: `Page > ${id}`,
  content,
  lineStart: null,
  lineEnd: null,
  score: 0.5,
  vectorRank: 1,
  bm25Rank: null,
});

/** A retriever that returns a fixed ranking and records what it was asked. */
function stubSearcher(results: RetrievedChunk[]) {
  const calls: { query: string; opts: unknown }[] = [];
  const searcher: Searcher = {
    async retrieve(query, opts) {
      calls.push({ query, opts });
      return results;
    },
  };
  return { searcher, calls };
}

describe("search tool", () => {
  it("is offered next to fetch_document, with a query-only schema", () => {
    expect(kbTools({ graph: false }).map((t) => t.function.name)).toEqual(["search", "fetch_document"]);
    expect(SEARCH_TOOL.function.parameters.required).toEqual(["query"]);
    expect(Object.keys(SEARCH_TOOL.function.parameters.properties)).toEqual(["query"]);
  });

  it("is joined by related once the knowledge graph is loaded", () => {
    expect(kbTools({ graph: true }).map((t) => t.function.name)).toEqual(["search", "fetch_document", "related"]);
  });

  it("appends the new passages as numbered blocks after the existing citations", async () => {
    const { searcher, calls } = stubSearcher([
      passage("c1", "devportal:auth", "Client credentials flow, step one."),
      passage("c2", "devportal:tokens", "Token lifetime is one hour."),
    ]);
    const citations = [citation(1, "adr:client-credentials"), citation(2, "devportal:other")];
    const out = await runToolCall(call({ query: "client credentials token lifetime" }, "search"), {
      store,
      searcher,
      citations,
      filters: { kinds: ["doc"] },
    });
    expect(out.ok).toBe(true);
    expect(out.citationNumbers).toEqual([3, 4]);
    expect(out.newCitations?.map((c) => [c.n, c.chunkId])).toEqual([[3, "c1"], [4, "c2"]]);
    expect(out.message.role).toBe("tool");
    expect(out.message.tool_name).toBe("search");
    expect(out.message.content).toMatch(/^Search "client credentials token lifetime": 2 new passages\./);
    expect(out.message.content).toContain("[3] Page > c1");
    expect(out.message.content).toContain("[4] Page > c2");
    expect(out.message.content).toContain("Token lifetime is one hour.");
    expect(out.summary).toContain("[3][4]");
    // The user's filters follow the model's search, and the rerank is skipped.
    expect(calls[0]?.query).toBe("client credentials token lifetime");
    expect(calls[0]?.opts).toMatchObject({ filters: { kinds: ["doc"] }, noRerank: true });
  });

  it("numbers new blocks past the highest number in use, not past the count", async () => {
    // A follow-up carries the blocks its chat already gathered *with their original numbers*, so a
    // context of two blocks can be numbered [7][9]. Numbering from the count would hand the new
    // passage [3] and quietly overwrite a block the earlier answers already cite.
    const { searcher } = stubSearcher([passage("c1", "devportal:auth", "Client credentials flow.")]);
    const carried = [citation(7, "adr:client-credentials"), citation(9, "devportal:other")];
    const found = await runToolCall(call({ query: "client credentials" }, "search"), { store, searcher, citations: carried });
    expect(found.citationNumbers).toEqual([10]);
    expect(found.message.content).toContain("[10] Page > c1");

    const read = await runToolCall(call({ source_id: "adr:client-credentials-missing" }), { store, citations: carried });
    expect(read.ok).toBe(false);   // unknown id, but the numbering above is what this asserts
    const fetched = await runToolCall(call({ source_id: "adr:client-credentials", section: "Decision" }), {
      store,
      citations: [citation(9, "devportal:other")],
    });
    expect(fetched.citationNumbers).toEqual([10]);
    expect(fetched.newCitations?.[0]?.section).toBe("Decision");
  });

  it("skips passages already in the context and documents already fetched whole", async () => {
    const { searcher } = stubSearcher([
      passage("seen", "devportal:auth", "Already shown."),
      passage("from-fetched", "adr:client-credentials", "Part of a page the model already read in full."),
      passage("fresh", "devportal:new", "Something new."),
    ]);
    const citations = [{ ...citation(1, "devportal:auth"), chunkId: "seen" }];
    const fetched = new Map([["adr:client-credentials::", 2]]);
    const out = await runToolCall(call({ query: "auth" }, "search"), { store, searcher, citations, fetched });
    expect(out.citationNumbers).toEqual([2]);
    expect(out.newCitations?.map((c) => c.chunkId)).toEqual(["fresh"]);
    expect(out.message.content).not.toContain("Already shown.");
    expect(out.message.content).not.toContain("Part of a page");
  });

  it("tells the model when a search adds nothing, and when it repeats a query", async () => {
    const { searcher, calls } = stubSearcher([passage("seen", "devportal:auth", "Already shown.")]);
    const citations = [{ ...citation(1, "devportal:auth"), chunkId: "seen" }];
    const searched = new Map<string, number[]>();

    const nothing = await runToolCall(call({ query: "OAuth token" }, "search"), { store, searcher, citations, searched });
    expect(nothing.ok).toBe(true);
    expect(nothing.newCitations).toBeUndefined();
    expect(nothing.message.content).toContain("no new passages");
    expect(nothing.message.content).toContain("Try different words");

    // Same query modulo case/punctuation: no second retrieval, just a pointer.
    const again = await runToolCall(call({ query: "oauth, token!" }, "search"), { store, searcher, citations, searched });
    expect(again.ok).toBe(true);
    expect(again.message.content).toContain("already searched");
    expect(calls).toHaveLength(1);
  });

  it("stays within the character budget but always returns at least one passage", async () => {
    const { searcher } = stubSearcher([
      passage("a", "d:a", "x".repeat(1000)),
      passage("b", "d:b", "y".repeat(1000)),
      passage("c", "d:c", "z".repeat(1000)),
    ]);
    const out = await runToolCall(call({ query: "budget" }, "search"), { store, searcher, citations: [], maxChars: 1500 });
    expect(out.citationNumbers).toEqual([1]);
    expect(out.message.content).toContain("x".repeat(1000));
    expect(out.message.content).not.toContain("y".repeat(1000));
  });

  it("rejects a missing query and reports when no searcher is wired in", async () => {
    const { searcher } = stubSearcher([]);
    const noQuery = await runToolCall(call({}, "search"), { store, searcher, citations: [] });
    expect(noQuery.ok).toBe(false);
    expect(noQuery.message.content).toContain("needs a query");

    const noSearcher = await runToolCall(call({ query: "x" }, "search"), { store, citations: [] });
    expect(noSearcher.ok).toBe(false);
    expect(noSearcher.message.content).toContain("not available");
  });
});

describe("tool calls written as text", () => {
  it("recovers the pseudo-XML form, wrapped or bare", () => {
    const calls = parseTextToolCalls(
      "Ora leggo.\n<tool_call> <function=fetch_document> <parameter=source_id> 3 </parameter> </function> </tool_call>\n" +
        "<tool_call>\n<function=search>\n<parameter=query>\nrelations island workspace\n</parameter>\n</function>\n</tool_call>",
    );
    expect(calls).toEqual([
      { function: { name: "fetch_document", arguments: { source_id: "3" } } },
      { function: { name: "search", arguments: { query: "relations island workspace" } } },
    ]);
  });

  it("recovers the JSON form and ignores plain prose", () => {
    expect(parseTextToolCalls('<tool_call>{"name":"search","arguments":{"query":"scope"}}</tool_call>')).toEqual([
      { function: { name: "search", arguments: { query: "scope" } } },
    ]);
    expect(parseTextToolCalls("Una connessione è il contratto [1].")).toEqual([]);
  });

  it("drops markup a half-written call left inside an argument", async () => {
    const { searcher, calls } = stubSearcher([passage("c1", "devportal:auth", "Relations data model.")]);
    const polluted = "relations data model\n</parameter>\n</function>\n<tool_call>\n<function=search>";
    const out = await runToolCall(call({ query: polluted }, "search"), { store, searcher, citations: [] });
    expect(calls[0]?.query).toBe("relations data model");
    expect(out.ok).toBe(true);
    expect(out.message.content).not.toContain("<");
  });
});

// ---- related -----------------------------------------------------------------------------------

/**
 * A hand-built graph, so the tool's behaviour is tested without a kb on disk: an ADR that
 * supersedes another, its project card, two more documents in the same repository, and one page
 * that is in the graph but nowhere near it.
 */
function stubGraph(): KbGraph {
  const nodes = [
    { id: "adr:client-credentials", type: "doc" as const, label: "ADR0010 Client Credentials" },
    { id: "adr:m2m-tokens", type: "doc" as const, label: "ADR0007 M2M tokens" },
    { id: "gitlab:oneplatform/adrs:__project", type: "doc" as const, label: "oneplatform/adrs" },
    { id: "gitlab:oneplatform/adrs:Platform/other.md", type: "doc" as const, label: "ADR0011 Log types" },
    { id: "devportal:elsewhere/", type: "doc" as const, label: "Unrelated page" },
    { id: "repo:oneplatform/adrs", type: "repo" as const, label: "adrs" },
    { id: "team:platform", type: "team" as const, label: "group:default/Platform" },
  ];
  const rel = (r: string): number => RELATIONS.indexOf(r as never);
  const edges = {
    from: [1, 0, 1, 3, 0, 1, 3],
    to: [0, 2, 2, 2, 5, 5, 5],
    rel: [rel("links_to"), rel("described_by"), rel("described_by"), rel("described_by"), rel("in_repo"), rel("in_repo"), rel("in_repo")],
  };
  const file: KbGraphFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    docs: 5,
    nodes,
    relations: [...RELATIONS],
    edges,
    brokenLinks: [],
    stats: { nodes: nodes.length, edges: edges.from.length, byRelation: {}, unresolved: {}, scopeGaps: {}, connectedDocs: 4, largestComponent: 4, brokenLinksTotal: 0, durationMs: 1 },
  };
  return new KbGraph(file);
}

describe("related tool", () => {
  const graph = stubGraph();

  it("groups the neighbourhood by how each document is connected, and gives exact ids", async () => {
    const out = await runToolCall(call({ source_id: "adr:m2m-tokens" }, "related"), { store, graph, citations: [] });
    expect(out.ok).toBe(true);
    expect(out.message.content).toContain("related to \"ADR0007 M2M tokens\"");
    expect(out.message.content).toContain("links to:\n- ADR0010 Client Credentials — adr:client-credentials");
    expect(out.message.content).toContain("same repo (adrs, 3 documents):");
    expect(out.message.content).toContain("fetch_document(source_id)");
    // A page in the graph but unconnected must not show up.
    expect(out.message.content).not.toContain("devportal:elsewhere/");
    // The list is navigation, not evidence: it adds no citable block.
    expect(out.newCitations).toBeUndefined();
    expect(out.citationNumbers).toBeUndefined();
  });

  it("accepts a context block's number in place of a source_id", async () => {
    const citations = [citation(1, "adr:m2m-tokens")];
    const out = await runToolCall(call({ source_id: "[1]" }, "related"), { store, graph, citations });
    expect(out.ok).toBe(true);
    expect(out.message.content).toContain("ADR0010 Client Credentials");
  });

  it("narrows to real links when asked, leaving the repository out", async () => {
    const out = await runToolCall(call({ source_id: "adr:m2m-tokens", scope: "links" }, "related"), { store, graph, citations: [] });
    expect(out.message.content).toContain("adr:client-credentials");
    expect(out.message.content).not.toContain("same repo");
  });

  it("says plainly when a document is connected to nothing", async () => {
    const out = await runToolCall(call({ source_id: "devportal:elsewhere/" }, "related"), { store, graph, citations: [] });
    expect(out.ok).toBe(true);
    expect(out.message.content).toContain("No documents are linked to");
    expect(out.message.content).toContain("search(query)");
  });

  it("answers a repeated walk with a pointer instead of the same list", async () => {
    const relatedAsked = new Set<string>();
    const first = await runToolCall(call({ source_id: "adr:m2m-tokens" }, "related"), { store, graph, citations: [], relatedAsked });
    expect(first.message.content).toContain("ADR0010");
    const second = await runToolCall(call({ source_id: "adr:m2m-tokens" }, "related"), { store, graph, citations: [], relatedAsked });
    expect(second.message.content).toContain("already listed");
    expect(second.message.content).not.toContain("ADR0010 Client Credentials —");
  });

  it("rejects an id that is not a document, and offers the ids in the context", async () => {
    const citations = [citation(1, "adr:m2m-tokens")];
    const out = await runToolCall(call({ source_id: "repo:oneplatform/adrs" }, "related"), { store, graph, citations });
    expect(out.ok).toBe(false);
    expect(out.message.content).toContain("not a document");
    expect(out.message.content).toContain("adr:m2m-tokens");
  });

  it("reports itself unavailable when the graph has not been built", async () => {
    const out = await runToolCall(call({ source_id: "adr:m2m-tokens" }, "related"), { store, citations: [] });
    expect(out.ok).toBe(false);
    expect(out.message.content).toContain("knowledge graph is not available");
  });
});
