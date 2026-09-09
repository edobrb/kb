import { describe, expect, it } from "vitest";
import { syncConfluence } from "../src/sync/confluence.js";
import { createHttp } from "../src/sync/http.js";
import { DEFAULT_SOURCES, parseSourcesConfig, type SourcesConfig } from "../src/sync/sources-config.js";
import type { ConnectorContext, SyncEvent, SyncState } from "../src/sync/types.js";

/** Fake fetch: routes are matched by substring of the URL (path + query), in insertion order. */
function fakeFetch(routes: Record<string, unknown | ((url: URL) => unknown)>, calls: string[] = []) {
  const impl = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    const key = `${url.pathname}${url.search}`;
    calls.push(key);
    for (const [pattern, value] of Object.entries(routes)) {
      if (key.includes(pattern)) {
        const v = typeof value === "function" ? (value as (u: URL) => unknown)(url) : value;
        if (v instanceof Response) return v;
        if (typeof v === "string") return new Response(v, { status: 200, headers: { "content-type": "text/html" } });
        return new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
  }) as typeof fetch;
  return { fetchImpl: impl, calls };
}

function ctx(fetchImpl: typeof fetch, baseUrl: string, overrides: Partial<ConnectorContext> = {}, sources: SourcesConfig = DEFAULT_SOURCES): ConnectorContext {
  return {
    http: createHttp({ fetchImpl, retries: 0 }),
    baseUrl,
    sources,
    previous: { items: {}, meta: {} },
    otherState: async () => null,
    log: () => {},
    concurrency: 2,
    ...overrides,
  };
}

async function collect(gen: AsyncGenerator<SyncEvent>): Promise<SyncEvent[]> {
  const out: SyncEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const docs = (events: SyncEvent[]) => events.flatMap((e) => (e.type === "doc" ? [e.doc] : []));
/** Skip events as [id, reason] with the trailing " — <page title>" (kept for the audit file) removed. */
const skips = (events: SyncEvent[]) => events.flatMap((e) => (e.type === "skip" ? [[e.sourceId, e.reason.replace(/ — .*$/, "")] as [string, string]] : []));

describe("Confluence connector", () => {
  const base = "https://teamsystem.atlassian.net";
  const space = { id: "100", key: "TeamCore", name: "Team Core", homepageId: "1", type: "global", status: "current" };

  const page = (id: string, title: string, parentId: string | null, parentType: string | null, version: number, createdAt: string, extra: Record<string, unknown> = {}) => ({
    id,
    status: "current",
    title,
    spaceId: "100",
    parentId,
    parentType,
    version: { number: version, createdAt },
    _links: { webui: `/spaces/TeamCore/pages/${id}/${title.replace(/ /g, "+")}` },
    ...extra,
  });

  const home = page("1", "Team Core Home", null, null, 1, "2026-04-02T08:00:00Z");
  const arch = page("2", "Architecture", "1", "page", 3, "2026-05-01T10:00:00Z", { subtype: "live" });
  const notes = page("3", "Meeting notes 2026-01-05", "2", "page", 2, "2026-05-02T10:00:00Z");
  const retro = page("4", "Retro Q1", "900", "folder", 1, "2026-05-03T10:00:00Z");
  const runbook = page("5", "Runbook", "2", "page", 7, "2026-07-01T10:00:00Z");
  const todo = page("6", "TODO", "2", "page", 1, "2026-05-05T10:00:00Z");

  const homeHtml =
    "<div class='wiki-content'><p>Welcome to the Team Core space, which collects the platform documentation that the core team keeps for every product team building services on the shared runtime.</p></div>";
  const archHtml = `<div class="wiki-content">
    <div class="toc-macro">Table of Contents: Architecture, Runbook</div>
    <h2>Overview</h2>
    <p>The platform is split into islands, and every island owns its own data store, its deployment pipeline and the public contracts that the other islands are allowed to call at run time.</p>
    <div class="confluence-information-macro"><span class="confluence-information-macro-icon"></span><p>Contracts are reviewed by the architecture board before a release.</p></div>
    <pre data-syntaxhighlighter-params="brush: java; gutter: false">System.out.println("island");</pre>
  </div>`;
  const runbookHtml =
    "<div class='wiki-content'><p>When the ingestion queue grows, restart the consumer group one pod at a time and check that the lag goes down before you touch the next replica of the service.</p></div>";

  const withBody = (p: Record<string, unknown>, html: string) => ({ ...p, body: { export_view: { value: html } } });
  const folder900 = { id: "900", title: "Archive 2024", parentId: "1", parentType: "page" };

  /** `probe` decides what the *site* URL answers to the token check (401 = scoped token, gateway needed). */
  const routesFor = (probe: (u: URL) => unknown) => ({
    "/_edge/tenant_info": { cloudId: "cid-9" },
    "/wiki/api/v2/spaces?limit=1": probe,
    "/wiki/api/v2/spaces?keys=": { results: [space] },
    // Second page of the listing must be matched before the first (its key contains the first one).
    "/wiki/api/v2/spaces/100/pages?limit=250&status=current&cursor=c2": { results: [retro, runbook, todo] },
    "/wiki/api/v2/spaces/100/pages?limit=250&status=current": { results: [home, arch, notes], _links: { next: "/wiki/api/v2/spaces/100/pages?limit=250&status=current&cursor=c2" } },
    "/wiki/api/v2/folders/900": folder900,
    "/wiki/api/v2/pages/2/labels": { results: [{ name: "architecture" }, { name: "platform" }] },
    "/wiki/api/v2/pages/1?body-format": withBody(home, homeHtml),
    "/wiki/api/v2/pages/2?body-format": withBody(arch, archHtml),
    "/wiki/api/v2/pages/5?body-format": withBody(runbook, runbookHtml),
    "/wiki/api/v2/pages/6?body-format": withBody(todo, "<p>TODO</p>"),
  });

  const siteRoutes = routesFor(() => ({ results: [] }));
  const gatewayRoutes = routesFor((u) => (u.host === "api.atlassian.com" ? { results: [] } : new Response("<html>401</html>", { status: 401 })));

  /** sources.yaml equivalent of the excludes this suite relies on. */
  const cfgFor = (patch: Partial<SourcesConfig["confluence"]> = {}): SourcesConfig => {
    const cfg = parseSourcesConfig(`
confluence:
  enabled: true
  spaces:
    include: [TeamCore]
  exclude_titles: ["Meeting notes*"]
  exclude_trees:
    - title: "Archive*"
`);
    cfg.confluence = { ...cfg.confluence, ...patch };
    return cfg;
  };

  it("indexes a space through the gateway: cursor pages, ancestors, labels, nav macros stripped, excluded trees and stubs skipped", async () => {
    const { fetchImpl, calls } = fakeFetch(gatewayRoutes);
    const logs: string[] = [];
    const events = await collect(syncConfluence(ctx(fetchImpl, base, { log: (m) => logs.push(m) }, cfgFor())));
    const ds = docs(events);
    expect(ds.map((d) => d.sourceId).sort()).toEqual(["confluence:TeamCore:1", "confluence:TeamCore:2", "confluence:TeamCore:5"]);

    const a = ds.find((d) => d.sourceId === "confluence:TeamCore:2")!;
    expect(a).toMatchObject({
      sourceType: "confluence",
      kind: "doc",
      relPath: "confluence/TeamCore/2-architecture.md",
      title: "Architecture",
      sourceUrl: `${base}/wiki/spaces/TeamCore/pages/2/Architecture`,
      lastModified: "2026-05-01",
      lang: "en",
    });
    expect(a.fingerprint).toMatch(/^v3\|[0-9a-f]{8}$/);
    expect(a.extra).toMatchObject({
      space: "TeamCore",
      space_name: "Team Core",
      page_id: "2",
      parent_id: "1",
      ancestors: [], // the space homepage is not an ancestor
      labels: ["architecture", "platform"],
      page_status: "current",
      subtype: "live",
      breadcrumb: "Confluence › Team Core",
      version: 3,
    });
    // Nav/TOC macros are removed; headings, panels and code survive.
    expect(a.body).not.toContain("Table of Contents");
    expect(a.body).toContain("## Overview");
    expect(a.body).toContain("> Contracts are reviewed by the architecture board");
    expect(a.body).toContain('```java\nSystem.out.println("island");\n```');

    const r = ds.find((d) => d.sourceId === "confluence:TeamCore:5")!;
    expect(r.extra["ancestors"]).toEqual(["Architecture"]);
    expect(r.extra["breadcrumb"]).toBe("Confluence › Team Core › Architecture");
    expect(r.extra["labels"]).toEqual([]); // /labels answered 404: non-fatal
    expect(r.relPath).toBe("confluence/TeamCore/5-runbook.md");

    expect(skips(events).sort()).toEqual([
      ["confluence:TeamCore:3", "excluded title"],
      ['confluence:TeamCore:4', 'excluded tree "Archive 2024"'],
      ["confluence:TeamCore:6", "stub (1 words)"],
    ]);
    // The excluded folder ancestor was resolved through /folders/{id}.
    expect(calls.some((c) => c.includes("/wiki/api/v2/folders/900"))).toBe(true);
    // Scoped token: every Confluence call goes through the gateway, links stay on the site URL.
    expect(calls.filter((c) => c.includes("/wiki/api/v2/") && !c.endsWith("spaces?limit=1")).every((c) => c.startsWith("/ex/confluence/cid-9/"))).toBe(true);
    expect(logs).toContain("Confluence: Team Core (TeamCore): 6 pages listed → 2 excluded, 0 unchanged, 4 to fetch");
    const meta = events.find((e) => e.type === "meta" && e.key === "spaces") as { value: Record<string, unknown> };
    expect(meta.value["TeamCore"]).toMatchObject({ name: "Team Core", listed: 6, excluded: 2, unchanged: 0, fetched: 4, indexed: 3, skipped: 1, errors: 0 });
  });

  it("restricts a space to its configured roots", async () => {
    const { fetchImpl, calls } = fakeFetch(siteRoutes);
    const events = await collect(syncConfluence(ctx(fetchImpl, base, {}, cfgFor({ roots: { TeamCore: ["2"] } }))));
    // The root page itself and its descendants only; the homepage is outside.
    expect(docs(events).map((d) => d.sourceId).sort()).toEqual(["confluence:TeamCore:2", "confluence:TeamCore:5"]);
    expect(skips(events)).toContainEqual(["confluence:TeamCore:1", "outside roots"]);
    expect(calls.some((c) => c.includes("/wiki/api/v2/pages/1?body-format"))).toBe(false);
  });

  it("skips pages older than modified_since", async () => {
    const { fetchImpl } = fakeFetch(siteRoutes);
    const events = await collect(syncConfluence(ctx(fetchImpl, base, {}, cfgFor({ modified_since: "2026-06-01" }))));
    expect(docs(events).map((d) => d.sourceId)).toEqual(["confluence:TeamCore:5"]);
    expect(skips(events)).toContainEqual(["confluence:TeamCore:2", "older than modified_since (2026-05-01)"]);
  });

  it("re-emits unchanged pages without downloading a body, until a quality threshold changes", async () => {
    const cfg = cfgFor();
    const first = docs(await collect(syncConfluence(ctx(fakeFetch(siteRoutes).fetchImpl, base, {}, cfg))));
    const previous: Pick<SyncState, "items" | "meta"> = {
      items: Object.fromEntries(first.map((d) => [d.sourceId, { relPath: d.relPath, fingerprint: d.fingerprint, title: d.title, sourceUrl: d.sourceUrl, syncedAt: "" }])),
      meta: {},
    };

    const { fetchImpl, calls } = fakeFetch(siteRoutes);
    const second = await collect(syncConfluence(ctx(fetchImpl, base, { previous }, cfg)));
    expect(second.flatMap((e) => (e.type === "unchanged" ? [e.sourceId] : [])).sort()).toEqual(["confluence:TeamCore:1", "confluence:TeamCore:2", "confluence:TeamCore:5"]);
    expect(docs(second)).toHaveLength(0);
    // Only the page that was skipped as a stub last time is re-examined; the known ones cost no request.
    expect(calls.filter((c) => c.includes("body-format"))).toEqual(["/wiki/api/v2/pages/6?body-format=export_view"]);

    // The thresholds are part of the fingerprint: lowering one re-evaluates every page.
    const third = docs(await collect(syncConfluence(ctx(fakeFetch(siteRoutes).fetchImpl, base, { previous }, cfgFor({ min_prose_words: 5 })))));
    expect(third.map((d) => d.sourceId).sort()).toEqual(["confluence:TeamCore:1", "confluence:TeamCore:2", "confluence:TeamCore:5"]);
    expect(third[0]!.fingerprint).not.toBe(first[0]!.fingerprint);
  });

  it("with --only processes the matching pages and keeps the others as they are", async () => {
    const { fetchImpl, calls } = fakeFetch(siteRoutes);
    const previous: Pick<SyncState, "items" | "meta"> = {
      items: {
        "confluence:TeamCore:1": { relPath: "confluence/TeamCore/1-team-core-home.md", fingerprint: "v1|stale", title: "Team Core Home", sourceUrl: null, syncedAt: "" },
        "confluence:TeamCore:2": { relPath: "confluence/TeamCore/2-architecture.md", fingerprint: "v3|stale", title: "Architecture", sourceUrl: null, syncedAt: "" },
      },
      meta: {},
    };
    const events = await collect(syncConfluence(ctx(fetchImpl, base, { previous, only: "runbook" }, cfgFor())));
    expect(docs(events).map((d) => d.sourceId)).toEqual(["confluence:TeamCore:5"]);
    expect(events.flatMap((e) => (e.type === "unchanged" ? [e.sourceId] : [])).sort()).toEqual(["confluence:TeamCore:1", "confluence:TeamCore:2"]);
    expect(calls.filter((c) => c.includes("body-format"))).toEqual(["/wiki/api/v2/pages/5?body-format=export_view"]);
  });

  it("reports an unknown space, and keeps the pages of a space whose listing failed", async () => {
    const { "/wiki/api/v2/spaces/100/pages?limit=250&status=current": _listing, ...broken } = routesFor(() => ({ results: [] })) as Record<string, unknown>;
    delete broken["/wiki/api/v2/spaces/100/pages?limit=250&status=current&cursor=c2"];
    const { fetchImpl } = fakeFetch(broken);
    const logs: string[] = [];
    const previous: Pick<SyncState, "items" | "meta"> = {
      items: { "confluence:TeamCore:2": { relPath: "confluence/TeamCore/2-architecture.md", fingerprint: "v3|x", title: "Architecture", sourceUrl: null, syncedAt: "" } },
      meta: {},
    };
    const cfg = cfgFor();
    cfg.confluence.spaces.include = ["TeamCore", "Ghost"];
    const events = await collect(syncConfluence(ctx(fetchImpl, base, { previous, log: (m) => logs.push(m) }, cfg)));
    expect(logs.some((l) => l.includes("unknown space (or no access): Ghost"))).toBe(true);
    expect(events.filter((e) => e.type === "error")).toHaveLength(1);
    expect(events.filter((e) => e.type === "unchanged")).toEqual([{ type: "unchanged", sourceId: "confluence:TeamCore:2" }]);
  });

  it("refuses to crawl every space when spaces.include is empty", async () => {
    const { fetchImpl, calls } = fakeFetch(siteRoutes);
    const events = await collect(syncConfluence(ctx(fetchImpl, base, {}, DEFAULT_SOURCES)));
    expect(events).toEqual([{ type: "error", message: "confluence.spaces.include is empty; nothing to index" }]);
    expect(calls).toEqual([]);
  });
});
