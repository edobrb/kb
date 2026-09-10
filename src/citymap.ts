/**
 * The City Map: TeamSystem's own map of what the company builds, maintained in the Dev Portal catalog as
 * `area → sub-area → module → component`. An `area` entity lists its child areas, a `module` names its
 * `area` and `subarea`, a `component` names its `module`. It is the taxonomy the knowledge-base map colours
 * documents by, so the legend reads "Core Services - Foundation › Workspace" rather than a k-means guess.
 *
 * Nothing here is hand-written except `taxonomy.yaml`, which places the sources the catalog does not describe
 * (Confluence spaces, GitLab groups without a catalog-info) onto City Map nodes. Precedence when placing a
 * document: what the catalog says about the document's own entity or repository, then the best of "the
 * owning team's modules all sit in one place" and the hand-written rules, then nothing.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { parseFrontmatter } from "./ingest/loader.js";
import { wildcardToRegExp } from "./sync/sources-config.js";

export interface CityMapNode {
  title: string;
  /** The area this one is listed under (sub-areas only). */
  parent?: string;
}

export interface CityMapModule {
  title: string;
  area?: string;
  subarea?: string;
  owner?: string;
  legacy?: boolean;
}

export interface CityMap {
  fetchedAt: string;
  /** Every `kind: area` entity, top-level areas and sub-areas alike. */
  areas: Record<string, CityMapNode>;
  modules: Record<string, CityMapModule>;
  /** component / api name → module name (from `spec.module` and the modules' `hasPart` relations). */
  parts: Record<string, string>;
  /** GitLab repository path (lowercase) → module name, from the entities' source-location annotations. */
  repos: Record<string, string>;
}

/** The slice of a Backstage entity the City Map is built from (kinds area / module / component). */
export interface CityMapEntity {
  kind: string;
  metadata: { name: string; namespace?: string; title?: string; annotations?: Record<string, string> };
  spec?: Record<string, unknown>;
  relations?: { type: string; targetRef: string }[];
}

/** Catalog fields worth downloading for the City Map (the `fields=` filter of the catalog API). */
export const CITYMAP_ENTITY_FIELDS = ["kind", "metadata.name", "metadata.namespace", "metadata.title", "metadata.annotations", "spec.area", "spec.subarea", "spec.owner", "spec.module", "spec.legacy", "spec.children", "relations"];

/** Where a document sits on the City Map; every level optional, finer levels imply the coarser ones. */
export interface Place {
  module?: string;
  subarea?: string;
  area?: string;
}

export type PlacedVia = "frontmatter" | "catalog" | "repo" | "owner" | "rule" | "none";
export interface Placement extends Place {
  via: PlacedVia;
}

export interface PlaceLabels {
  area: string;
  subarea: string;
  module: string;
}

export const NOT_IN_CITY_MAP = "Not in City Map";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** "core-services-foundation" → "Core Services Foundation", for nodes the catalog gives no title for. */
export function humanize(name: string): string {
  return name
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** "group:default/iam" → "iam": owners are written with or without the entity-ref prefix depending on the source. */
export function ownerName(v: unknown): string | undefined {
  const s = str(v);
  return s ? s.replace(/^(group|user):/i, "").replace(/^default\//, "").toLowerCase() : undefined;
}

// ---- building the map from the catalog -------------------------------------------------------------

/**
 * Assemble the City Map from the three catalog listings. `repoOf` extracts the GitLab repository an
 * entity's annotations point at (the connector knows the GitLab host; this module does not).
 */
export function buildCityMap(entities: { areas: CityMapEntity[]; modules: CityMapEntity[]; components: CityMapEntity[] }, repoOf: (e: CityMapEntity) => string | null, now = new Date()): CityMap {
  const cm: CityMap = { fetchedAt: now.toISOString(), areas: {}, modules: {}, parts: {}, repos: {} };
  for (const e of entities.areas) cm.areas[e.metadata.name] = { title: str(e.metadata.title) ?? humanize(e.metadata.name) };
  for (const e of entities.areas) {
    const children = e.spec?.["children"];
    if (!Array.isArray(children)) continue;
    for (const c of children) {
      const child = typeof c === "string" ? cm.areas[c] : undefined;
      // "ts-in-cloud" is listed under several areas; the first parent wins. Documents are placed by their
      // module's own `area`, so the choice only affects the label of a sub-area used without a module.
      if (child && !child.parent) child.parent = e.metadata.name;
    }
  }
  for (const e of entities.modules) {
    const name = e.metadata.name;
    const spec = e.spec ?? {};
    const mod: CityMapModule = { title: str(e.metadata.title) ?? humanize(name) };
    const area = str(spec["area"]);
    const subarea = str(spec["subarea"]);
    const owner = ownerName(spec["owner"]);
    if (area) mod.area = area;
    if (subarea) mod.subarea = subarea;
    if (owner) mod.owner = owner;
    if (spec["legacy"] === true) mod.legacy = true;
    cm.modules[name] = mod;
    for (const r of e.relations ?? []) {
      const m = r.type === "hasPart" ? /^(?:component|api|resource):(?:[^/]+\/)?(.+)$/.exec(r.targetRef) : null;
      if (m) cm.parts[m[1] as string] ??= name;
    }
    const repo = repoOf(e);
    if (repo) cm.repos[repo.toLowerCase()] ??= name;
  }
  for (const e of entities.components) {
    const module = str(e.spec?.["module"]);
    if (!module) continue;
    cm.parts[e.metadata.name] ??= module;
    const repo = repoOf(e);
    if (repo) cm.repos[repo.toLowerCase()] ??= module;
  }
  return cm;
}

// ---- taxonomy.yaml: hand-written placements for what the catalog does not cover ------------------------

export interface TaxonomyRule {
  match: { source?: string[]; path?: RegExp[]; space?: string[]; ancestor?: RegExp[]; owner?: string[] };
  place: Place;
  /** The rule as written, for error messages and `--explain` style output. */
  text: string;
}

export interface Taxonomy {
  /** Extra nodes that exist only here (e.g. "architecture" under "platform"), with the area they hang from. */
  nodes: Record<string, CityMapNode>;
  /** First matching rule wins, so specific rules go first. */
  rules: TaxonomyRule[];
}

export const EMPTY_TAXONOMY: Taxonomy = { nodes: {}, rules: [] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).filter((x): x is string | number => typeof x === "string" || typeof x === "number").map(String);

export function parseTaxonomy(yamlText: string): Taxonomy {
  const parsed = YAML.parse(yamlText) ?? {};
  if (!isObj(parsed)) throw new Error("taxonomy.yaml must be a mapping");
  for (const k of Object.keys(parsed)) if (k !== "nodes" && k !== "rules") throw new Error(`taxonomy.yaml: unknown key "${k}" (expected nodes, rules)`);
  const tax: Taxonomy = { nodes: {}, rules: [] };
  const nodes = parsed["nodes"] ?? {};
  if (!isObj(nodes)) throw new Error("taxonomy.yaml: nodes must be a mapping of name → { title, parent }");
  for (const [name, v] of Object.entries(nodes)) {
    if (!isObj(v) || !str(v["title"])) throw new Error(`taxonomy.yaml: node "${name}" needs a title`);
    tax.nodes[name] = { title: str(v["title"]) as string, ...(str(v["parent"]) ? { parent: str(v["parent"]) as string } : {}) };
  }
  const rules = parsed["rules"] ?? [];
  if (!Array.isArray(rules)) throw new Error("taxonomy.yaml: rules must be a list");
  rules.forEach((r, i) => {
    const text = JSON.stringify(r);
    if (!isObj(r) || !isObj(r["match"])) throw new Error(`taxonomy.yaml: rule ${i + 1} needs a "match" mapping: ${text}`);
    const m = r["match"];
    for (const k of Object.keys(m)) if (!["source", "path", "space", "ancestor", "owner"].includes(k)) throw new Error(`taxonomy.yaml: rule ${i + 1}: unknown match key "${k}" (expected source, path, space, ancestor, owner)`);
    if (!Object.keys(m).length) throw new Error(`taxonomy.yaml: rule ${i + 1}: empty match: ${text}`);
    const place: Place = {};
    for (const k of ["module", "subarea", "area"] as const) if (str(r[k])) place[k] = str(r[k]) as string;
    for (const k of Object.keys(r)) if (!["match", "module", "subarea", "area"].includes(k)) throw new Error(`taxonomy.yaml: rule ${i + 1}: unknown key "${k}" (expected match, module, subarea, area)`);
    if (!Object.keys(place).length) throw new Error(`taxonomy.yaml: rule ${i + 1} must set module, subarea or area: ${text}`);
    const match: TaxonomyRule["match"] = {};
    if (m["source"] !== undefined) match.source = list(m["source"]).map((s) => s.toLowerCase());
    if (m["path"] !== undefined) match.path = list(m["path"]).map(wildcardToRegExp);
    if (m["space"] !== undefined) match.space = list(m["space"]).map((s) => s.toLowerCase());
    if (m["ancestor"] !== undefined) match.ancestor = list(m["ancestor"]).map(wildcardToRegExp);
    if (m["owner"] !== undefined) match.owner = list(m["owner"]).map((s) => ownerName(s) as string);
    tax.rules.push({ match, place, text });
  });
  return tax;
}

/** Missing file → no extra nodes and no rules (the catalog alone still places most documents). */
export async function loadTaxonomy(file: string): Promise<Taxonomy> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return structuredClone(EMPTY_TAXONOMY);
  }
  return parseTaxonomy(text);
}

// ---- placing documents ----------------------------------------------------------------------------------

/** What `placeDocument` needs to know about a kb document. */
export interface KbDocRef {
  sourceType: string;
  /** Path relative to kb/, e.g. "confluence/TeamCore/123-ts-id.md". */
  relPath: string;
  frontmatter: Record<string, unknown>;
}

/** Fill the coarser levels a finer one implies (module → sub-area → area). */
export function completePlace(p: Place, cm: CityMap | null, tax: Taxonomy = EMPTY_TAXONOMY): Place {
  const out: Place = { ...p };
  const mod = out.module ? cm?.modules[out.module] : undefined;
  if (mod) {
    if (!out.subarea && mod.subarea) out.subarea = mod.subarea;
    if (!out.area && mod.area) out.area = mod.area;
  }
  if (out.subarea && !out.area) {
    const parent = tax.nodes[out.subarea]?.parent ?? cm?.areas[out.subarea]?.parent;
    if (parent) out.area = parent;
  }
  return out;
}

/** Where a catalog entity sits: a module is itself, a component / api is a part of one. */
export function placeEntity(cm: CityMap | null, kind: string, name: string): Place {
  if (!cm) return {};
  const k = kind.toLowerCase();
  if (k === "module" && cm.modules[name]) return completePlace({ module: name }, cm);
  const module = cm.parts[name];
  return module ? completePlace({ module }, cm) : {};
}

const specificity = (p: Place | null): number => (p?.module ? 3 : p?.subarea ? 2 : p?.area ? 1 : 0);

/** The team's modules all sit in one place → that place. One module → the module itself. */
function ownerPlace(owner: string, cm: CityMap): Place | null {
  const owned = Object.entries(cm.modules).filter(([, m]) => m.owner === owner);
  if (!owned.length) return null;
  if (owned.length === 1) return { module: (owned[0] as [string, CityMapModule])[0] };
  const shared = (k: "subarea" | "area"): string | undefined => {
    const vals = new Set(owned.map(([, m]) => m[k]));
    return vals.size === 1 ? [...vals][0] : undefined;
  };
  const subarea = shared("subarea");
  if (subarea) return { subarea };
  const area = shared("area");
  return area ? { area } : null;
}

function ruleMatches(rule: TaxonomyRule, doc: KbDocRef): boolean {
  const m = rule.match;
  const fm = doc.frontmatter;
  if (m.source && !m.source.includes(doc.sourceType.toLowerCase())) return false;
  if (m.path && !m.path.some((re) => re.test(doc.relPath))) return false;
  if (m.space) {
    const space = str(fm["space"])?.toLowerCase();
    if (!space || !m.space.includes(space)) return false;
  }
  if (m.ancestor) {
    const ancestors = Array.isArray(fm["ancestors"]) ? fm["ancestors"].filter((a): a is string => typeof a === "string") : [];
    if (!ancestors.some((a) => (m.ancestor as RegExp[]).some((re) => re.test(a)))) return false;
  }
  if (m.owner) {
    const owner = ownerName(fm["owner"]);
    if (!owner || !m.owner.includes(owner)) return false;
  }
  return true;
}

export function placeDocument(doc: KbDocRef, cm: CityMap | null, tax: Taxonomy = EMPTY_TAXONOMY): Placement {
  const fm = doc.frontmatter;

  // Inference, used on its own when the catalog says nothing and to fill the coarser levels when it names a
  // module the City Map does not list ("vapor", "account-pr"): the owning team's footprint on the map, or a
  // hand-written rule — whichever is finer; ties go to the rule.
  let inferred: Placement | null | undefined;
  const infer = (): Placement | null => {
    if (inferred !== undefined) return inferred;
    const owner = ownerName(fm["owner"]);
    const byOwner = owner && cm ? ownerPlace(owner, cm) : null;
    const rule = tax.rules.find((r) => ruleMatches(r, doc));
    const byRule = rule ? rule.place : null;
    inferred = byRule && specificity(byRule) >= specificity(byOwner) ? { ...completePlace(byRule, cm, tax), via: "rule" } : byOwner ? { ...completePlace(byOwner, cm, tax), via: "owner" } : null;
    return inferred;
  };
  const settle = (p: Place, via: PlacedVia): Placement => {
    const full = completePlace(p, cm, tax);
    if (!full.subarea || !full.area) {
      const coarse = infer();
      if (coarse) {
        if (!full.subarea && coarse.subarea) full.subarea = coarse.subarea;
        if (!full.area && coarse.area) full.area = coarse.area;
      }
    }
    return { ...full, via };
  };

  // 1. Stamped by sync from the catalog (module, or the coarser levels when the entity has no module).
  const stamped: Place = {};
  for (const k of ["module", "subarea", "area"] as const) if (str(fm[k])) stamped[k] = str(fm[k]) as string;
  if (specificity(stamped)) return settle(stamped, "frontmatter");

  // 2. The document's own catalog entity, or the repository it comes from.
  const entityName = str(fm["entity_name"]);
  const entityKind = str(fm["entity_kind"]);
  if (entityName && entityKind) {
    const p = placeEntity(cm, entityKind, entityName);
    if (specificity(p)) return settle(p, "catalog");
  }
  const project = str(fm["project"])?.toLowerCase();
  const repoModule = project ? cm?.repos[project] : undefined;
  if (repoModule) return settle({ module: repoModule }, "repo");

  // 3. Nothing about the document itself: inference alone.
  return infer() ?? { via: "none" };
}

function nodeTitle(name: string, cm: CityMap | null, tax: Taxonomy): string {
  return tax.nodes[name]?.title ?? cm?.areas[name]?.title ?? humanize(name);
}

/**
 * Display names for the three legend levels. A document placed only at a coarser level is labelled
 * "<coarser title> · other" at the finer ones, so it stays distinguishable from documents not on the map at all.
 */
export function placeLabels(p: Place, cm: CityMap | null, tax: Taxonomy = EMPTY_TAXONOMY): PlaceLabels {
  const area = p.area ? nodeTitle(p.area, cm, tax) : undefined;
  const subarea = p.subarea ? nodeTitle(p.subarea, cm, tax) : undefined;
  const module = p.module ? (cm?.modules[p.module]?.title ?? humanize(p.module)) : undefined;
  return {
    area: area ?? NOT_IN_CITY_MAP,
    subarea: subarea ?? (area ? `${area} · other` : NOT_IN_CITY_MAP),
    module: module ?? (subarea ? `${subarea} · other` : area ? `${area} · other` : NOT_IN_CITY_MAP),
  };
}

/** "Platform › Core Services - Foundation › Workspace" — the breadcrumb form used in project cards and logs. */
export function cityMapPath(p: Place, cm: CityMap | null, tax: Taxonomy = EMPTY_TAXONOMY): string | undefined {
  const full = completePlace(p, cm, tax);
  const parts = [full.area ? nodeTitle(full.area, cm, tax) : "", full.subarea ? nodeTitle(full.subarea, cm, tax) : "", full.module ? (cm?.modules[full.module]?.title ?? humanize(full.module)) : ""].filter(Boolean);
  return parts.length ? parts.join(" › ") : undefined;
}

// ---- placing the whole kb/ folder (used by `npm run map`) -------------------------------------------------

export interface KbPlacement extends Placement {
  labels: PlaceLabels;
}

/**
 * Place kb documents by their kb-relative paths, reading only their frontmatter. Files that cannot be read
 * (deleted since the last ingest) are placed as "none".
 */
export async function placeKbDocuments(kbDir: string, relPaths: Iterable<string>, cm: CityMap | null, tax: Taxonomy = EMPTY_TAXONOMY, concurrency = 32): Promise<Map<string, KbPlacement>> {
  const out = new Map<string, KbPlacement>();
  const queue = [...new Set(relPaths)];
  const worker = async (): Promise<void> => {
    for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) {
      let frontmatter: Record<string, unknown> = {};
      try {
        frontmatter = parseFrontmatter(await readFile(path.join(kbDir, rel), "utf8")).frontmatter;
      } catch {
        // Missing file: fall through to path-based rules only.
      }
      const sourceType = str(frontmatter["source_type"]) ?? rel.split("/")[0] ?? "";
      const placement = placeDocument({ sourceType, relPath: rel, frontmatter }, cm, tax);
      out.set(rel, { ...placement, labels: placeLabels(placement, cm, tax) });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  return out;
}
