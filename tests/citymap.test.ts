import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCityMap,
  cityMapPath,
  completePlace,
  humanize,
  NOT_IN_CITY_MAP,
  ownerName,
  parseTaxonomy,
  placeDocument,
  placeEntity,
  placeKbDocuments,
  placeLabels,
  type CityMapEntity,
} from "../src/citymap.js";

const area = (name: string, title: string, children: string[] = []): CityMapEntity => ({ kind: "Area", metadata: { name, title }, spec: { children } });
const module = (name: string, title: string, spec: Record<string, unknown>, parts: string[] = [], repo?: string): CityMapEntity => ({
  kind: "Module",
  metadata: { name, title, annotations: repo ? { "backstage.io/source-location": `url:https://biosphere.teamsystem.com/${repo}/-/blob/main/catalog-info.yaml` } : {} },
  spec,
  relations: parts.map((p) => ({ type: "hasPart", targetRef: p })),
});
const component = (name: string, mod: string | undefined, repo?: string): CityMapEntity => ({
  kind: "Component",
  metadata: { name, annotations: repo ? { "backstage.io/source-location": `url:https://biosphere.teamsystem.com/${repo}/-/tree/main/` } : {} },
  spec: mod ? { type: "service", module: mod, owner: "group:default/x" } : { type: "service" },
});
const repoOf = (e: CityMapEntity): string | null => {
  const loc = e.metadata.annotations?.["backstage.io/source-location"];
  const m = loc ? /biosphere\.teamsystem\.com\/(.+?)\/-\//.exec(loc) : null;
  return m ? (m[1] as string) : null;
};

/** A small City Map in the shape the Dev Portal catalog has: platform › core-services-foundation › iam/workspace, plus a legacy product. */
const CM = buildCityMap(
  {
    areas: [
      area("platform", "Platform", ["core-services-foundation", "integration", "core-services-experience-ice", "ts-in-cloud"]),
      area("core-services-foundation", "Core Services - Foundation"),
      area("integration", "Integration"),
      area("core-services-experience-ice", "Core Services - Experience - ICE"),
      area("micro-vertical", "Micro Vertical", ["ts-in-cloud"]),
      area("ts-in-cloud", "TS in Cloud"),
    ],
    modules: [
      module("iam", "IAM (TS ID)", { area: "platform", subarea: "core-services-foundation", owner: "iam" }, ["component:default/identity-read", "api:default/user-read"], "tsdigital/oneplatform/iam/identity"),
      module("policy-manager", "IAM (Policy Manager)", { area: "platform", subarea: "core-services-foundation", owner: "iam" }),
      module("workspace", "Workspace", { area: "platform", subarea: "core-services-foundation", owner: "group:default/registry" }),
      module("integration-hub", "Integration HUB", { area: "platform", subarea: "integration", owner: "ipaas-integration" }),
      module("hermes", "Data Streaming (Hermes)", { area: "platform", subarea: "integration", owner: "ipaas-integration" }),
      module("cassa-in-cloud", "Cassa in Cloud", { area: "micro-vertical", subarea: "ts-in-cloud", owner: "cassa-in-cloud", legacy: false }),
      module("nameless", "", { area: "platform" }),
    ],
    // "vapor" is a module name no module entity carries — a phantom module, as the real catalog has a few of.
    components: [component("tsih-scheduler", "integration-hub", "paas/platform/TSIH/docs/tsih-scheduler"), component("workspace-service", "workspace"), component("orphan", undefined, "oneplatform/orphan"), component("vapor-core", "vapor", "vapor/react/core")],
  },
  repoOf,
  new Date("2026-09-10T00:00:00Z"),
);

describe("buildCityMap", () => {
  it("links areas to parents, modules to parts and repositories, and reads module metadata", () => {
    expect(CM.fetchedAt).toBe("2026-09-10T00:00:00.000Z");
    expect(CM.areas["core-services-foundation"]).toEqual({ title: "Core Services - Foundation", parent: "platform" });
    // Listed under two areas: the first parent wins, deterministically.
    expect(CM.areas["ts-in-cloud"]?.parent).toBe("platform");
    expect(CM.modules["iam"]).toEqual({ title: "IAM (TS ID)", area: "platform", subarea: "core-services-foundation", owner: "iam" });
    expect(CM.modules["workspace"]?.owner).toBe("registry"); // "group:default/registry" normalised
    expect(CM.modules["nameless"]?.title).toBe("Nameless"); // no catalog title → humanised name
    expect(CM.parts).toEqual({ "identity-read": "iam", "user-read": "iam", "tsih-scheduler": "integration-hub", "workspace-service": "workspace", "vapor-core": "vapor" });
    expect(CM.repos).toEqual({ "tsdigital/oneplatform/iam/identity": "iam", "paas/platform/tsih/docs/tsih-scheduler": "integration-hub", "vapor/react/core": "vapor" });
  });

  it("helpers: humanize, ownerName, completePlace, placeEntity, cityMapPath", () => {
    expect(humanize("core-services-experience-ice")).toBe("Core Services Experience Ice");
    expect(ownerName("group:default/IAM")).toBe("iam");
    expect(ownerName("  ")).toBeUndefined();
    expect(completePlace({ module: "iam" }, CM)).toEqual({ module: "iam", subarea: "core-services-foundation", area: "platform" });
    expect(completePlace({ subarea: "integration" }, CM)).toEqual({ subarea: "integration", area: "platform" });
    expect(completePlace({ subarea: "unknown" }, CM)).toEqual({ subarea: "unknown" });
    expect(placeEntity(CM, "module", "workspace")).toEqual({ module: "workspace", subarea: "core-services-foundation", area: "platform" });
    expect(placeEntity(CM, "component", "identity-read").module).toBe("iam");
    expect(placeEntity(CM, "api", "user-read").module).toBe("iam");
    expect(placeEntity(CM, "component", "orphan")).toEqual({});
    expect(placeEntity(null, "module", "workspace")).toEqual({});
    expect(cityMapPath({ module: "iam" }, CM)).toBe("Platform › Core Services - Foundation › IAM (TS ID)");
    expect(cityMapPath({}, CM)).toBeUndefined();
  });
});

describe("parseTaxonomy", () => {
  it("accepts nodes and rules, normalises match values and rejects mistakes loudly", () => {
    const tax = parseTaxonomy(`
nodes:
  architecture: { title: Architecture & Governance, parent: platform }
rules:
  - match: { source: confluence, space: TeamCore, ancestor: "POLICY MANAGER*" }
    module: policy-manager
  - match: { path: ["gitlab/oneplatform/adrs/*", "gitlab/oneplatform/architecture/*"], owner: "group:default/CTO" }
    subarea: architecture
`);
    expect(tax.nodes).toEqual({ architecture: { title: "Architecture & Governance", parent: "platform" } });
    expect(tax.rules).toHaveLength(2);
    expect(tax.rules[0]?.match.space).toEqual(["teamcore"]);
    expect(tax.rules[0]?.match.ancestor?.[0]?.test("POLICY MANAGER - Feature")).toBe(true);
    expect(tax.rules[0]?.place).toEqual({ module: "policy-manager" });
    expect(tax.rules[1]?.match.path?.[0]?.test("gitlab/oneplatform/adrs/Platform/ADR0001.md")).toBe(true);
    expect(tax.rules[1]?.match.owner).toEqual(["cto"]);

    expect(parseTaxonomy("")).toEqual({ nodes: {}, rules: [] });
    expect(() => parseTaxonomy("- a")).toThrow(/must be a mapping/);
    expect(() => parseTaxonomy("rulez: []")).toThrow(/unknown key "rulez"/);
    expect(() => parseTaxonomy("nodes:\n  x: {}")).toThrow(/node "x" needs a title/);
    expect(() => parseTaxonomy("rules:\n  - module: iam")).toThrow(/needs a "match"/);
    expect(() => parseTaxonomy("rules:\n  - match: { spaces: X }\n    module: iam")).toThrow(/unknown match key "spaces"/);
    expect(() => parseTaxonomy("rules:\n  - match: { space: X }")).toThrow(/must set module, subarea or area/);
    expect(() => parseTaxonomy("rules:\n  - match: { space: X }\n    modul: iam")).toThrow(/unknown key "modul"/);
  });
});

describe("placeDocument", () => {
  const TAX = parseTaxonomy(`
nodes:
  architecture: { title: Architecture & Governance, parent: platform }
rules:
  - match: { source: confluence, space: TeamCore, ancestor: "POLICY MANAGER*" }
    module: policy-manager
  - match: { source: confluence, space: TeamCore }
    module: iam
  - match: { path: "gitlab/oneplatform/adrs/*" }
    subarea: architecture
  - match: { path: "gitlab/oneplatform/*" }
    area: platform
  - match: { owner: vapor-ui-library }
    subarea: core-services-experience-ice
`);
  const doc = (sourceType: string, relPath: string, frontmatter: Record<string, unknown> = {}) => ({ sourceType, relPath, frontmatter });

  it("trusts what sync stamped from the catalog first", () => {
    expect(placeDocument(doc("devportal", "devportal/component/x/index.md", { module: "iam", entity_kind: "component", entity_name: "tsih-scheduler" }), CM, TAX)).toEqual({ module: "iam", subarea: "core-services-foundation", area: "platform", via: "frontmatter" });
    // Stamped at a coarser level only (the entity had no module): kept as is, area filled from the sub-area's parent.
    expect(placeDocument(doc("devportal", "devportal/module/x/index.md", { subarea: "integration" }), CM, TAX)).toEqual({ subarea: "integration", area: "platform", via: "frontmatter" });
  });

  it("falls back to the document's entity, then its repository", () => {
    expect(placeDocument(doc("devportal", "devportal/component/tsih-scheduler/index.md", { entity_kind: "component", entity_name: "tsih-scheduler" }), CM, TAX)).toMatchObject({ module: "integration-hub", subarea: "integration", via: "catalog" });
    expect(placeDocument(doc("devportal", "devportal/module/workspace/index.md", { entity_kind: "module", entity_name: "workspace" }), CM, TAX)).toMatchObject({ module: "workspace", via: "catalog" });
    expect(placeDocument(doc("gitlab", "gitlab/tsdigital/oneplatform/iam/identity/README.md", { project: "tsdigital/oneplatform/IAM/identity" }), CM, TAX)).toMatchObject({ module: "iam", via: "repo" });
  });

  it("infers from the owning team when its modules share one place, else from the rules — the finer wins, ties go to the rule", () => {
    // Team with several modules in one sub-area: sub-area only.
    expect(placeDocument(doc("devportal", "devportal/component/y/index.md", { owner: "group:default/ipaas-integration" }), CM, TAX)).toEqual({ subarea: "integration", area: "platform", via: "owner" });
    // Team with one module: the module.
    expect(placeDocument(doc("devportal", "devportal/component/z/index.md", { owner: "cassa-in-cloud" }), CM, TAX)).toEqual({ module: "cassa-in-cloud", subarea: "ts-in-cloud", area: "micro-vertical", via: "owner" });
    // First matching rule wins, so the specific ancestor rule beats the space-wide one.
    expect(placeDocument(doc("confluence", "confluence/TeamCore/1.md", { space: "TeamCore", ancestors: ["POLICY MANAGER - Feature", "Analysis"] }), CM, TAX)).toMatchObject({ module: "policy-manager", via: "rule" });
    expect(placeDocument(doc("confluence", "confluence/TeamCore/2.md", { space: "TeamCore", ancestors: ["Guide"] }), CM, TAX)).toMatchObject({ module: "iam", via: "rule" });
    // A node that only exists in taxonomy.yaml gets its area from the node's parent.
    expect(placeDocument(doc("gitlab", "gitlab/oneplatform/adrs/Platform/ADR1.md", { project: "oneplatform/adrs" }), CM, TAX)).toEqual({ subarea: "architecture", area: "platform", via: "rule" });
    // Owner gives a module, the matching rule only an area: the owner wins.
    expect(placeDocument(doc("gitlab", "gitlab/oneplatform/cic/__project.md", { project: "oneplatform/cic", owner: "cassa-in-cloud" }), CM, TAX)).toMatchObject({ module: "cassa-in-cloud", via: "owner" });
    // Same specificity: the hand-written rule wins over the owner inference.
    expect(placeDocument(doc("gitlab", "gitlab/oneplatform/adrs/x.md", { project: "oneplatform/adrs", owner: "ipaas-integration" }), CM, TAX)).toMatchObject({ subarea: "architecture", via: "rule" });
    // Nothing known.
    expect(placeDocument(doc("confluence", "confluence/CTO/1.md", { space: "CTO" }), CM, TAX)).toEqual({ via: "none" });
    // A team-level rule places documents whose owner has no module of its own.
    expect(placeDocument(doc("devportal", "devportal/component/vapor-docs/index.md", { owner: "vapor-ui-library" }), CM, TAX)).toEqual({ subarea: "core-services-experience-ice", area: "platform", via: "rule" });
    expect(placeDocument(doc("confluence", "confluence/TeamCore/1.md", { space: "TeamCore" }), null, { nodes: {}, rules: [] })).toEqual({ via: "none" });
  });

  it("keeps a phantom module's name and takes its sub-area and area from the inference", () => {
    // The catalog names module "vapor" but lists no such module: the entity route still wins, the coarser levels come from the owner rule.
    expect(placeDocument(doc("devportal", "devportal/component/vapor-core/index.md", { entity_kind: "component", entity_name: "vapor-core", owner: "vapor-ui-library" }), CM, TAX)).toEqual({ module: "vapor", subarea: "core-services-experience-ice", area: "platform", via: "catalog" });
    expect(placeDocument(doc("gitlab", "gitlab/vapor/react/core/README.md", { project: "vapor/react/core", owner: "vapor-ui-library" }), CM, TAX)).toEqual({ module: "vapor", subarea: "core-services-experience-ice", area: "platform", via: "repo" });
    expect(placeDocument(doc("devportal", "devportal/component/x/index.md", { module: "vapor", owner: "vapor-ui-library" }), CM, TAX)).toEqual({ module: "vapor", subarea: "core-services-experience-ice", area: "platform", via: "frontmatter" });
    // No inference available: the module stays, the coarser levels stay unknown (and label as "Not in City Map").
    expect(placeDocument(doc("devportal", "devportal/component/vapor-core/index.md", { entity_kind: "component", entity_name: "vapor-core" }), CM, TAX)).toEqual({ module: "vapor", via: "catalog" });
    expect(placeLabels({ module: "vapor" }, CM, TAX)).toEqual({ area: NOT_IN_CITY_MAP, subarea: NOT_IN_CITY_MAP, module: "Vapor" });
  });

  it("labels every level, marking coarser-only placements as '· other' and unplaced documents explicitly", () => {
    expect(placeLabels({ module: "iam", subarea: "core-services-foundation", area: "platform" }, CM, TAX)).toEqual({ area: "Platform", subarea: "Core Services - Foundation", module: "IAM (TS ID)" });
    expect(placeLabels({ subarea: "architecture", area: "platform" }, CM, TAX)).toEqual({ area: "Platform", subarea: "Architecture & Governance", module: "Architecture & Governance · other" });
    expect(placeLabels({ area: "platform" }, CM, TAX)).toEqual({ area: "Platform", subarea: "Platform · other", module: "Platform · other" });
    expect(placeLabels({}, CM, TAX)).toEqual({ area: NOT_IN_CITY_MAP, subarea: NOT_IN_CITY_MAP, module: NOT_IN_CITY_MAP });
    // Without a catalog copy, names are still readable.
    expect(placeLabels({ module: "iam", subarea: "core-services-foundation" }, null)).toEqual({ area: NOT_IN_CITY_MAP, subarea: "Core Services Foundation", module: "Iam" });
  });

  it("places a kb folder by reading only the frontmatter, tolerating missing files", async () => {
    const kb = await mkdtemp(path.join(tmpdir(), "kb-"));
    await mkdir(path.join(kb, "confluence/TeamCore"), { recursive: true });
    await mkdir(path.join(kb, "devportal/module/workspace"), { recursive: true });
    await writeFile(path.join(kb, "confluence/TeamCore/1.md"), "---\nsource_type: confluence\nspace: TeamCore\nancestors:\n  - Guide\n---\n\n# TS ID guide\n");
    await writeFile(path.join(kb, "devportal/module/workspace/index.md"), "---\nsource_type: devportal\nentity_kind: module\nentity_name: workspace\n---\n\n# Workspace\n");
    const placed = await placeKbDocuments(kb, ["confluence/TeamCore/1.md", "devportal/module/workspace/index.md", "gitlab/oneplatform/adrs/gone.md", "confluence/TeamCore/1.md"], CM, TAX, 2);
    expect(placed.size).toBe(3);
    expect(placed.get("confluence/TeamCore/1.md")).toMatchObject({ module: "iam", via: "rule", labels: { module: "IAM (TS ID)" } });
    expect(placed.get("devportal/module/workspace/index.md")).toMatchObject({ module: "workspace", via: "catalog" });
    // The file is gone but its path still matches a rule.
    expect(placed.get("gitlab/oneplatform/adrs/gone.md")).toMatchObject({ subarea: "architecture", via: "rule", labels: { subarea: "Architecture & Governance" } });
  });
});
