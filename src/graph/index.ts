import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { paths } from "../config.js";
import { DOC_RELATIONS, RELATION_LABELS, type BrokenLink, type GraphNode, type GraphStats, type KbGraphFile, type NodeType, type Relation } from "./types.js";

export * from "./types.js";
export { buildGraph, loadPlaces, manifestDocs } from "./build.js";
export { LinkResolver, RESOLUTION_REASONS } from "./resolve.js";

/**
 * The graph in memory: `data/graph.json.gz` plus the adjacency the queries need.
 *
 * At this scale (a few thousand documents, tens of thousands of edges) plain arrays answer a
 * neighbourhood query in microseconds, which is why there is no graph engine here: a second
 * database would have to be kept in step with the manifest for no gain in speed.
 */

export interface HubRef {
  id: string;
  type: NodeType;
  label: string;
  /** How many documents hang off it. */
  size: number;
  /** How this document is attached (`in_repo`, `in_module`, …). */
  relation: Relation;
}

export interface Neighbor {
  sourceId: string;
  title: string;
  relation: Relation;
  /** `out`: this document points at it. `in`: it points here. `sibling`: both share `via`. */
  direction: "out" | "in" | "sibling";
  /** The hub two siblings have in common. */
  via?: HubRef;
  /** Strength of the connection; direct edges outrank siblings, small hubs outrank big ones. */
  weight: number;
}

export interface NeighborOptions {
  /** Keep only these relations. */
  relations?: readonly Relation[];
  limit?: number;
  /** Include documents that only share a hub (same repository, space, module, team, tag). */
  siblings?: boolean;
  /**
   * Hubs larger than this contribute no siblings. "Same repository" is a useful hint in a repo of
   * eight documents and noise in one of three hundred.
   */
  maxHubSize?: number;
}

/** How much a direct edge is worth, seen from either end. */
const DIRECT_WEIGHT: Partial<Record<Relation, number>> = {
  child_of: 1,
  described_by: 0.95,
  documents: 0.95,
  links_to: 0.9,
  related_wiki: 0.8,
};

const DEFAULT_MAX_HUB = 60;

export class KbGraph {
  private readonly index = new Map<string, number>();
  private readonly outAdj: number[][];
  private readonly inAdj: number[][];
  /** Hub node index -> the document node indices attached to it. */
  private readonly members: number[][];

  constructor(private readonly data: KbGraphFile) {
    const n = data.nodes.length;
    this.outAdj = Array.from({ length: n }, () => []);
    this.inAdj = Array.from({ length: n }, () => []);
    this.members = Array.from({ length: n }, () => []);
    data.nodes.forEach((node, i) => this.index.set(node.id, i));
    const { from, to } = data.edges;
    for (let e = 0; e < from.length; e++) {
      const a = from[e] as number;
      const b = to[e] as number;
      (this.outAdj[a] as number[]).push(e);
      (this.inAdj[b] as number[]).push(e);
      if (this.typeAt(b) !== "doc" && this.typeAt(a) === "doc") (this.members[b] as number[]).push(a);
    }
  }

  static async load(file = paths.graph): Promise<KbGraph | null> {
    try {
      const raw = await readFile(file);
      const json = file.endsWith(".gz") ? gunzipSync(raw).toString("utf8") : raw.toString("utf8");
      const parsed = JSON.parse(json) as KbGraphFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.nodes)) return null;
      return new KbGraph(parsed);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  static async save(graph: KbGraphFile, file = paths.graph): Promise<number> {
    await mkdir(path.dirname(file), { recursive: true });
    const json = JSON.stringify(graph);
    const body = file.endsWith(".gz") ? gzipSync(json, { level: 9 }) : Buffer.from(json, "utf8");
    const tmp = `${file}.tmp`;
    await writeFile(tmp, body);
    await rename(tmp, file);
    return body.length;
  }

  get stats(): GraphStats {
    return this.data.stats;
  }
  get generatedAt(): string {
    return this.data.generatedAt;
  }
  get docCount(): number {
    return this.data.docs;
  }
  get nodeCount(): number {
    return this.data.nodes.length;
  }
  get edgeCount(): number {
    return this.data.edges.from.length;
  }
  get brokenLinks(): BrokenLink[] {
    return this.data.brokenLinks;
  }

  has(sourceId: string): boolean {
    const i = this.index.get(sourceId);
    return i !== undefined && this.typeAt(i) === "doc";
  }

  node(sourceId: string): GraphNode | null {
    const i = this.index.get(sourceId);
    return i === undefined ? null : (this.data.nodes[i] as GraphNode);
  }

  private typeAt(i: number): NodeType {
    return (this.data.nodes[i] as GraphNode).type;
  }
  private nodeAt(i: number): GraphNode {
    return this.data.nodes[i] as GraphNode;
  }
  private relAt(e: number): Relation {
    return this.data.relations[this.data.edges.rel[e] as number] as Relation;
  }

  /** The hubs a document belongs to, largest last (a big hub is a weaker statement). */
  hubsOf(sourceId: string): HubRef[] {
    const i = this.index.get(sourceId);
    if (i === undefined) return [];
    const out: HubRef[] = [];
    for (const e of this.outAdj[i] as number[]) {
      const target = this.data.edges.to[e] as number;
      const node = this.nodeAt(target);
      if (node.type === "doc") continue;
      out.push({ id: node.id, type: node.type, label: node.label, size: (this.members[target] as number[]).length, relation: this.relAt(e) });
    }
    return out.sort((a, b) => a.size - b.size);
  }

  /** Documents attached to a hub (`repo:oneplatform/adrs`, `module:workspace`, `tag:quarkus`). */
  membersOf(hubId: string, limit = 200): { sourceId: string; title: string }[] {
    const i = this.index.get(hubId);
    if (i === undefined || this.typeAt(i) === "doc") return [];
    return (this.members[i] as number[]).slice(0, limit).map((d) => ({ sourceId: this.nodeAt(d).id, title: this.nodeAt(d).label }));
  }

  hubSize(hubId: string): number {
    const i = this.index.get(hubId);
    return i === undefined ? 0 : (this.members[i] as number[]).length;
  }

  /** Every hub of a given type, biggest first — the "what is in the knowledge base" view. */
  hubs(type: NodeType, limit = 50): { id: string; label: string; size: number }[] {
    if (type === "doc") return [];
    return this.data.nodes
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => n.type === type)
      .map(({ n, i }) => ({ id: n.id, label: n.label, size: (this.members[i] as number[]).length }))
      .sort((a, b) => b.size - a.size)
      .slice(0, limit);
  }

  /**
   * What this document is connected to: direct edges first, then documents that share one of its
   * smaller hubs. A relation filter narrows both halves, so `relations: ["links_to"]` is the
   * citation neighbourhood and `relations: ["in_repo"]` is "the rest of this repository".
   */
  neighbors(sourceId: string, opts: NeighborOptions = {}): Neighbor[] {
    const i = this.index.get(sourceId);
    if (i === undefined) return [];
    const wanted = opts.relations?.length ? new Set(opts.relations) : null;
    const maxHub = opts.maxHubSize ?? DEFAULT_MAX_HUB;
    const best = new Map<string, Neighbor>();
    const keep = (cand: Neighbor): void => {
      const prev = best.get(cand.sourceId);
      if (!prev || cand.weight > prev.weight) best.set(cand.sourceId, cand);
    };

    for (const [adj, direction] of [
      [this.outAdj[i] as number[], "out"],
      [this.inAdj[i] as number[], "in"],
    ] as const) {
      for (const e of adj) {
        const other = (direction === "out" ? this.data.edges.to[e] : this.data.edges.from[e]) as number;
        const node = this.nodeAt(other);
        if (node.type !== "doc") continue;
        const relation = this.relAt(e);
        if (wanted && !wanted.has(relation)) continue;
        keep({
          sourceId: node.id,
          title: node.label,
          relation,
          direction,
          weight: (DIRECT_WEIGHT[relation] ?? 0.7) - (direction === "in" ? 0.05 : 0),
        });
      }
    }

    if (opts.siblings !== false) {
      for (const hub of this.hubsOf(sourceId)) {
        if (wanted && !wanted.has(hub.relation)) continue;
        // A relation asked for explicitly is worth listing however big the hub is.
        if (!wanted && hub.size > maxHub) continue;
        const hubIdx = this.index.get(hub.id) as number;
        // 1/log2 so a hub of 4 documents is a real hint and one of 200 barely registers.
        const weight = 0.6 / Math.log2(Math.max(2, hub.size) + 2);
        for (const d of this.members[hubIdx] as number[]) {
          const node = this.nodeAt(d);
          if (node.id === sourceId) continue;
          keep({ sourceId: node.id, title: node.label, relation: hub.relation, direction: "sibling", via: hub, weight });
        }
      }
    }

    const out = [...best.values()].sort((a, b) => b.weight - a.weight || a.title.localeCompare(b.title));
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  /**
   * Document-to-document edges as index pairs into a compact node list, for the map overlay: the
   * hub edges are left out because drawing "same repository" would be a line between every pair.
   */
  docEdgesPayload(): { nodes: { id: string; title: string }[]; edges: number[][]; relations: Relation[] } {
    const docRels = new Set<Relation>(DOC_RELATIONS);
    const used = new Map<number, number>();
    const nodes: { id: string; title: string }[] = [];
    const localOf = (n: number): number => {
      const existing = used.get(n);
      if (existing !== undefined) return existing;
      const node = this.nodeAt(n);
      nodes.push({ id: node.id, title: node.label });
      used.set(n, nodes.length - 1);
      return nodes.length - 1;
    };
    const relations = [...docRels];
    const edges: number[][] = [];
    const { from, to } = this.data.edges;
    for (let e = 0; e < from.length; e++) {
      const relation = this.relAt(e);
      if (!docRels.has(relation)) continue;
      const a = from[e] as number;
      const b = to[e] as number;
      if (this.typeAt(a) !== "doc" || this.typeAt(b) !== "doc") continue;
      edges.push([localOf(a), localOf(b), relations.indexOf(relation)]);
    }
    return { nodes, edges, relations };
  }
}

/** "linked from", "in repository" — how a neighbour reads in a result. */
export function relationPhrase(n: Neighbor): string {
  const labels = RELATION_LABELS[n.relation];
  if (n.direction === "sibling") return `same ${n.via?.type ?? "group"}`;
  return n.direction === "out" ? labels.out : labels.in;
}

let cached: Promise<KbGraph | null> | null = null;

/** The process-wide graph, loaded once. Null when it has not been built yet. */
export function getGraph(): Promise<KbGraph | null> {
  if (!cached) cached = KbGraph.load();
  return cached;
}

/** Drop the cached graph so the next query sees a rebuilt one. */
export function resetGraph(): void {
  cached = null;
}
