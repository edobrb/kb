import { config, paths } from "../config.js";
import { loadTaxonomy, placeKbDocuments, type CityMap, type KbPlacement } from "../citymap.js";
import { loadDocument } from "../ingest/loader.js";
import { readManifest } from "../ingest/manifest.js";
import { readState } from "../sync/state.js";
import { LinkResolver, RESOLUTION_REASONS, isResolved } from "./resolve.js";
import { RELATIONS, type BrokenLink, type GraphNode, type KbGraphFile, type NodeType, type Relation } from "./types.js";

/**
 * Building the graph: one pass over the indexed documents, reading frontmatter and body links.
 *
 * The manifest is the document list, not the kb folder: only what is indexed becomes a node, so
 * every edge points at something `fetch_document` can actually read and every citation the model
 * reaches through the graph is a real one.
 */

export interface BuildGraphOptions {
  kbDir?: string;
  /** The indexed documents (manifest entries). */
  docs: Iterable<{ sourceId: string; relPath: string }>;
  /** City Map position per kb-relative path; omit to leave the area/sub-area/module hubs out. */
  places?: Map<string, KbPlacement> | null;
  /** Cap on the dangling-link report kept in the file. */
  maxBrokenLinks?: number;
  concurrency?: number;
  log?: (msg: string) => void;
}

/** Markdown links, skipping images (`![alt](src)`). */
const LINK_RE = /(!?)\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
/** Bare autolinks: `<https://…>`. */
const AUTOLINK_RE = /<((?:https?):\/\/[^>\s]+)>/g;

const str = (v: unknown): string | undefined => {
  if (typeof v === "string") return v.trim() || undefined;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
};

const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => str(x)).filter((x): x is string => Boolean(x)) : [];

/** "group:default/iam" / "Default/IAM" -> "iam": owners are written differently by each connector. */
const teamKey = (v: string): string => v.replace(/^(group|user):/i, "").replace(/^default\//, "").trim().toLowerCase();

export async function buildGraph(opts: BuildGraphOptions): Promise<KbGraphFile> {
  const started = Date.now();
  const kbDir = opts.kbDir ?? config.kbDir;
  const log = opts.log ?? (() => {});
  const entries = [...opts.docs];
  const resolver = new LinkResolver(entries.map((e) => e.sourceId));

  const nodes: GraphNode[] = [];
  const nodeIndex = new Map<string, number>();
  const node = (id: string, type: NodeType, label: string): number => {
    const existing = nodeIndex.get(id);
    if (existing !== undefined) {
      // A hub first seen through a reference gets its real label when its own document is read.
      const n = nodes[existing] as GraphNode;
      if (type === "doc" && n.type !== "doc") {
        n.type = "doc";
        n.label = label;
      }
      return existing;
    }
    nodes.push({ id, type, label });
    nodeIndex.set(id, nodes.length - 1);
    return nodes.length - 1;
  };

  const relIndex = new Map<Relation, number>(RELATIONS.map((r, i) => [r, i]));
  const from: number[] = [];
  const to: number[] = [];
  const rel: number[] = [];
  const seenEdge = new Set<string>();
  const byRelation: Partial<Record<Relation, number>> = {};
  const edge = (a: number, b: number, r: Relation): void => {
    if (a === b) return;
    const key = `${a}|${b}|${r}`;
    if (seenEdge.has(key)) return;
    seenEdge.add(key);
    from.push(a);
    to.push(b);
    rel.push(relIndex.get(r) as number);
    byRelation[r] = (byRelation[r] ?? 0) + 1;
  };

  const unresolved: Record<string, number> = {};
  const scopeGaps: Record<string, number> = {};
  const brokenLinks: BrokenLink[] = [];
  const maxBroken = opts.maxBrokenLinks ?? 5000;
  let brokenTotal = 0;
  /**
   * A dropped reference. Only the ones written in a document's body are reported as broken links:
   * a `parent_id` or a `confluence_pages` entry pointing at a page sync deliberately excluded is a
   * scope decision, not a docs bug, and would otherwise be most of the report.
   */
  const drop = (reason: string, sourceId: string, href: string, where: "body" | "frontmatter" = "body"): void => {
    if (where === "frontmatter") {
      scopeGaps[reason] = (scopeGaps[reason] ?? 0) + 1;
      return;
    }
    unresolved[reason] = (unresolved[reason] ?? 0) + 1;
    if (!RESOLUTION_REASONS[reason]?.internal) return;
    brokenTotal++;
    if (brokenLinks.length < maxBroken) brokenLinks.push({ from: sourceId, href, reason });
  };

  // Documents first, so every node index below `entries.length` is a document and the label of a
  // hub can never overwrite a document's title.
  for (const e of entries) node(e.sourceId, "doc", e.sourceId);

  let read = 0;
  let failed = 0;
  const queue = [...entries];
  const worker = async (): Promise<void> => {
    for (let e = queue.shift(); e !== undefined; e = queue.shift()) {
      const self = e.sourceId;
      const selfIdx = nodeIndex.get(self) as number;
      let doc;
      try {
        doc = await loadDocument(kbDir, e.relPath);
      } catch {
        failed++;
        continue;
      }
      (nodes[selfIdx] as GraphNode).label = doc.meta.title;
      const fm = doc.frontmatter;

      // ---- frontmatter: where the document belongs -------------------------------------------
      const space = str(fm["space"]);
      if (space) {
        edge(selfIdx, node(`space:${space}`, "space", str(fm["space_name"]) ?? space), "in_space");
        const parentId = str(fm["parent_id"]);
        if (parentId) {
          const parent = resolver.confluencePage(parentId);
          if (parent) edge(selfIdx, node(parent, "doc", parent), "child_of");
          else drop("confluence-page", self, `parent_id:${parentId}`, "frontmatter");
        }
        // Every prefix of the ancestor chain, so "everything under Architecture › Providers" is one
        // hub rather than a title match across the space.
        const ancestors = list(fm["ancestors"]);
        for (let i = 0; i < ancestors.length; i++) {
          const chain = ancestors.slice(0, i + 1);
          edge(selfIdx, node(`tree:${space}/${chain.join("/")}`, "tree", chain.join(" › ")), "under");
        }
      }

      const project = str(fm["project"]);
      if (project) {
        edge(selfIdx, node(`repo:${project}`, "repo", str(fm["project_name"]) ?? project), "in_repo");
        const card = resolver.projectCard(project);
        if (card && card !== self) edge(selfIdx, node(card, "doc", card), "described_by");
      }

      const entity = str(fm["entity"]);
      if (entity) edge(selfIdx, node(`entity:${entity}`, "entity", str(fm["entity_title"]) ?? str(fm["entity_name"]) ?? entity), "about_entity");

      const owner = str(fm["owner"]);
      if (owner) edge(selfIdx, node(`team:${teamKey(owner)}`, "team", owner), "owned_by");

      for (const tag of list(fm["tags"])) {
        const key = tag.toLowerCase();
        if (key) edge(selfIdx, node(`tag:${key}`, "tag", key), "tagged");
      }

      const place = opts.places?.get(e.relPath);
      if (place?.area) edge(selfIdx, node(`area:${place.area}`, "area", place.labels.area), "in_area");
      if (place?.subarea) edge(selfIdx, node(`subarea:${place.subarea}`, "subarea", place.labels.subarea), "in_subarea");
      if (place?.module) edge(selfIdx, node(`module:${place.module}`, "module", place.labels.module), "in_module");

      // A project card points at the Dev Portal tree that renders the repository, and at the wiki
      // pages the CQL enricher tied to it.
      const techdocs = str(fm["techdocs_ref"]);
      if (techdocs && doc.meta.kind === "project") {
        const hit = resolver.resolveUrl(techdocs);
        if (isResolved(hit)) edge(selfIdx, node(hit.id, "doc", hit.id), "documents");
        else drop(hit.reason, self, techdocs, "frontmatter");
      }
      for (const url of list(fm["confluence_pages"])) {
        const hit = resolver.resolveUrl(url);
        if (isResolved(hit)) edge(selfIdx, node(hit.id, "doc", hit.id), "related_wiki");
        else drop(hit.reason, self, url, "frontmatter");
      }

      // ---- body: the links the document itself makes ------------------------------------------
      const hrefs: string[] = [];
      for (const m of doc.body.matchAll(LINK_RE)) if (!m[1] && m[2]) hrefs.push(m[2]);
      for (const m of doc.body.matchAll(AUTOLINK_RE)) if (m[1]) hrefs.push(m[1]);
      for (const href of hrefs) {
        const hit = resolver.resolve(href, self);
        if (isResolved(hit)) edge(selfIdx, node(hit.id, "doc", hit.id), "links_to");
        else if (hit.reason !== "unparsable") drop(hit.reason, self, href);
      }

      read++;
      if (read % 1000 === 0) log(`  read ${read}/${entries.length} documents`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 16) }, worker));
  if (failed) log(`  ! ${failed} documents in the manifest could not be read (re-run \`npm run ingest\`)`);

  const stats = {
    nodes: nodes.length,
    edges: from.length,
    byRelation,
    unresolved,
    scopeGaps,
    ...componentStats(nodes.length, from, to, rel, entries.length),
    brokenLinksTotal: brokenTotal,
    durationMs: Date.now() - started,
  };

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    docs: entries.length,
    nodes,
    relations: [...RELATIONS],
    edges: { from, to, rel },
    brokenLinks,
    stats,
  };
}

/**
 * How connected the documents actually are, counting only document-to-document edges: hub edges
 * would connect everything through "same repository" and say nothing about structure.
 */
function componentStats(
  nodeCount: number,
  from: number[],
  to: number[],
  rel: number[],
  docCount: number,
): { connectedDocs: number; largestComponent: number } {
  const docRel = new Set([0, 1, 2, 3, 4]); // RELATIONS[0..4] are the document-to-document ones
  const adj: number[][] = Array.from({ length: nodeCount }, () => []);
  for (let i = 0; i < from.length; i++) {
    if (!docRel.has(rel[i] as number)) continue;
    const a = from[i] as number;
    const b = to[i] as number;
    if (a >= docCount || b >= docCount) continue;
    (adj[a] as number[]).push(b);
    (adj[b] as number[]).push(a);
  }
  let connected = 0;
  for (let d = 0; d < docCount; d++) if ((adj[d] as number[]).length) connected++;
  const seen = new Uint8Array(docCount);
  let largest = 0;
  for (let d = 0; d < docCount; d++) {
    if (seen[d]) continue;
    seen[d] = 1;
    let size = 0;
    const stack = [d];
    while (stack.length) {
      const x = stack.pop() as number;
      size++;
      for (const y of adj[x] as number[]) {
        if (y < docCount && !seen[y]) {
          seen[y] = 1;
          stack.push(y);
        }
      }
    }
    if (size > largest) largest = size;
  }
  return { connectedDocs: connected, largestComponent: largest };
}

/**
 * City Map position of every document, from the catalog copy the last `npm run sync` saved plus
 * taxonomy.yaml — the same placement the map colours by. Returns null when there is no catalog to
 * place against, in which case the graph simply has no area/sub-area/module hubs.
 */
export async function loadPlaces(relPaths: Iterable<string>, kbDir = config.kbDir): Promise<Map<string, KbPlacement> | null> {
  const cityMap = ((await readState(paths.syncState, "devportal"))?.meta["citymap"] as CityMap | undefined) ?? null;
  const taxonomy = await loadTaxonomy(config.sync.taxonomyFile);
  // Without the catalog copy and without rules there is nothing to place against: no City Map hubs.
  if (!cityMap && !taxonomy.rules.length && !Object.keys(taxonomy.nodes).length) return null;
  return placeKbDocuments(kbDir, relPaths, cityMap, taxonomy);
}

/** Documents to build the graph over, straight from the ingest manifest. */
export async function manifestDocs(manifestFile = paths.manifest): Promise<{ sourceId: string; relPath: string }[]> {
  const manifest = await readManifest(manifestFile);
  if (!manifest) throw new Error(`No ingest manifest at ${manifestFile} — run \`npm run ingest\` first.`);
  return Object.values(manifest.docs).map((d) => ({ sourceId: d.sourceId, relPath: d.relPath }));
}
