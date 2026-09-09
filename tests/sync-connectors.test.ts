import { describe, expect, it } from "vitest";
import { resolveConfluenceApi, selectSpaces, syncConfluence } from "../src/sync/confluence.js";
import { buildDate, gitlabProjectFromLocation, pagePathOf, pagesFromSearchIndex, syncDevPortal } from "../src/sync/devportal.js";
import { selectMarkdownFiles, syncGitLab } from "../src/sync/gitlab.js";
import { createHttp } from "../src/sync/http.js";
import { DEFAULT_SOURCES, type SourcesConfig } from "../src/sync/sources-config.js";
import type { ConnectorContext, SyncEvent, SyncState } from "../src/sync/types.js";

/** Fake fetch: routes are matched by substring of the URL (path + query). */
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

describe("Confluence connector", () => {
  const base = "https://teamsystem.atlassian.net";
  const routes = {
    "/wiki/api/v2/spaces?": {
      results: [
        { id: "10", key: "CTO", name: "Group Technology", type: "collaboration", status: "current" },
        { id: "11", key: "UP", name: "uptime", type: "global", status: "current" },
        { id: "12", key: "~712020abc", name: "Someone", type: "personal", status: "current" },
      ],
    },
    "/wiki/api/v2/spaces/10/pages": {
      results: [
        { id: "100", title: "Parent", status: "current", parentId: null, spaceId: "10", version: { number: 1, createdAt: "2026-01-01T00:00:00Z" }, _links: { webui: "/spaces/CTO/pages/100/Parent" } },
        { id: "101", title: "Child page", status: "current", parentId: "100", spaceId: "10", version: { number: 4, createdAt: "2026-02-02T00:00:00Z" }, _links: { webui: "/spaces/CTO/pages/101/Child+page" } },
        { id: "102", title: "Stub", status: "current", parentId: "100", spaceId: "10", version: { number: 1 } },
      ],
    },
    "/wiki/api/v2/pages/100?": { id: "100", title: "Parent", version: { number: 1, createdAt: "2026-01-01T00:00:00Z" }, body: { export_view: { value: "<p>Il documento descrive la piattaforma e le sue componenti principali, con una panoramica del modello di riferimento che viene adottato dai team per la realizzazione delle capability.</p>" } } },
    "/wiki/api/v2/pages/101?": { id: "101", title: "Child page", version: { number: 4, createdAt: "2026-02-02T00:00:00Z" }, body: { export_view: { value: "<h2>Intro</h2><p>The child page explains the onboarding flow for the platform in detail, and it is the reference for the teams that are joining the platform this year.</p>" } } },
    "/wiki/api/v2/pages/102?": { id: "102", title: "Stub", version: { number: 1 }, body: { export_view: { value: "<p></p>" } } },
  };

  it("lists spaces (minus excluded), fetches bodies, builds breadcrumbs and skips stubs", async () => {
    const cfg = structuredClone(DEFAULT_SOURCES);
    cfg.confluence.spaces.exclude = ["up"];
    const { fetchImpl, calls } = fakeFetch(routes);
    const events = await collect(syncConfluence(ctx(fetchImpl, base, {}, cfg)));
    const ds = docs(events);
    expect(ds.map((d) => d.sourceId).sort()).toEqual(["confluence:CTO:100", "confluence:CTO:101"]);
    const child = ds.find((d) => d.sourceId === "confluence:CTO:101")!;
    expect(child.relPath).toBe("confluence/CTO/101-child-page.md");
    expect(child.sourceUrl).toBe(`${base}/wiki/spaces/CTO/pages/101/Child+page`);
    expect(child.extra["breadcrumb"]).toBe("Group Technology > Parent");
    expect(child.lastModified).toBe("2026-02-02");
    expect(child.fingerprint).toBe("v4");
    expect(child.lang).toBe("en");
    expect(ds.find((d) => d.sourceId === "confluence:CTO:100")?.lang).toBe("it");
    expect(events.some((e) => e.type === "skip" && e.sourceId === "confluence:CTO:102")).toBe(true);
    expect(calls.some((c) => c.includes("/spaces/11/"))).toBe(false);
    expect(calls.some((c) => c.includes("/spaces/12/"))).toBe(false);
    expect(child.extra["space_type"]).toBe("collaboration");
  });

  it("falls back to the api.atlassian.com gateway for scoped tokens and keeps site URLs for links", async () => {
    const gateway = (u: URL) => u.host === "api.atlassian.com";
    const { fetchImpl, calls } = fakeFetch({
      "/_edge/tenant_info": { cloudId: "cid-123" },
      "/wiki/api/v2/spaces?": (u: URL) => (gateway(u) ? routes["/wiki/api/v2/spaces?"] : new Response("<html>401</html>", { status: 401 })),
      "/wiki/api/v2/spaces/10/pages": (u: URL) => (gateway(u) ? routes["/wiki/api/v2/spaces/10/pages"] : new Response("", { status: 401 })),
      "/wiki/api/v2/pages/100?": (u: URL) => (gateway(u) ? routes["/wiki/api/v2/pages/100?"] : new Response("", { status: 401 })),
      "/wiki/api/v2/pages/101?": (u: URL) => (gateway(u) ? routes["/wiki/api/v2/pages/101?"] : new Response("", { status: 401 })),
      "/wiki/api/v2/pages/102?": (u: URL) => (gateway(u) ? routes["/wiki/api/v2/pages/102?"] : new Response("", { status: 401 })),
    });
    const api = await resolveConfluenceApi(createHttp({ fetchImpl, retries: 0 }), base);
    expect(api).toEqual({ apiOrigin: "https://api.atlassian.com/ex/confluence/cid-123", siteUrl: base, mode: "gateway" });
    const events = await collect(syncConfluence(ctx(fetchImpl, base)));
    const child = docs(events).find((d) => d.sourceId === "confluence:CTO:101")!;
    expect(child.sourceUrl).toBe(`${base}/wiki/spaces/CTO/pages/101/Child+page`);
    expect(calls.filter((c) => c.startsWith("/ex/confluence/cid-123/wiki/api/v2/")).length).toBeGreaterThan(3);
  });

  it("selectSpaces keeps every non-personal type and honours include/exclude", () => {
    const spaces = [
      { id: "1", key: "CTO", name: "", type: "collaboration", status: "current" },
      { id: "2", key: "GP", name: "", type: "knowledge_base", status: "current" },
      { id: "3", key: "TH", name: "", type: "global", status: "current" },
      { id: "4", key: "~me", name: "", type: "personal", status: "current" },
      { id: "5", key: "OLD", name: "", type: "global", status: "archived" },
    ];
    expect(selectSpaces(spaces, [], ["th"], false).map((s) => s.key)).toEqual(["CTO", "GP"]);
    expect(selectSpaces(spaces, ["gp"], [], false).map((s) => s.key)).toEqual(["GP"]);
    expect(selectSpaces(spaces, [], [], true).map((s) => s.key)).toEqual(["CTO", "GP", "TH", "~me"]);
  });

  it("does not download pages whose version is unchanged", async () => {
    const { fetchImpl, calls } = fakeFetch(routes);
    const previous: Pick<SyncState, "items" | "meta"> = {
      items: { "confluence:CTO:101": { relPath: "confluence/CTO/101-child-page.md", fingerprint: "v4", title: "Child page", sourceUrl: null, syncedAt: "" } },
      meta: {},
    };
    const events = await collect(syncConfluence(ctx(fetchImpl, base, { previous })));
    expect(events.some((e) => e.type === "unchanged" && e.sourceId === "confluence:CTO:101")).toBe(true);
    expect(calls.some((c) => c.startsWith("/wiki/api/v2/pages/101?"))).toBe(false);
    expect(calls.some((c) => c.startsWith("/wiki/api/v2/pages/100?"))).toBe(true);
  });
});

describe("Dev Portal connector", () => {
  const base = "https://development.teamsystem.com";
  const page = (title: string, body: string) =>
    `<html><head><title>${title} - Site</title></head><body><nav class="md-nav">nav</nav><article class="md-content__inner"><a class="md-content__button" href="https://biosphere.teamsystem.com/tsdigital/oneplatform/hermes-2.0/docs/-/edit/main/docs/x.md">e</a><h1>${title}<a class="headerlink" href="#">¶</a></h1><p>${body}</p></article></body></html>`;
  const routes = {
    "/api/catalog/entities/by-query?filter=metadata.annotations.backstage.io%2Ftechdocs-ref": {
      items: [
        {
          kind: "Module",
          metadata: {
            name: "hermes",
            namespace: "default",
            title: "Hermes",
            annotations: { "backstage.io/techdocs-ref": "dir:.", "backstage.io/source-location": "url:https://biosphere.teamsystem.com/tsdigital/oneplatform/hermes-2.0/docs/-/tree/main/" },
            tags: ["streaming"],
          },
          spec: { owner: "group:platform", system: "oneplatform", lifecycle: "production", type: "library" },
        },
      ],
      pageInfo: {},
    },
    "/api/catalog/entities/by-query?filter=kind%3Dapi": {
      items: [{ kind: "API", metadata: { name: "workspace-read", description: "Read workspaces." }, spec: { type: "openapi", owner: "team-a", definition: "openapi: 3.0.0\ninfo:\n  title: Workspace Read\n" } }],
      pageInfo: {},
    },
    "/api/techdocs/metadata/techdocs/default/module/hermes": { site_name: "Hermes", etag: "abc123", build_timestamp: 1_756_000_000, files: ["index.html", "consume-records/index.html", "assets/x.css", "404.html", "search/search_index.json"] },
    "/api/techdocs/static/docs/default/module/hermes/index.html": page("Hermes 2.0", "Hermes is the streaming platform used by every product to publish domain events to the consumers."),
    "/api/techdocs/static/docs/default/module/hermes/consume-records/index.html": page("Consume records", "Bootstrap servers are listed in the table below for each environment of the platform."),
  };

  it("indexes every TechDocs page of every documented entity, plus API definitions, and reports covered repos", async () => {
    const { fetchImpl } = fakeFetch(routes);
    const events = await collect(syncDevPortal(ctx(fetchImpl, base)));
    const ds = docs(events);
    expect(ds.map((d) => d.sourceId).sort()).toEqual(["devportal:default/api/workspace-read#definition", "devportal:default/module/hermes/", "devportal:default/module/hermes/consume-records/"]);
    const consume = ds.find((d) => d.sourceId.endsWith("consume-records/"))!;
    expect(consume.title).toBe("Consume records");
    expect(consume.relPath).toBe("devportal/module/hermes/consume-records.md");
    expect(consume.sourceUrl).toBe(`${base}/docs/default/module/hermes/consume-records/`);
    expect(consume.body).not.toContain("nav");
    expect(consume.body).not.toContain("¶");
    expect(consume.extra["owner"]).toBe("group:platform");
    expect(consume.extra["edit_url"]).toContain("/-/edit/main/docs/x.md");
    expect(consume.fingerprint).toBe("abc123");
    expect(consume.lastModified).toBe("2025-08-24");
    const api = ds.find((d) => d.sourceId.includes("#definition"))!;
    expect(api.body).toContain("```yaml\nopenapi: 3.0.0");
    expect(api.relPath).toBe("devportal/api/workspace-read/__definition.md");
    const meta = events.find((e) => e.type === "meta" && e.key === "coveredRepos") as { value: string[] };
    expect(meta.value).toEqual(["tsdigital/oneplatform/hermes-2.0/docs"]);
  });

  it("skips an entity entirely when its TechDocs etag is unchanged", async () => {
    const { fetchImpl, calls } = fakeFetch(routes);
    const previous: Pick<SyncState, "items" | "meta"> = {
      items: {
        "devportal:default/module/hermes/": { relPath: "devportal/module/hermes/index.md", fingerprint: "abc123", title: "Hermes 2.0", sourceUrl: null, syncedAt: "" },
        "devportal:default/module/hermes/consume-records/": { relPath: "devportal/module/hermes/consume-records.md", fingerprint: "abc123", title: "Consume records", sourceUrl: null, syncedAt: "" },
      },
      meta: {},
    };
    const cfg = structuredClone(DEFAULT_SOURCES);
    cfg.devportal.include_api_definitions = false;
    const events = await collect(syncDevPortal(ctx(fetchImpl, base, { previous }, cfg)));
    expect(events.filter((e) => e.type === "unchanged")).toHaveLength(2);
    expect(docs(events)).toHaveLength(0);
    expect(calls.some((c) => c.includes("/api/techdocs/static/"))).toBe(false);
  });

  it("helpers: locations, page paths, repo extraction", () => {
    expect(pagesFromSearchIndex({ docs: [{ location: "" }, { location: "a/" }, { location: "a/#frag" }, { location: "b.html" }, { location: "c" }] }).sort()).toEqual(["a/index.html", "b.html", "c/index.html", "index.html"]);
    expect(pagePathOf("index.html")).toBe("");
    expect(pagePathOf("a/b/index.html")).toBe("a/b/");
    expect(pagePathOf("a/b.html")).toBe("a/b/");
    expect(gitlabProjectFromLocation("url:https://biosphere.teamsystem.com/Grp/Sub/Proj/-/blob/main/catalog-info.yaml")).toBe("grp/sub/proj");
    expect(gitlabProjectFromLocation("url:https://biosphere.teamsystem.com/grp/proj.git")).toBe("grp/proj");
    expect(gitlabProjectFromLocation("url:https://biosphere.teamsystem.com/grp/sub/proj/blob/master/catalog-info.yml")).toBe("grp/sub/proj");
    expect(gitlabProjectFromLocation("url:https://teamsystem.atlassian.net/wiki/spaces/tts/pages/1/x", "biosphere.teamsystem.com")).toBeNull();
    expect(gitlabProjectFromLocation("url:https://biosphere.teamsystem.com/onlygroup")).toBeNull();
    expect(gitlabProjectFromLocation("dir:.")).toBeNull();
    expect(buildDate(1_756_000_000)).toBe("2025-08-24");
    expect(buildDate(1_787_913_180_907)).toBe("2026-08-28");
    expect(buildDate(undefined)).toBeNull();
    expect(gitlabProjectFromLocation(undefined)).toBeNull();
  });
});

describe("GitLab connector", () => {
  const base = "https://biosphere.teamsystem.com";
  const projects = [
    { id: 1, path_with_namespace: "oneplatform/adrs", web_url: `${base}/oneplatform/adrs`, default_branch: "main", last_activity_at: "2026-09-01T10:00:00Z", archived: false },
    { id: 2, path_with_namespace: "oneplatform/hermes-docs", web_url: `${base}/oneplatform/hermes-docs`, default_branch: "main", last_activity_at: "2026-09-01T10:00:00Z", archived: false },
    { id: 3, path_with_namespace: "oneplatform/empty", web_url: `${base}/oneplatform/empty`, default_branch: null, last_activity_at: "2026-09-01T10:00:00Z", archived: false, empty_repo: true },
  ];
  const routes = {
    "/api/v4/groups/oneplatform/projects": projects,
    "/api/v4/projects/1/repository/tree": [
      { id: "sha-readme", name: "README.md", type: "blob", path: "README.md" },
      { id: "sha-adr1", name: "ADR0001_cqrs.md", type: "blob", path: "Platform/ADR0001_cqrs.md" },
      { id: "sha-nm", name: "x.md", type: "blob", path: "web/node_modules/x.md" },
      { id: "sha-dir", name: "Platform", type: "tree", path: "Platform" },
      { id: "sha-ts", name: "index.ts", type: "blob", path: "src/index.ts" },
    ],
    "/api/v4/projects/1/repository/files/README.md/raw": () => new Response("# ADRs\n\nArchitecture decision records for the platform, reviewed by the core architects team.", { status: 200 }),
    "/api/v4/projects/1/repository/files/Platform%2FADR0001_cqrs.md/raw": () =>
      new Response("---\ntitle: ADR0001 CQRS\nstatus: accepted\n---\n\n## Status\n\nAccepted. This record describes the CQRS approach adopted for the platform backend services.", { status: 200 }),
    "/api/v4/projects/1/repository/commits?path=README.md": [{ committed_date: "2025-05-05T12:00:00Z" }],
    "/api/v4/projects/1/repository/commits?path=Platform%2FADR0001_cqrs.md": [{ committed_date: "2022-05-05T12:00:00Z" }],
  };

  it("discovers group projects, filters markdown by globs, skips repos covered by the Dev Portal", async () => {
    const { fetchImpl, calls } = fakeFetch(routes);
    const cfg = structuredClone(DEFAULT_SOURCES);
    cfg.gitlab.groups = ["oneplatform"];
    cfg.gitlab.exclude_projects = ["oneplatform/EMPTY"];
    const otherState = async (name: string): Promise<SyncState | null> =>
      name === "devportal" ? { version: 1, source: "devportal", lastRunAt: null, items: {}, meta: { coveredRepos: ["oneplatform/hermes-docs"] } } : null;
    const events = await collect(syncGitLab(ctx(fetchImpl, base, { otherState }, cfg)));
    const ds = docs(events);
    expect(ds.map((d) => d.sourceId).sort()).toEqual(["gitlab:oneplatform/adrs:Platform/ADR0001_cqrs.md", "gitlab:oneplatform/adrs:README.md"]);
    const adr = ds.find((d) => d.sourceId.endsWith("ADR0001_cqrs.md"))!;
    expect(adr.title).toBe("ADR0001 CQRS");
    expect(adr.body.startsWith("## Status")).toBe(true);
    expect(adr.relPath).toBe("gitlab/oneplatform/adrs/Platform/ADR0001_cqrs.md");
    expect(adr.sourceUrl).toBe(`${base}/oneplatform/adrs/-/blob/main/Platform/ADR0001_cqrs.md`);
    expect(adr.lastModified).toBe("2022-05-05");
    expect(adr.fingerprint).toBe("sha-adr1");
    expect(calls.some((c) => c.includes("/projects/2/"))).toBe(false);
    expect(calls.some((c) => c.includes("/projects/3/"))).toBe(false);
    const meta = events.find((e) => e.type === "meta" && e.key === "projectActivity") as { value: Record<string, string> };
    expect(meta.value["oneplatform/empty"]).toBeUndefined();
    expect(meta.value["oneplatform/adrs"]).toBe("2026-09-01T10:00:00Z");
  });

  it("skips listing a project whose last_activity_at did not change, and unchanged blobs otherwise", async () => {
    const cfg = structuredClone(DEFAULT_SOURCES);
    cfg.gitlab.groups = ["oneplatform"];
    cfg.gitlab.skip_if_in_devportal = false;
    const previous: Pick<SyncState, "items" | "meta"> = {
      items: { "gitlab:oneplatform/adrs:README.md": { relPath: "gitlab/oneplatform/adrs/README.md", fingerprint: "sha-readme", title: "ADRs", sourceUrl: null, syncedAt: "" } },
      meta: { projectActivity: { "oneplatform/adrs": "2026-09-01T10:00:00Z" } },
    };
    let { fetchImpl, calls } = fakeFetch(routes);
    let events = await collect(syncGitLab(ctx(fetchImpl, base, { previous }, cfg)));
    expect(events.filter((e) => e.type === "unchanged")).toHaveLength(1);
    expect(calls.some((c) => c.includes("/projects/1/repository/tree"))).toBe(false);

    // Activity changed: tree is listed, README blob unchanged, ADR downloaded.
    previous.meta = { projectActivity: { "oneplatform/adrs": "2026-08-01T10:00:00Z" } };
    ({ fetchImpl, calls } = fakeFetch(routes));
    events = await collect(syncGitLab(ctx(fetchImpl, base, { previous }, cfg)));
    expect(events.some((e) => e.type === "unchanged" && e.sourceId === "gitlab:oneplatform/adrs:README.md")).toBe(true);
    expect(docs(events).map((d) => d.sourceId)).toEqual(["gitlab:oneplatform/adrs:Platform/ADR0001_cqrs.md"]);
    expect(calls.some((c) => c.includes("/files/README.md/raw"))).toBe(false);
  });

  it("selectMarkdownFiles honours include/exclude globs", () => {
    const tree = [
      { id: "1", name: "a.md", type: "blob" as const, path: "docs/a.md" },
      { id: "2", name: "CHANGELOG.md", type: "blob" as const, path: "CHANGELOG.md" },
      { id: "3", name: "b.txt", type: "blob" as const, path: "b.txt" },
    ];
    expect(selectMarkdownFiles(tree, ["**/*.md"], ["**/CHANGELOG*"]).map((t) => t.path)).toEqual(["docs/a.md"]);
  });
});
