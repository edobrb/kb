import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { KbGraph, RELATIONS, type KbGraphFile } from "../src/graph/index.js";
import { FETCH_DOCUMENT_TOOL, RELATED_TOOL, SEARCH_TOOL, mcpTools, runMcpTool, type McpContext, type Searcher } from "../src/mcp/tools.js";
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
        "adr:client-credentials": { sourceId: "adr:client-credentials", relPath: "adr/client-credentials.md" },
        "gitlab:oneplatform/gateway:src/auth.ts": { sourceId: "gitlab:oneplatform/gateway:src/auth.ts", relPath: "gitlab/auth.md" },
      },
    }),
    "utf8",
  );
  store = await DocumentStore.open(manifest, kbDir);
});

const ctxWith = (searcher: Searcher, graph: KbGraph | null = stubGraph()): McpContext => ({
  searcher,
  store,
  graph: () => Promise.resolve(graph),
});

describe("the advertised tool set", () => {
  it("is retrieval only — there is no way to make the server generate an answer", () => {
    expect(mcpTools().map((t) => t.name)).toEqual(["search", "fetch_document", "related"]);
    for (const tool of mcpTools()) expect(tool.annotations?.readOnlyHint).toBe(true);
  });

  it("hides `related` when the graph has not been built", () => {
    expect(mcpTools({ graph: false }).map((t) => t.name)).toEqual(["search", "fetch_document"]);
  });

  it("requires the arguments the handlers insist on", () => {
    expect(SEARCH_TOOL.inputSchema.required).toEqual(["query"]);
    expect(FETCH_DOCUMENT_TOOL.inputSchema.required).toEqual(["source_id"]);
    expect(RELATED_TOOL.inputSchema.required).toEqual(["source_id"]);
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

  it("is an error, with a way forward, when the graph is missing or the id is not a document", async () => {
    const noGraph = await runMcpTool("related", { source_id: "adr:client-credentials" }, ctxWith(stubSearcher([]), null));
    expect(noGraph.isError).toBe(true);
    expect(noGraph.text).toContain("npm run graph");
    const unknown = await runMcpTool("related", { source_id: "repo:oneplatform/gateway" }, ctxWith(stubSearcher([])));
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("not a document in the knowledge base");
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
