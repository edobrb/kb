import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { KbGraph, LinkResolver, buildGraph, relationPhrase, type KbGraphFile } from "../src/graph/index.js";

const PORTAL = config.sync.devportal.baseUrl;
const GITLAB = config.sync.gitlab.baseUrl;
const WIKI = config.sync.confluence.baseUrl;

// ---- the resolver ----------------------------------------------------------------------------------

describe("LinkResolver", () => {
  const ids = [
    "confluence:CTO:1037566023",
    "devportal:default/module/policy-manager/concepts/architecture/",
    "devportal:default/component/hermes/CHANGELOG/",
    "gitlab:oneplatform/adrs:__project",
    "gitlab:oneplatform/adrs:Platform/ADR0010.md",
    "gitlab:oneplatform/adrs:openapi.yaml",
    "gitlab:oneplatform/onefront/docs:README.md",
  ];
  const r = new LinkResolver(ids, { devportal: "development.teamsystem.com", gitlab: "biosphere.teamsystem.com", confluence: "teamsystem.atlassian.net" });

  it("maps a Confluence page URL to its source_id by page id, whatever the slug says", () => {
    expect(r.resolveUrl("https://teamsystem.atlassian.net/wiki/spaces/CTO/pages/1037566023/Kiratech+Maggioli")).toEqual({ id: "confluence:CTO:1037566023" });
    // Renamed page, same id.
    expect(r.resolveUrl("https://teamsystem.atlassian.net/wiki/spaces/OTHER/pages/1037566023/Something+Else")).toEqual({ id: "confluence:CTO:1037566023" });
  });

  it("reports the Confluence links it cannot follow, without pretending they are external", () => {
    expect(r.resolveUrl("https://teamsystem.atlassian.net/wiki/spaces/CTO/pages/999/Gone")).toEqual({ reason: "confluence-page" });
    expect(r.resolveUrl("https://teamsystem.atlassian.net/wiki/x/AbCd")).toEqual({ reason: "confluence-tiny" });
  });

  it("maps a TechDocs URL to its page, ignoring case and the trailing slash", () => {
    expect(r.resolveUrl(`${PORTAL}/docs/default/module/policy-manager/concepts/architecture/`)).toEqual({
      id: "devportal:default/module/policy-manager/concepts/architecture/",
    });
    expect(r.resolveUrl(`${PORTAL}/docs/default/Component/hermes/CHANGELOG`)).toEqual({ id: "devportal:default/component/hermes/CHANGELOG/" });
  });

  it("flags a link to a portal page that is not indexed — the renamed-docs case", () => {
    expect(r.resolveUrl(`${PORTAL}/docs/default/module/policy-manager/overview/architecture/`)).toEqual({ reason: "devportal-page" });
  });

  it("maps a GitLab blob URL to the file, and the repository root to its project card", () => {
    expect(r.resolveUrl(`${GITLAB}/oneplatform/adrs/-/blob/main/Platform/ADR0010.md`)).toEqual({ id: "gitlab:oneplatform/adrs:Platform/ADR0010.md" });
    expect(r.resolveUrl(`${GITLAB}/oneplatform/adrs`)).toEqual({ id: "gitlab:oneplatform/adrs:__project" });
    // API specs keep their own extension in the id.
    expect(r.resolveUrl(`${GITLAB}/oneplatform/adrs/-/blob/main/openapi.yaml`)).toEqual({ id: "gitlab:oneplatform/adrs:openapi.yaml" });
  });

  it("separates a file it has not indexed from a repository outside the sync scope", () => {
    expect(r.resolveUrl(`${GITLAB}/oneplatform/adrs/-/blob/main/Platform/nope.md`)).toEqual({ reason: "gitlab-file" });
    expect(r.resolveUrl(`${GITLAB}/some/other/repo/-/blob/main/README.md`)).toEqual({ reason: "gitlab-repo" });
    expect(r.resolveUrl(`${GITLAB}/oneplatform/adrs/-/tree/main/Platform`)).toEqual({ reason: "gitlab-other" });
  });

  it("resolves a relative link against the document that contains it", () => {
    expect(r.resolve("./ADR0010.md", "gitlab:oneplatform/adrs:Platform/ADR0007.md")).toEqual({ id: "gitlab:oneplatform/adrs:Platform/ADR0010.md" });
    expect(r.resolve("../Platform/ADR0010.md#decision", "gitlab:oneplatform/adrs:docs/index.md")).toEqual({ id: "gitlab:oneplatform/adrs:Platform/ADR0010.md" });
    expect(r.resolve("../../elsewhere.md", "gitlab:oneplatform/adrs:README.md")).toEqual({ reason: "relative-outside" });
    // A relative link to an image is not a dangling documentation reference.
    expect(r.resolve("./diagram.png", "gitlab:oneplatform/adrs:README.md")).toEqual({ reason: "relative-unsupported" });
  });

  it("follows a TechDocs page's own relative links, in either spelling", () => {
    // As the rendered HTML writes it: relative to the page URL, which behaves as a directory.
    expect(r.resolve("../concepts/architecture/", "devportal:default/module/policy-manager/overview/")).toEqual({
      id: "devportal:default/module/policy-manager/concepts/architecture/",
    });
    // As the markdown source writes it: relative to the source file, one level up.
    expect(r.resolve("../concepts/architecture.md", "devportal:default/module/policy-manager/overview/tenancy/")).toEqual({
      id: "devportal:default/module/policy-manager/concepts/architecture/",
    });
  });

  it("calls anything outside the three systems external", () => {
    expect(r.resolve("https://github.com/foo/bar", "gitlab:oneplatform/adrs:README.md")).toEqual({ reason: "external" });
    expect(r.resolve("#anchor", "gitlab:oneplatform/adrs:README.md")).toEqual({ reason: "unparsable" });
  });
});

// ---- building --------------------------------------------------------------------------------------

const doc = (fm: Record<string, string>, body = ""): string => {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
};

interface Fixture {
  graph: KbGraphFile;
  loaded: KbGraph;
}

async function fixture(): Promise<Fixture> {
  const kbDir = await mkdtemp(path.join(tmpdir(), "graph-kb-"));
  const write = async (rel: string, content: string): Promise<void> => {
    await mkdir(path.join(kbDir, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(kbDir, rel), content, "utf8");
  };

  await write(
    "gitlab/oneplatform/adrs/__project.md",
    doc(
      {
        source_id: "gitlab:oneplatform/adrs:__project",
        source_type: "gitlab",
        kind: "project",
        title: "oneplatform/adrs",
        project: "oneplatform/adrs",
        project_name: "adrs",
        techdocs_ref: `${PORTAL}/docs/default/component/adrs/`,
        confluence_pages: `\n  - ${WIKI}/wiki/spaces/CTO/pages/100/Architecture\n  - ${WIKI}/wiki/spaces/CTO/pages/777/Not+Indexed`,
      },
      "The ADR repository.",
    ),
  );
  await write(
    "gitlab/oneplatform/adrs/Platform/ADR0007.md",
    doc(
      { source_id: "gitlab:oneplatform/adrs:Platform/ADR0007.md", source_type: "gitlab", kind: "doc", title: "ADR0007 M2M tokens", project: "oneplatform/adrs", authority: "binding" },
      `Superseded by [ADR0010](./ADR0010.md). See the [portal page](${PORTAL}/docs/default/component/adrs/) and\n` +
        `a [missing page](${PORTAL}/docs/default/component/adrs/gone/), plus ![a diagram](./d.png) and <https://example.com/x>.\n` +
        `Repeated: [ADR0010 again](./ADR0010.md).`,
    ),
  );
  await write(
    "gitlab/oneplatform/adrs/Platform/ADR0010.md",
    doc({ source_id: "gitlab:oneplatform/adrs:Platform/ADR0010.md", source_type: "gitlab", kind: "doc", title: "ADR0010 Client credentials", project: "oneplatform/adrs", authority: "binding" }),
  );
  // No links of its own: it is only ever reachable as "the rest of the repository".
  await write(
    "gitlab/oneplatform/adrs/Platform/ADR0011.md",
    doc({ source_id: "gitlab:oneplatform/adrs:Platform/ADR0011.md", source_type: "gitlab", kind: "doc", title: "ADR0011 Log types", project: "oneplatform/adrs" }),
  );
  await write(
    "confluence/CTO/100-architecture.md",
    doc({ source_id: "confluence:CTO:100", source_type: "confluence", kind: "doc", title: "Architecture", space: "CTO", space_name: "Group Technology", page_id: "100" }),
  );
  await write(
    "confluence/CTO/101-providers.md",
    doc(
      {
        source_id: "confluence:CTO:101",
        source_type: "confluence",
        kind: "doc",
        title: "Providers",
        space: "CTO",
        space_name: "Group Technology",
        page_id: "101",
        parent_id: "100",
        ancestors: "\n  - Architecture\n  - Providers",
      },
      `The decision lives in [ADR0007](${GITLAB}/oneplatform/adrs/-/blob/main/Platform/ADR0007.md).`,
    ),
  );
  await write(
    "confluence/CTO/102-orphan.md",
    doc({ source_id: "confluence:CTO:102", source_type: "confluence", kind: "doc", title: "Orphan", space: "CTO", space_name: "Group Technology", page_id: "102", parent_id: "654" }),
  );
  await write(
    "devportal/component/adrs/index.md",
    doc({
      source_id: "devportal:default/component/adrs/",
      source_type: "devportal",
      kind: "doc",
      title: "ADR site",
      entity: "default/component/adrs",
      entity_title: "ADRs",
      owner: "group:default/Platform",
      tags: "\n  - iso\n  - quarkus",
    }),
  );

  const docs = [
    { sourceId: "gitlab:oneplatform/adrs:__project", relPath: "gitlab/oneplatform/adrs/__project.md" },
    { sourceId: "gitlab:oneplatform/adrs:Platform/ADR0007.md", relPath: "gitlab/oneplatform/adrs/Platform/ADR0007.md" },
    { sourceId: "gitlab:oneplatform/adrs:Platform/ADR0010.md", relPath: "gitlab/oneplatform/adrs/Platform/ADR0010.md" },
    { sourceId: "gitlab:oneplatform/adrs:Platform/ADR0011.md", relPath: "gitlab/oneplatform/adrs/Platform/ADR0011.md" },
    { sourceId: "confluence:CTO:100", relPath: "confluence/CTO/100-architecture.md" },
    { sourceId: "confluence:CTO:101", relPath: "confluence/CTO/101-providers.md" },
    { sourceId: "confluence:CTO:102", relPath: "confluence/CTO/102-orphan.md" },
    { sourceId: "devportal:default/component/adrs/", relPath: "devportal/component/adrs/index.md" },
  ];
  const graph = await buildGraph({ kbDir, docs, places: null });
  return { graph, loaded: new KbGraph(graph) };
}

describe("buildGraph", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  });

  const edgesOf = (g: KbGraphFile): { from: string; to: string; rel: string }[] =>
    g.edges.from.map((from, i) => ({
      from: (g.nodes[from] as { id: string }).id,
      to: (g.nodes[g.edges.to[i] as number] as { id: string }).id,
      rel: g.relations[g.edges.rel[i] as number] as string,
    }));

  it("titles every document node from its frontmatter", () => {
    expect(f.loaded.node("gitlab:oneplatform/adrs:Platform/ADR0007.md")?.label).toBe("ADR0007 M2M tokens");
    expect(f.loaded.node("gitlab:oneplatform/adrs:Platform/ADR0007.md")?.type).toBe("doc");
  });

  it("turns a markdown link into one links_to edge, however many times it is written", () => {
    const links = edgesOf(f.graph).filter((e) => e.rel === "links_to" && e.from === "gitlab:oneplatform/adrs:Platform/ADR0007.md");
    expect(links).toEqual([
      { from: "gitlab:oneplatform/adrs:Platform/ADR0007.md", to: "gitlab:oneplatform/adrs:Platform/ADR0010.md", rel: "links_to" },
      { from: "gitlab:oneplatform/adrs:Platform/ADR0007.md", to: "devportal:default/component/adrs/", rel: "links_to" },
    ]);
  });

  it("reads the structure out of the frontmatter", () => {
    const edges = edgesOf(f.graph);
    expect(edges).toContainEqual({ from: "confluence:CTO:101", to: "confluence:CTO:100", rel: "child_of" });
    expect(edges).toContainEqual({ from: "confluence:CTO:101", to: "space:CTO", rel: "in_space" });
    expect(edges).toContainEqual({ from: "gitlab:oneplatform/adrs:Platform/ADR0007.md", to: "gitlab:oneplatform/adrs:__project", rel: "described_by" });
    expect(edges).toContainEqual({ from: "gitlab:oneplatform/adrs:__project", to: "devportal:default/component/adrs/", rel: "documents" });
    expect(edges).toContainEqual({ from: "gitlab:oneplatform/adrs:__project", to: "confluence:CTO:100", rel: "related_wiki" });
    expect(edges).toContainEqual({ from: "devportal:default/component/adrs/", to: "team:platform", rel: "owned_by" });
    expect(edges).toContainEqual({ from: "devportal:default/component/adrs/", to: "entity:default/component/adrs", rel: "about_entity" });
    expect(edges).toContainEqual({ from: "devportal:default/component/adrs/", to: "tag:quarkus", rel: "tagged" });
  });

  it("puts a page under every prefix of its ancestor chain, so a subtree is one hub", () => {
    const under = edgesOf(f.graph).filter((e) => e.rel === "under").map((e) => e.to);
    expect(under).toEqual(["tree:CTO/Architecture", "tree:CTO/Architecture/Providers"]);
  });

  it("never points an edge at a document that is not indexed", () => {
    const ids = new Set(f.graph.nodes.map((n) => n.id));
    for (const e of edgesOf(f.graph)) expect(ids.has(e.to)).toBe(true);
    expect(ids.has("confluence:CTO:777")).toBe(false);
  });

  it("reports a dangling link written in the documentation, and only from the body", () => {
    expect(f.graph.brokenLinks).toEqual([
      { from: "gitlab:oneplatform/adrs:Platform/ADR0007.md", href: `${PORTAL}/docs/default/component/adrs/gone/`, reason: "devportal-page" },
    ]);
    expect(f.graph.stats.brokenLinksTotal).toBe(1);
    // A parent page and a card's wiki page that sync did not index are scope, not broken links.
    expect(f.graph.stats.scopeGaps).toEqual({ "confluence-page": 2 });
  });

  it("counts an external link as external rather than dropping it silently", () => {
    expect(f.graph.stats.unresolved["external"]).toBe(1);
  });

  it("measures connectivity over document edges only", () => {
    // Seven of the eight documents are joined; the orphan Confluence page stands alone.
    expect(f.graph.stats.connectedDocs).toBe(7);
    expect(f.graph.stats.largestComponent).toBe(7);
    expect(f.graph.docs).toBe(8);
  });
});

// ---- querying --------------------------------------------------------------------------------------

describe("KbGraph", () => {
  let f: Fixture;
  beforeAll(async () => {
    f = await fixture();
  });

  it("ranks a real link above a document that merely sits in the same repository", () => {
    const rows = f.loaded.neighbors("gitlab:oneplatform/adrs:Platform/ADR0007.md");
    expect(rows[0]?.sourceId).toBe("gitlab:oneplatform/adrs:__project");
    expect(rows.map((r) => r.sourceId)).toContain("gitlab:oneplatform/adrs:Platform/ADR0010.md");
    // ADR0011 is in the same repository and links to nothing, so it can only arrive as a sibling —
    // and it must rank below every document that is actually connected to this one.
    const sibling = rows.find((r) => r.direction === "sibling");
    expect(sibling?.sourceId).toBe("gitlab:oneplatform/adrs:Platform/ADR0011.md");
    expect(sibling?.via?.id).toBe("repo:oneplatform/adrs");
    expect(rows.at(-1)?.sourceId).toBe(sibling?.sourceId);
    expect((rows[0]?.weight ?? 0) > (sibling?.weight ?? 1)).toBe(true);
    expect(relationPhrase(rows.find((r) => r.relation === "links_to") as never)).toBe("links to");
  });

  it("sees the link from the other end too", () => {
    const rows = f.loaded.neighbors("gitlab:oneplatform/adrs:Platform/ADR0010.md");
    const back = rows.find((r) => r.sourceId === "gitlab:oneplatform/adrs:Platform/ADR0007.md");
    expect(back?.direction).toBe("in");
    expect(back?.relation).toBe("links_to");
  });

  it("narrows to one kind of relation on request", () => {
    const rows = f.loaded.neighbors("gitlab:oneplatform/adrs:Platform/ADR0007.md", { relations: ["links_to"] });
    // Both directions: the two pages it links to, and the Confluence page that links to it.
    expect(rows.map((r) => r.sourceId).sort()).toEqual([
      "confluence:CTO:101",
      "devportal:default/component/adrs/",
      "gitlab:oneplatform/adrs:Platform/ADR0010.md",
    ]);
  });

  it("drops siblings from a hub bigger than the cap, and can be asked for none at all", () => {
    expect(f.loaded.neighbors("gitlab:oneplatform/adrs:Platform/ADR0007.md", { maxHubSize: 1 }).some((r) => r.direction === "sibling")).toBe(false);
    expect(f.loaded.neighbors("gitlab:oneplatform/adrs:Platform/ADR0007.md", { siblings: false }).some((r) => r.direction === "sibling")).toBe(false);
  });

  it("lists the hubs a document hangs off, smallest (most telling) first", () => {
    const hubs = f.loaded.hubsOf("devportal:default/component/adrs/");
    expect(hubs.map((h) => h.id)).toContain("team:platform");
    expect(hubs.every((h, i) => i === 0 || (hubs[i - 1] as { size: number }).size <= h.size)).toBe(true);
    expect(f.loaded.hubSize("repo:oneplatform/adrs")).toBe(4);
    expect(f.loaded.membersOf("repo:oneplatform/adrs").map((m) => m.sourceId)).toContain("gitlab:oneplatform/adrs:__project");
  });

  it("returns nothing for an id it does not know, rather than guessing", () => {
    expect(f.loaded.neighbors("gitlab:nope:x.md")).toEqual([]);
    expect(f.loaded.has("space:CTO")).toBe(false);
    expect(f.loaded.has("confluence:CTO:100")).toBe(true);
  });

  it("keeps hub edges out of the map payload", () => {
    const payload = f.loaded.docEdgesPayload();
    const ids = payload.nodes.map((n) => n.id);
    expect(ids.some((id) => id.startsWith("repo:") || id.startsWith("space:"))).toBe(false);
    const docEdges = f.graph.edges.rel.filter((r) => (f.graph.relations[r] as string) !== "under" && !(f.graph.relations[r] as string).startsWith("in_") && (f.graph.relations[r] as string) !== "owned_by" && (f.graph.relations[r] as string) !== "about_entity" && (f.graph.relations[r] as string) !== "tagged");
    expect(payload.edges.length).toBe(docEdges.length);
    for (const [a, b] of payload.edges) {
      expect(ids[a as number]).toBeTruthy();
      expect(ids[b as number]).toBeTruthy();
    }
  });

  it("survives a round trip through the gzipped file", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "graph-out-")), "graph.json.gz");
    const bytes = await KbGraph.save(f.graph, file);
    expect(bytes).toBeGreaterThan(0);
    const back = await KbGraph.load(file);
    expect(back?.nodeCount).toBe(f.loaded.nodeCount);
    expect(back?.edgeCount).toBe(f.loaded.edgeCount);
    expect(back?.neighbors("gitlab:oneplatform/adrs:Platform/ADR0007.md").length).toBe(f.loaded.neighbors("gitlab:oneplatform/adrs:Platform/ADR0007.md").length);
  });

  it("reports a missing file as no graph, not as an error", async () => {
    expect(await KbGraph.load(path.join(tmpdir(), "definitely-not-here", "graph.json.gz"))).toBeNull();
  });
});
