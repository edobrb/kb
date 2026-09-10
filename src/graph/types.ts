/**
 * The knowledge graph over kb/: what links a document to another document, and which repository,
 * space, portal entity, team or City Map node it belongs to.
 *
 * Nothing here is inferred by a model. Every edge is either written in a document's frontmatter by
 * sync (`project`, `space`, `parent_id`, `entity`, `owner`, `confluence_pages`, …) or is a markdown
 * link in its body whose target reverse-maps to an indexed `source_id`. That is the whole point of
 * the layer: similarity search already finds pages that read alike, and cannot answer "what else is
 * in this repository", "what does this ADR supersede", "which pages link here".
 */

/** Kinds of node. `doc` is a kb document; everything else is a hub many documents hang off. */
export type NodeType = "doc" | "repo" | "space" | "tree" | "entity" | "team" | "tag" | "area" | "subarea" | "module";

export const HUB_TYPES: readonly NodeType[] = ["repo", "space", "tree", "entity", "team", "tag", "area", "subarea", "module"];

/**
 * Edge relations, `from` → `to`.
 *
 * The first group is document → document and is the interesting half: it is real structure, not a
 * grouping. The second is document → hub, which is how "everything in this repo / space / module"
 * is answered without materialising a clique per group.
 */
export type Relation =
  /** A markdown link in the body of `from` pointing at `to`. */
  | "links_to"
  /** Confluence page tree: `from` is a child page of `to` (from `parent_id`). */
  | "child_of"
  /** `to` is the project card of the repository `from` lives in. */
  | "described_by"
  /** `from` is a project card, `to` a page of the Dev Portal tree that renders that repository. */
  | "documents"
  /** `from` is a project card, `to` a Confluence page the CQL enricher tied to that repository. */
  | "related_wiki"
  /** Document → hub. */
  | "in_repo"
  | "in_space"
  /** Document → one ancestor path inside its space (`tree:CTO/Architecture/Providers`). */
  | "under"
  | "about_entity"
  | "owned_by"
  /** Document → a Dev Portal catalog tag of its entity (`quarkus`, `iam`): mostly technology. */
  | "tagged"
  /** Document → its City Map position (area › sub-area › module; see src/citymap.ts). */
  | "in_area"
  | "in_subarea"
  | "in_module";

export const RELATIONS: readonly Relation[] = [
  "links_to",
  "child_of",
  "described_by",
  "documents",
  "related_wiki",
  "in_repo",
  "in_space",
  "under",
  "about_entity",
  "owned_by",
  "tagged",
  "in_area",
  "in_subarea",
  "in_module",
];

/** Relations between two documents; the rest attach a document to a hub. */
export const DOC_RELATIONS: readonly Relation[] = ["links_to", "child_of", "described_by", "documents", "related_wiki"];

/** How a relation reads in a tool result or the UI, from the subject's point of view. */
export const RELATION_LABELS: Record<Relation, { out: string; in: string }> = {
  links_to: { out: "links to", in: "linked from" },
  child_of: { out: "child page of", in: "child page" },
  described_by: { out: "described by", in: "describes" },
  documents: { out: "documents", in: "documented by" },
  related_wiki: { out: "related wiki page", in: "related repository" },
  in_repo: { out: "in repository", in: "contains" },
  in_space: { out: "in space", in: "contains" },
  under: { out: "under", in: "contains" },
  about_entity: { out: "about entity", in: "documented by" },
  owned_by: { out: "owned by", in: "owns" },
  tagged: { out: "tagged", in: "tagged" },
  in_area: { out: "in area", in: "contains" },
  in_subarea: { out: "in sub-area", in: "contains" },
  in_module: { out: "in module", in: "contains" },
};

export interface GraphNode {
  /** A document's `source_id`, or `<type>:<key>` for a hub (`repo:oneplatform/adrs`). */
  id: string;
  type: NodeType;
  /** Human label: the document title, or the repository / space / team name. */
  label: string;
}

/** An internal link whose target did not resolve to an indexed document: a docs bug, mostly. */
export interface BrokenLink {
  /** The document that contains the link. */
  from: string;
  /** The href as written. */
  href: string;
  /** Why it did not resolve; see RESOLUTION_REASONS. */
  reason: string;
}

/**
 * On-disk form (`data/graph.json.gz`). Edges are index triples into `nodes` and `relations`, which
 * is what keeps a graph of this size a few hundred kB: the same repository id would otherwise be
 * repeated once per document in it.
 */
export interface KbGraphFile {
  version: 1;
  generatedAt: string;
  /** Documents that were resolvable when the graph was built (the manifest's size). */
  docs: number;
  nodes: GraphNode[];
  relations: Relation[];
  edges: { from: number[]; to: number[]; rel: number[] };
  /** Internal links that point at nothing indexed, capped; see `npm run graph -- --broken-links`. */
  brokenLinks: BrokenLink[];
  stats: GraphStats;
}

export interface GraphStats {
  nodes: number;
  edges: number;
  /** Edge count per relation. */
  byRelation: Partial<Record<Relation, number>>;
  /** Body-link targets dropped, per reason. */
  unresolved: Record<string, number>;
  /**
   * Frontmatter references (a Confluence `parent_id`, a project card's `confluence_pages`) that
   * point at a page sync did not index. Not a docs bug: the sync scope excludes those trees.
   */
  scopeGaps: Record<string, number>;
  /** Documents with at least one document-to-document edge. */
  connectedDocs: number;
  /** Documents in the largest connected component (document edges only). */
  largestComponent: number;
  brokenLinksTotal: number;
  durationMs: number;
}
