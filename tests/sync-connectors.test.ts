import { describe, expect, it } from "vitest";
import { buildCql, cleanExcerpt, createConfluenceLookup, resolveConfluenceApi, searchTerms } from "../src/sync/confluence.js";
import { codeSkipReason, declaredSymbols, fenceFor, isDeclarationStart, languageOf, renderCodeBody } from "../src/sync/code.js";
import { buildDate, entityExcluder, gitlabProjectFromLocation, pagePathOf, pagesFromSearchIndex, syncDevPortal } from "../src/sync/devportal.js";
import { apiSpecInfo, selectFiles, selectMarkdownFiles, syncGitLab } from "../src/sync/gitlab.js";
import { createHttp } from "../src/sync/http.js";
import { buildProjectCard } from "../src/sync/project-card.js";
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

describe("Confluence lookup (enrichment, not indexing)", () => {
  const base = "https://teamsystem.atlassian.net";
  const hit = (title: string, space: string, webui: string, excerpt: string) => ({
    content: { id: "1", title, type: "page", _links: { webui } },
    excerpt,
    lastModified: "2026-02-05T09:34:55.000Z",
    resultGlobalContainer: { title: space, displayUrl: `/spaces/${space}` },
  });

  it("builds CQL with title-first / text-second and space scoping", () => {
    expect(searchTerms(["Core Registry", "core-registry", "api", "abc", 'we"ird'])).toEqual(["Core Registry", "core-registry", "we ird"]);
    expect(buildCql(["Hermes"], "title", { include: ["CTO", "TeamCore"], exclude: [] })).toBe('type=page AND space in ("CTO","TeamCore") AND (title ~ "Hermes")');
    expect(buildCql(["a b", "c"], "text", { include: [], exclude: ["UP"] })).toBe('type=page AND space not in ("UP") AND (text ~ "a b" OR text ~ "c")');
    expect(cleanExcerpt("The @@@hl@@@Hermes@@@endhl@@@  topic\n naming", 12)).toBe("The Hermes …");
  });

  it("searches through the gateway for scoped tokens, merges title and text hits, drops personal spaces", async () => {
    const gateway = (u: URL) => u.host === "api.atlassian.com";
    const { fetchImpl, calls } = fakeFetch({
      "/_edge/tenant_info": { cloudId: "cid-123" },
      "/wiki/api/v2/spaces?": (u: URL) => (gateway(u) ? { results: [] } : new Response("<html>401</html>", { status: 401 })),
      "/wiki/rest/api/search?cql=type%3Dpage%20AND%20(title": {
        results: [hit("Hermes 2.0 onboarding", "TeamCore", "/spaces/TeamCore/pages/1/Hermes+2.0+onboarding", "How to @@@hl@@@onboard@@@endhl@@@ a producer")],
      },
      "/wiki/rest/api/search?cql=type%3Dpage%20AND%20(text": {
        results: [
          hit("Hermes 2.0 onboarding", "TeamCore", "/spaces/TeamCore/pages/1/Hermes+2.0+onboarding", "dup"),
          hit("My notes", "Someone", "/spaces/~712020abc/pages/9/My+notes", "personal"),
          hit("Audit log architecture", "TeamCore", "/spaces/TeamCore/pages/2/Audit+log", "events flow through Hermes"),
          hit("Release notes", "CTO", "/spaces/CTO/pages/3/Release", "Hermes mentioned"),
        ],
      },
    });
    const api = await resolveConfluenceApi(createHttp({ fetchImpl, retries: 0 }), base);
    expect(api.mode).toBe("gateway");
    const lookup = createConfluenceLookup(createHttp({ fetchImpl, retries: 0 }), base, { spaces: { include: [], exclude: [] }, max_pages_per_project: 3, excerpt_chars: 100 });
    const hits = await lookup.confluencePages(["hermes-2.0", "Hermes"]);
    expect(hits.map((h) => h.title)).toEqual(["Hermes 2.0 onboarding", "Audit log architecture", "Release notes"]);
    expect(hits[0]).toMatchObject({ space: "TeamCore", url: `${base}/wiki/spaces/TeamCore/pages/1/Hermes+2.0+onboarding`, excerpt: "How to onboard a producer", lastModified: "2026-02-05" });
    expect(calls.filter((c) => c.includes("/wiki/rest/api/search")).every((c) => c.startsWith("/ex/confluence/cid-123/"))).toBe(true);
    expect(await lookup.confluencePages(["api", "app"])).toEqual([]);
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
            description: "Event streaming platform.",
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
    "/api/techdocs/metadata/techdocs/default/module/hermes": {
      site_name: "Hermes",
      etag: "abc123",
      build_timestamp: 1_756_000_000,
      files: ["index.html", "consume-records/index.html", "reference/Model/index.html", "reference/Empty/index.html", "generated/mod/index.html", "assets/x.css", "404.html", "search/search_index.json"],
    },
    "/api/techdocs/static/docs/default/module/hermes/index.html": page("Hermes 2.0", "Hermes is the streaming platform used by every product to publish domain events to the consumers of the platform."),
    "/api/techdocs/static/docs/default/module/hermes/consume-records/index.html": page("Consume records", "Bootstrap servers are listed in the table below for each environment of the platform, with the credentials a consumer group needs."),
    // Generated reference pages: a Swagger model (empty table + back links) and a Sphinx module dump.
    "/api/techdocs/static/docs/default/module/hermes/reference/Model/index.html": page("IO.Swagger.Model.EClosingAccountsIndicator", '<table><tr><th>Name</th><th>Type</th></tr><tr><td></td><td></td></tr></table><p>[[Back to Model list]](x) [[Back to README]](y)</p>'),
    "/api/techdocs/static/docs/default/module/hermes/reference/Empty/index.html": page("Empty", "<table><tr><th>Name</th></tr><tr><td></td></tr></table>"),
    "/api/techdocs/static/docs/default/module/hermes/generated/mod/index.html": page("ai_marketing.environment.env module", "<p>Bases: <code>SystemEnv</code></p><p>Init func. first of all the .env file is loaded if it is present, then every non optional field is checked and validated.</p>"),
  };

  it("indexes every TechDocs page of every documented entity, plus API definitions, and reports covered repos + entities", async () => {
    const { fetchImpl } = fakeFetch(routes);
    const events = await collect(syncDevPortal(ctx(fetchImpl, base)));
    const ds = docs(events);
    // The generated reference pages and the empty template are skipped by the quality heuristics.
    expect(ds.map((d) => d.sourceId).sort()).toEqual(["devportal:default/api/workspace-read#definition", "devportal:default/module/hermes/", "devportal:default/module/hermes/consume-records/"]);
    const skips = events.filter((e) => e.type === "skip").map((e) => `${e.sourceId}: ${e.reason}`);
    expect(skips).toContain("devportal:default/module/hermes/reference/Model/: generated reference page");
    expect(skips).toContain("devportal:default/module/hermes/generated/mod/: generated reference page");
    expect(skips.some((x) => x.startsWith("devportal:default/module/hermes/reference/Empty/: stub"))).toBe(true);
    const consume = ds.find((d) => d.sourceId.endsWith("consume-records/"))!;
    expect(consume.title).toBe("Consume records");
    expect(consume.relPath).toBe("devportal/module/hermes/consume-records.md");
    expect(consume.sourceUrl).toBe(`${base}/docs/default/module/hermes/consume-records/`);
    expect(consume.body).not.toContain("nav");
    expect(consume.body).not.toContain("¶");
    expect(consume.extra["owner"]).toBe("group:platform");
    expect(consume.extra["entity_description"]).toBe("Event streaming platform.");
    expect(consume.extra["edit_url"]).toContain("/-/edit/main/docs/x.md");
    expect(consume.fingerprint).toMatch(/^abc123\|[0-9a-f]{8}$/); // build id + filter settings
    expect(consume.extra["breadcrumb"]).toBe("Dev Portal › Hermes");
    expect(consume.lastModified).toBe("2025-08-24");
    const api = ds.find((d) => d.sourceId.includes("#definition"))!;
    expect(api.body).toContain("```yaml\nopenapi: 3.0.0");
    expect(api.kind).toBe("api");
    expect(api.relPath).toBe("devportal/api/workspace-read/__definition.md");
    const meta = events.find((e) => e.type === "meta" && e.key === "coveredRepos") as { value: string[] };
    expect(meta.value).toEqual(["tsdigital/oneplatform/hermes-2.0/docs"]);
    const ents = events.find((e) => e.type === "meta" && e.key === "repoEntities") as { value: Record<string, unknown> };
    expect(ents.value["tsdigital/oneplatform/hermes-2.0/docs"]).toMatchObject({ ref: "default/module/hermes", owner: "group:platform", system: "oneplatform", lifecycle: "production", description: "Event streaming platform.", url: `${base}/catalog/default/module/hermes` });
  });

  it("skips an entity entirely when its TechDocs etag is unchanged", async () => {
    const cfg = structuredClone(DEFAULT_SOURCES);
    cfg.devportal.include_api_definitions = false;
    const fingerprint = docs(await collect(syncDevPortal(ctx(fakeFetch(routes).fetchImpl, base, {}, cfg))))[0]!.fingerprint;
    const { fetchImpl, calls } = fakeFetch(routes);
    const previous: Pick<SyncState, "items" | "meta"> = {
      items: {
        "devportal:default/module/hermes/": { relPath: "devportal/module/hermes/index.md", fingerprint, title: "Hermes 2.0", sourceUrl: null, syncedAt: "" },
        "devportal:default/module/hermes/consume-records/": { relPath: "devportal/module/hermes/consume-records.md", fingerprint, title: "Consume records", sourceUrl: null, syncedAt: "" },
      },
      meta: {},
    };
    const events = await collect(syncDevPortal(ctx(fetchImpl, base, { previous }, cfg)));
    expect(events.filter((e) => e.type === "unchanged")).toHaveLength(2);
    expect(docs(events)).toHaveLength(0);
    expect(calls.some((c) => c.includes("/api/techdocs/static/"))).toBe(false);

    // A changed filter setting re-evaluates the entity even though the build did not move.
    cfg.devportal.min_prose_words = 3;
    const again = await collect(syncDevPortal(ctx(fakeFetch(routes).fetchImpl, base, { previous }, cfg)));
    expect(again.filter((e) => e.type === "unchanged")).toHaveLength(0);
    expect(docs(again).length).toBeGreaterThan(0);
  });

  it("does not re-download an unchanged entity whose every page was a stub", async () => {
    const cfg = structuredClone(DEFAULT_SOURCES);
    cfg.devportal.include_api_definitions = false;
    cfg.devportal.min_prose_words = 500; // everything is a stub
    const first = await collect(syncDevPortal(ctx(fakeFetch(routes).fetchImpl, base, {}, cfg)));
    expect(docs(first)).toHaveLength(0);
    const builds = (first.find((e) => e.type === "meta" && e.key === "entityBuilds") as { value: Record<string, string> }).value;
    expect(Object.keys(builds)).toEqual(["default/module/hermes"]);
    const { fetchImpl, calls } = fakeFetch(routes);
    const second = await collect(syncDevPortal(ctx(fetchImpl, base, { previous: { items: {}, meta: { entityBuilds: builds } } }, cfg)));
    expect(calls.some((c) => c.includes("/api/techdocs/static/"))).toBe(false);
    expect(second.filter((e) => e.type === "skip")).toHaveLength(0);
  });

  it("excludes pages by glob and entities by wildcard", async () => {
    const cfg = structuredClone(DEFAULT_SOURCES);
    cfg.devportal.include_api_definitions = false;
    cfg.devportal.exclude_pages = ["module/hermes/consume-*/**", "**/reference/**"];
    const { fetchImpl, calls } = fakeFetch(routes);
    const events = await collect(syncDevPortal(ctx(fetchImpl, base, {}, cfg)));
    expect(docs(events).map((d) => d.sourceId)).toEqual(["devportal:default/module/hermes/"]);
    expect(calls.some((c) => c.includes("consume-records") || c.includes("/reference/"))).toBe(false);
    expect(events.filter((e) => e.type === "skip" && e.reason.includes("exclude_pages"))).toHaveLength(3);

    const excluded = entityExcluder(["module/her*", "default/component/x"]);
    expect(excluded("module", "hermes", "default/module/hermes")).toBe(true);
    expect(excluded("component", "x", "default/component/x")).toBe(true);
    expect(excluded("component", "hermes", "default/component/hermes")).toBe(false);
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

describe("code helpers", () => {
  it("detects languages, junk files and declarations", () => {
    expect(languageOf("src/a.ts")).toBe("typescript");
    expect(languageOf("Dockerfile")).toBe("dockerfile");
    expect(languageOf("deploy/Dockerfile.prod")).toBe("dockerfile");
    expect(languageOf("Makefile")).toBe("makefile");
    expect(languageOf("x.unknownext")).toBe("");
    expect(codeSkipReason("a b", { maxLines: 10 })).toBe("binary");
    expect(codeSkipReason("// @generated by protoc\nx", { maxLines: 10 })).toBe("generated file");
    expect(codeSkipReason(Array.from({ length: 11 }, () => "x").join("\n"), { maxLines: 10 })).toMatch(/too many lines/);
    expect(codeSkipReason(`${"x".repeat(2000)}\n`, { maxLines: 10 })).toMatch(/minified/);
    expect(codeSkipReason("function a() {}\n", { maxLines: 10 })).toBeNull();
    expect(fenceFor("a `b` c")).toBe("```");
    expect(fenceFor("```md\nx\n```")).toBe("````");
    expect(renderCodeBody("x = 1\r\n\n", "python")).toBe("```python\nx = 1\n```");
    expect(declaredSymbols("export async function load(a) {}\nclass Foo {}\ndef bar():\n  pass\nfun baz() = 1\nCREATE TABLE users (id int);\n@Get('/items/:id')\nresource \"aws_s3_bucket\" \"logs\" {}", 10)).toEqual(["load", "Foo", "bar", "baz", "users", "/items/:id", "aws_s3_bucket.logs"]);
    expect(isDeclarationStart("export function x() {")).toBe(true);
    expect(isDeclarationStart("  inner = 1")).toBe(false);
    expect(isDeclarationStart("}")).toBe(false);
    expect(isDeclarationStart("import x from 'y'")).toBe(false);
  });
});

describe("project card", () => {
  it("puts the essentials first, then README and Confluence pages", () => {
    const { title, body } = buildProjectCard({
      path: "oneplatform/islands/registry/core-registry",
      name: "Core Registry",
      webUrl: "https://g/oneplatform/islands/registry/core-registry",
      description: "Registry of items.",
      defaultBranch: "main",
      lastActivity: "2026-09-01",
      topics: ["registry"],
      languages: { TypeScript: 80.5, Dockerfile: 19.5 },
      entity: { ref: "default/component/core-registry", kind: "component", title: "Core Registry", owner: "group:team-core", system: "registry", lifecycle: "production", type: "service", description: "The registry." },
      readme: "# Core Registry\n\nStores items.\n\n## Run\n\nnpm start",
      confluence: [{ title: "Registry - Documentazione", url: "https://c/x", space: "RPDD", excerpt: "Il mondo Registry", lastModified: "2026-04-11" }],
      files: { total: 120, code: 90, docs: 5, topDirs: ["src", "docs"] },
    });
    expect(title).toBe("Core Registry (oneplatform/islands/registry/core-registry)");
    expect(body.indexOf("Registry of items.")).toBeLessThan(body.indexOf("## Summary"));
    expect(body).toContain("- Dev Portal: Core Registry (component `default/component/core-registry`); owner group:team-core; system registry; lifecycle production; type service");
    expect(body).toContain("- Languages: TypeScript 81%, Dockerfile 20%");
    expect(body).toContain("- Contents: 90 source files, 5 documentation files; top-level folders: src, docs");
    expect(body).toContain("## README\n\n## Core Registry\n\nStores items.\n\n### Run");
    expect(body).toContain("- [Registry - Documentazione](https://c/x) (RPDD, updated 2026-04-11): Il mondo Registry");
  });
});

describe("GitLab connector", () => {
  const base = "https://biosphere.teamsystem.com";
  const projects = [
    { id: 1, name: "ADRs", path_with_namespace: "oneplatform/adrs", web_url: `${base}/oneplatform/adrs`, description: "Architecture decisions.", default_branch: "main", last_activity_at: "2026-09-01T10:00:00Z", archived: false, topics: ["architecture"] },
    { id: 2, name: "hermes-docs", path_with_namespace: "oneplatform/hermes-docs", web_url: `${base}/oneplatform/hermes-docs`, default_branch: "main", last_activity_at: "2026-09-01T10:00:00Z", archived: false },
    { id: 3, name: "empty", path_with_namespace: "oneplatform/empty", web_url: `${base}/oneplatform/empty`, default_branch: null, last_activity_at: "2026-09-01T10:00:00Z", archived: false, empty_repo: true },
  ];
  const tree1 = [
    { id: "sha-readme", name: "README.md", type: "blob", path: "README.md" },
    { id: "sha-adr1", name: "ADR0001_cqrs.md", type: "blob", path: "Platform/ADR0001_cqrs.md" },
    { id: "sha-nm", name: "x.md", type: "blob", path: "web/node_modules/x.md" },
    { id: "sha-dir", name: "Platform", type: "tree", path: "Platform" },
    { id: "sha-src", name: "src", type: "tree", path: "src" },
    { id: "sha-ts", name: "index.ts", type: "blob", path: "src/index.ts" },
    { id: "sha-test", name: "index.test.ts", type: "blob", path: "src/index.test.ts" },
    { id: "sha-lock", name: "package-lock.json", type: "blob", path: "package-lock.json" },
    { id: "sha-min", name: "bundle.min.js", type: "blob", path: "dist/bundle.min.js" },
    { id: "sha-docs", name: "index.md", type: "blob", path: "docs/index.md" },
    { id: "sha-oas", name: "openapi.yaml", type: "blob", path: "api/openapi.yaml" },
    { id: "sha-oas-test", name: "openapi.yaml", type: "blob", path: "test/openapi.yaml" },
    { id: "sha-lic", name: "LICENSE.md", type: "blob", path: "LICENSE.md" },
    { id: "sha-cra", name: "README.md", type: "blob", path: "web/README.md" },
  ];
  const code = "import { x } from './x';\n\nexport function handler(req: Request) {\n  return x(req);\n}\n";
  const openapi = "openapi: 3.0.3\ninfo:\n  title: Items API\n  version: 1.2.0\n  description: Read and write items.\npaths:\n  /items:\n    get:\n      summary: List items\n";
  const routes = {
    "/api/v4/groups/oneplatform/projects": projects,
    "/api/v4/projects/1/repository/branches/main": { commit: { id: "head-1", committed_date: "2026-08-30T12:00:00Z" } },
    "/api/v4/projects/2/repository/branches/main": { commit: { id: "head-2", committed_date: "2026-08-30T12:00:00Z" } },
    "/api/v4/projects/1/repository/tree": tree1,
    "/api/v4/projects/2/repository/tree": [
      { id: "sha-hreadme", name: "README.md", type: "blob", path: "README.md" },
      { id: "sha-hdocs", name: "index.md", type: "blob", path: "docs/index.md" },
    ],
    "/api/v4/projects/1/languages": { TypeScript: 70, Markdown: 30 },
    "/api/v4/projects/2/languages": {},
    "/api/v4/projects/1/repository/files/README.md/raw": () => new Response("# ADRs\n\nArchitecture decision records for the platform, reviewed by the core architects team.", { status: 200 }),
    "/api/v4/projects/2/repository/files/README.md/raw": () => new Response("# Hermes docs\n\nThe documentation of the Hermes streaming platform for producers and consumers.", { status: 200 }),
    "/api/v4/projects/2/repository/files/docs%2Findex.md/raw": () => new Response("# Hermes\n\nWelcome to the Hermes documentation site, rendered in the portal.", { status: 200 }),
    "/api/v4/projects/1/repository/files/Platform%2FADR0001_cqrs.md/raw": () =>
      new Response("---\ntitle: ADR0001 CQRS\nstatus: accepted\n---\n\n## Status\n\nAccepted. This record describes the CQRS approach adopted for the platform backend services.", { status: 200 }),
    "/api/v4/projects/1/repository/files/docs%2Findex.md/raw": () => new Response("# Docs\n\nThe docs folder of the ADR repository, which is not in the portal.", { status: 200 }),
    "/api/v4/projects/1/repository/files/src%2Findex.ts/raw": () => new Response(code, { status: 200 }),
    "/api/v4/projects/1/repository/files/api%2Fopenapi.yaml/raw": () => new Response(openapi, { status: 200 }),
    "/api/v4/projects/1/repository/files/web%2FREADME.md/raw": () => new Response("# Getting Started with Create React App\n\nThis project was bootstrapped with [Create React App](https://github.com/facebook/create-react-app).\n\n## Available Scripts\n\nIn the project directory, you can run `npm start` to run the app in development mode and open it in the browser.", { status: 200 }),
    "/api/v4/projects/1/repository/commits?path=web%2FREADME.md": [{ committed_date: "2025-05-05T12:00:00Z" }],
    "/api/v4/projects/1/repository/commits?path=README.md": [{ committed_date: "2025-05-05T12:00:00Z" }],
    "/api/v4/projects/1/repository/commits?path=Platform%2FADR0001_cqrs.md": [{ committed_date: "2022-05-05T12:00:00Z" }],
    "/api/v4/projects/1/repository/commits?path=docs%2Findex.md": [{ committed_date: "2023-05-05T12:00:00Z" }],
  };
  const cfgFor = () => {
    const cfg = structuredClone(DEFAULT_SOURCES);
    cfg.gitlab.groups = ["oneplatform"];
    cfg.gitlab.code.enabled = true; // these tests cover the optional code path too
    cfg.gitlab.min_prose_words = 8; // the fixture pages are short
    return cfg;
  };
  const devportalState = async (name: string): Promise<SyncState | null> =>
    name === "devportal"
      ? {
          version: 1,
          source: "devportal",
          lastRunAt: null,
          items: {},
          meta: { coveredRepos: ["oneplatform/hermes-docs"], repoEntities: { "oneplatform/hermes-docs": { ref: "default/module/hermes", kind: "module", owner: "group:platform", system: "oneplatform" } } },
        }
      : null;

  it("selectFiles splits docs, API specs and code, applies excludes, tests and the TechDocs rule", () => {
    const cfg = cfgFor();
    const sel = selectFiles(tree1 as never, cfg.gitlab, false);
    expect(sel.docs.map((t) => t.path)).toEqual(["README.md", "Platform/ADR0001_cqrs.md", "docs/index.md", "web/README.md"]);
    expect(sel.api.map((t) => t.path)).toEqual(["api/openapi.yaml"]); // test/ copy excluded
    expect(sel.code.map((t) => t.path)).toEqual(["src/index.ts"]);
    expect(sel.sourceFileCount).toBe(1);
    expect(selectFiles(tree1 as never, cfg.gitlab, true).docs.map((t) => t.path)).toEqual(["README.md", "Platform/ADR0001_cqrs.md", "web/README.md"]);
    cfg.gitlab.code.skip_tests = false; // the spec under test/ is not an API spec candidate, but it is a (yaml) source file
    expect(selectFiles(tree1 as never, cfg.gitlab, false).code.map((t) => t.path)).toEqual(["src/index.ts", "src/index.test.ts", "test/openapi.yaml"]);
    // Code off (the default): nothing selected, but the card still knows how many source files there are.
    cfg.gitlab.code.enabled = false;
    const off = selectFiles(tree1 as never, cfg.gitlab, false);
    expect(off.code).toEqual([]);
    expect(off.sourceFileCount).toBe(3);
    expect(selectMarkdownFiles(tree1 as never, ["**/*.md"], ["**/CHANGELOG*", "**/node_modules/**"]).map((t) => t.path)).toEqual(["README.md", "Platform/ADR0001_cqrs.md", "docs/index.md", "LICENSE.md", "web/README.md"]);

    expect(apiSpecInfo(openapi)).toEqual({ flavour: "openapi", version: "3.0.3", title: "Items API", description: "Read and write items.", format: "yaml" });
    expect(apiSpecInfo('{"swagger": "2.0", "info": {"title": "Old"}}')).toMatchObject({ flavour: "swagger", version: "2.0", title: "Old", format: "json" });
    expect(apiSpecInfo("asyncapi: '2.6.0'\ninfo:\n  title: Events\n")).toMatchObject({ flavour: "asyncapi", version: "2.6.0", title: "Events" });
    expect(apiSpecInfo("# not a spec\nfoo: bar\n")).toBeNull();
  });

  it("produces docs, code files and a project card per repository, using the portal's entities and Confluence", async () => {
    const { fetchImpl, calls } = fakeFetch(routes);
    const cfg = cfgFor();
    cfg.gitlab.exclude_projects = ["oneplatform/EMPTY"];
    const enrich = { confluencePages: async (terms: string[]) => (terms.includes("ADRs") ? [{ title: "ADR process", url: "https://c/adr", space: "CTO", excerpt: "How ADRs are written", lastModified: "2026-01-01" }] : []) };
    const events = await collect(syncGitLab(ctx(fetchImpl, base, { otherState: devportalState, enrich }, cfg)));
    const ds = docs(events);
    expect(ds.map((d) => d.sourceId).sort()).toEqual([
      "gitlab:oneplatform/adrs:Platform/ADR0001_cqrs.md",
      "gitlab:oneplatform/adrs:README.md",
      "gitlab:oneplatform/adrs:__project",
      "gitlab:oneplatform/adrs:api/openapi.yaml",
      "gitlab:oneplatform/adrs:docs/index.md",
      "gitlab:oneplatform/adrs:src/index.ts",
      "gitlab:oneplatform/hermes-docs:README.md",
      "gitlab:oneplatform/hermes-docs:__project",
    ]);
    // The Create React App README is generator boilerplate, not documentation of this repository.
    expect(events.find((e) => e.type === "skip" && e.sourceId === "gitlab:oneplatform/adrs:web/README.md")).toMatchObject({ reason: "generator boilerplate" });

    const spec = ds.find((d) => d.sourceId.endsWith("api/openapi.yaml"))!;
    expect(spec).toMatchObject({ kind: "api", title: "Items API (OpenAPI definition)", relPath: "gitlab/oneplatform/adrs/api/openapi.yaml.md", lang: "en", fingerprint: "sha-oas" });
    expect(spec.body).toContain("Read and write items.");
    expect(spec.body).toContain("OpenAPI 3.0.3 definition `api/openapi.yaml` of the repository `oneplatform/adrs`.");
    expect(spec.body).toContain("```yaml\nopenapi: 3.0.3");
    expect(spec.extra).toMatchObject({ project: "oneplatform/adrs", file_path: "api/openapi.yaml", api_type: "openapi", api_version: "3.0.3", breadcrumb: "GitLab › oneplatform/adrs" });
    const adr = ds.find((d) => d.sourceId.endsWith("ADR0001_cqrs.md"))!;
    expect(adr).toMatchObject({ kind: "doc", title: "ADR0001 CQRS", relPath: "gitlab/oneplatform/adrs/Platform/ADR0001_cqrs.md", lastModified: "2022-05-05", fingerprint: "sha-adr1" });
    expect(adr.body.startsWith("## Status")).toBe(true);
    expect(adr.extra["breadcrumb"]).toBe("GitLab › oneplatform/adrs");
    expect(adr.sourceUrl).toBe(`${base}/oneplatform/adrs/-/blob/main/Platform/ADR0001_cqrs.md`);

    const ts = ds.find((d) => d.sourceId.endsWith("src/index.ts"))!;
    expect(ts).toMatchObject({ kind: "code", title: "src/index.ts", relPath: "gitlab/oneplatform/adrs/src/index.ts.md", lastModified: "2026-08-30", lang: "und" });
    expect(ts.body).toBe(`\`\`\`typescript\n${code.trimEnd()}\n\`\`\``);
    expect(ts.extra).toMatchObject({ project: "oneplatform/adrs", file_path: "src/index.ts", language: "typescript", lines: 5 });

    const card = ds.find((d) => d.sourceId === "gitlab:oneplatform/adrs:__project")!;
    expect(card).toMatchObject({ kind: "project", relPath: "gitlab/oneplatform/adrs/__project.md", title: "ADRs (oneplatform/adrs)", sourceUrl: `${base}/oneplatform/adrs` });
    expect(card.body).toContain("Architecture decisions.");
    expect(card.body).toContain("- Languages: TypeScript 70%, Markdown 30%");
    expect(card.body).toContain("- Contents: 1 source files, 4 documentation files; top-level folders: Platform, src");
    expect(card.body).toContain("## README\n\n## ADRs");
    expect(card.body).toContain("[ADR process](https://c/adr) (CTO, updated 2026-01-01): How ADRs are written");
    expect(card.extra["confluence_pages"]).toEqual(["https://c/adr"]);

    const hermesCard = ds.find((d) => d.sourceId === "gitlab:oneplatform/hermes-docs:__project")!;
    expect(hermesCard.body).toContain("- Dev Portal: default/module/hermes (module `default/module/hermes`); owner group:platform; system oneplatform");
    expect(hermesCard.extra["owner"]).toBe("group:platform");
    // docs/ of a portal-covered repo is skipped; README kept.
    expect(calls.some((c) => c.includes("/projects/2/repository/files/docs%2Findex.md"))).toBe(false);
    expect(calls.some((c) => c.includes("/projects/3/"))).toBe(false);
    // Excluded/test/lock/min files are never downloaded.
    expect(calls.some((c) => c.includes("index.test.ts") || c.includes("package-lock") || c.includes("bundle.min"))).toBe(false);

    const heads = events.find((e) => e.type === "meta" && e.key === "projectHeads") as { value: Record<string, string> };
    expect(Object.keys(heads.value).sort()).toEqual(["oneplatform/adrs", "oneplatform/hermes-docs"]);
    expect(heads.value["oneplatform/adrs"]).toMatch(/^head-1\|[0-9a-f]{12}$/);
    // The key changes when the portal's view of the repo changes (here: hermes-docs is covered + has an entity).
    const plain = await collect(syncGitLab(ctx(fakeFetch(routes).fetchImpl, base, { enrich }, cfg)));
    const plainHeads = plain.find((e) => e.type === "meta" && e.key === "projectHeads") as { value: Record<string, string> };
    expect(plainHeads.value["oneplatform/adrs"]).toBe(heads.value["oneplatform/adrs"]);
    expect(plainHeads.value["oneplatform/hermes-docs"]).not.toBe(heads.value["oneplatform/hermes-docs"]);
    const enr = events.find((e) => e.type === "meta" && e.key === "projectEnrichment") as { value: Record<string, { hits: unknown[] }> };
    expect(enr.value["oneplatform/adrs"]?.hits).toHaveLength(1);
  });

  it("skips the code (not the docs) of a repository with more source files than max_files_per_project", async () => {
    const cfg = cfgFor();
    cfg.gitlab.code.max_files_per_project = 0;
    const events = await collect(syncGitLab(ctx(fakeFetch(routes).fetchImpl, base, {}, cfg)));
    const ids = docs(events).map((d) => d.sourceId);
    expect(ids).not.toContain("gitlab:oneplatform/adrs:src/index.ts");
    expect(ids).toContain("gitlab:oneplatform/adrs:README.md");
    const err = events.find((e) => e.type === "error" && e.sourceId === "gitlab:oneplatform/adrs:") as { message: string };
    expect(err.message).toMatch(/1 source files exceed .*src=1/);
  });

  it("skips a project whose head commit did not change, and unchanged blobs otherwise; reuses fresh Confluence lookups", async () => {
    const cfg = cfgFor();
    const first = await collect(syncGitLab(ctx(fakeFetch(routes).fetchImpl, base, {}, cfg)));
    const firstHeads = (first.find((e) => e.type === "meta" && e.key === "projectHeads") as { value: Record<string, string> }).value;
    const previous: Pick<SyncState, "items" | "meta"> = {
      items: {
        "gitlab:oneplatform/adrs:README.md": { relPath: "gitlab/oneplatform/adrs/README.md", fingerprint: "sha-readme", title: "ADRs", sourceUrl: null, syncedAt: "" },
        "gitlab:oneplatform/adrs:__project": { relPath: "gitlab/oneplatform/adrs/__project.md", fingerprint: "old", title: "ADRs", sourceUrl: null, syncedAt: "" },
        "gitlab:oneplatform/hermes-docs:__project": { relPath: "gitlab/oneplatform/hermes-docs/__project.md", fingerprint: "h", title: "hermes-docs", sourceUrl: null, syncedAt: "" },
      },
      meta: { projectHeads: { ...firstHeads }, projectEnrichment: { "oneplatform/adrs": { at: new Date().toISOString(), hits: [] } } },
    };
    let { fetchImpl, calls } = fakeFetch(routes);
    let events = await collect(syncGitLab(ctx(fetchImpl, base, { previous }, cfg)));
    expect(events.filter((e) => e.type === "unchanged")).toHaveLength(3);
    expect(docs(events)).toHaveLength(0);
    expect(calls.some((c) => c.includes("/repository/tree"))).toBe(false);

    // Head moved: tree is listed, README blob unchanged, the rest downloaded; the card is rebuilt (fingerprint differs).
    previous.meta = { ...previous.meta, projectHeads: { ...firstHeads, "oneplatform/adrs": "older|000000000000" } };
    let lookups = 0;
    const enrich = { confluencePages: async () => (lookups++, []) };
    ({ fetchImpl, calls } = fakeFetch(routes));
    events = await collect(syncGitLab(ctx(fetchImpl, base, { previous, enrich }, cfg)));
    expect(events.some((e) => e.type === "unchanged" && e.sourceId === "gitlab:oneplatform/adrs:README.md")).toBe(true);
    expect(docs(events).map((d) => d.sourceId).sort()).toEqual(["gitlab:oneplatform/adrs:Platform/ADR0001_cqrs.md", "gitlab:oneplatform/adrs:__project", "gitlab:oneplatform/adrs:api/openapi.yaml", "gitlab:oneplatform/adrs:docs/index.md", "gitlab:oneplatform/adrs:src/index.ts"]);
    // README is still fetched once (for the card) but not re-emitted as a document.
    expect(calls.filter((c) => c.includes("/files/README.md/raw")).length).toBe(1);
    expect(calls.some((c) => c.includes("/projects/2/repository/tree"))).toBe(false);
    expect(lookups).toBe(0); // fresh enrichment reused
  });

  it("also syncs the repositories the Dev Portal points at, wherever they live, when include_devportal_repos is on", async () => {
    const cfg = cfgFor();
    cfg.gitlab.include_devportal_repos = true;
    const state = async (name: string): Promise<SyncState | null> => {
      const s = await devportalState(name);
      if (s) s.meta = { ...s.meta, coveredRepos: ["oneplatform/hermes-docs", "tsdigital/core/ts-id", "paas/private/secret"] };
      return s;
    };
    const extraRoutes = {
      ...routes,
      "/api/v4/projects/tsdigital%2Fcore%2Fts-id": { id: 9, name: "TS ID", path_with_namespace: "tsdigital/core/ts-id", web_url: `${base}/tsdigital/core/ts-id`, default_branch: "main", last_activity_at: "2026-09-01T10:00:00Z", archived: false },
      "/api/v4/projects/9/repository/branches/main": { commit: { id: "head-9", committed_date: "2026-08-30T12:00:00Z" } },
      "/api/v4/projects/9/repository/tree": [
        { id: "sha-9r", name: "README.md", type: "blob", path: "README.md" },
        { id: "sha-9d", name: "index.md", type: "blob", path: "docs/index.md" },
      ],
      "/api/v4/projects/9/languages": { "C#": 100 },
      "/api/v4/projects/9/repository/files/README.md/raw": () => new Response("# TS ID\n\nThe TeamSystem identity provider, an OpenID Connect server used by every product for single sign-on.", { status: 200 }),
    };
    const { fetchImpl, calls } = fakeFetch(extraRoutes);
    const logs: string[] = [];
    const events = await collect(syncGitLab(ctx(fetchImpl, base, { otherState: state, log: (m) => logs.push(m) }, cfg)));
    const ids = docs(events).map((d) => d.sourceId);
    expect(ids).toContain("gitlab:tsdigital/core/ts-id:README.md");
    expect(ids).toContain("gitlab:tsdigital/core/ts-id:__project");
    expect(ids).not.toContain("gitlab:tsdigital/core/ts-id:docs/index.md"); // rendered by the portal already
    expect(calls.some((c) => c.includes("/projects/paas%2Fprivate%2Fsecret"))).toBe(true); // asked, 404, counted
    expect(logs.some((l) => /1 of 2 Dev Portal repositories outside the configured groups are readable \(1 not accessible/.test(l))).toBe(true);
  });
});

describe("quality heuristics", () => {
  it("recognises generator READMEs, generated pages and stubs", async () => {
    const { isBoilerplateReadme, isStub, looksGenerated, proseStats } = await import("../src/sync/quality.js");
    expect(isBoilerplateReadme("# whatsapp-service\n\n## Getting started\n\nTo make it easy for you to get started with GitLab, here's a list of recommended next steps.\n")).toBe(true);
    expect(isBoilerplateReadme("# Getting Started with Create React App\n\nThis project was bootstrapped with [Create React App](https://x).")).toBe(true);
    expect(isBoilerplateReadme("# Hermes docs\n\nHow producers publish CloudEvents to the streaming platform and how consumers subscribe.")).toBe(false);
    expect(looksGenerated("IO.Swagger.Model.EClosingAccountsIndicator", "## Properties\n\n| Name | Type |\n| --- | --- |\n")).toBe(true);
    expect(looksGenerated("ai_marketing.environment.env module", "### class Env\n\nBases: `SystemEnv`")).toBe(true);
    expect(looksGenerated("Consume records", "Bootstrap servers are listed below for each environment.")).toBe(false);
    const stats = proseStats("# T\n\n- [a](http://x)\n- [b](http://y)\n\n| h1 | h2 |\n| --- | --- |\n| v1 | v2 |\n\n```js\nx()\n```\n\nSome real words of prose here.");
    expect(stats).toMatchObject({ proseWords: 6, tableCells: 4, codeBlocks: 1, headings: 1, linkOnlyLines: 2 });
    expect(isStub("# Metering\n\n- [Docs](http://x)\n- [API](http://y)", 15)).toBe(true);
    expect(isStub("# Metering\n\nE' il progetto che si occupa della gestione dei pacchetti e dei consumi di ogni pacchetto della piattaforma", 15)).toBe(false);
    expect(isStub("# Ref\n\n| Name | Type | Notes |\n| --- | --- | --- |\n| id | string | key |\n| name | string | label |", 15)).toBe(false); // a real table counts
  });
});
