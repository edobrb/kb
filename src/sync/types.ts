import type { DocKind } from "../types.js";
import type { HttpClient } from "./http.js";
import type { SourcesConfig } from "./sources-config.js";

/** One document produced by a connector, before it is rendered to `kb/<relPath>`. */
export interface SyncDoc {
  /** Stable id across runs, e.g. "gitlab:oneplatform/adrs:Platform/ADR0001.md", "devportal:default/component/x/page/". */
  sourceId: string;
  /** Default source type; rules in sources.yaml may override it (e.g. gitlab -> adr). */
  sourceType: string;
  /** doc (default) | code | project | api. */
  kind?: DocKind;
  /** Path under kb/ (always inside the connector's own folder). */
  relPath: string;
  title: string;
  sourceUrl: string | null;
  /** Left undefined to let the rules / default decide. */
  authority?: string;
  lang?: string;
  /** ISO date (YYYY-MM-DD) or null when the source does not expose one. */
  lastModified: string | null;
  /** Markdown body. */
  body: string;
  /** Extra frontmatter fields (project, owner, language, ...). */
  extra: Record<string, unknown>;
  /** Version marker from the source (git blob sha, TechDocs etag, content hash...). */
  fingerprint: string;
}

export interface StateItem {
  relPath: string;
  fingerprint: string;
  title: string;
  sourceUrl: string | null;
  syncedAt: string;
}

/** Persisted per source in data/sync/<source>.json so the next run can be incremental. */
export interface SyncState {
  version: 1;
  source: string;
  lastRunAt: string | null;
  items: Record<string, StateItem>;
  /** Connector-specific memory (e.g. devportal.coveredRepos, gitlab.projectHeads). */
  meta: Record<string, unknown>;
}

export type SyncEvent =
  | { type: "doc"; doc: SyncDoc }
  /** The source reports the same version as last run; keep the existing file. */
  | { type: "unchanged"; sourceId: string }
  /** Remember something for the next run / for other connectors. */
  | { type: "meta"; key: string; value: unknown }
  /** Seen but deliberately not indexed (stub page, too big, excluded...). */
  | { type: "skip"; sourceId: string; reason: string }
  /** Non-fatal problem with one item; the run continues. */
  | { type: "error"; sourceId?: string; message: string };

/** A Confluence page found while looking for material about a repository. */
export interface ConfluenceHit {
  title: string;
  url: string;
  space: string;
  /** Search snippet, plain text. */
  excerpt: string;
  lastModified: string | null;
}

/** Extra lookups a connector may use to enrich what it produces (today: Confluence pages about a project). */
export interface ProjectEnricher {
  /** Pages whose title or text mention one of the terms (a project name and its path slug). */
  confluencePages(terms: string[]): Promise<ConfluenceHit[]>;
}

export interface ConnectorContext {
  http: HttpClient;
  baseUrl: string;
  sources: SourcesConfig;
  /** State from the previous run of this connector (empty on --full). */
  previous: Pick<SyncState, "items" | "meta">;
  /** Read another connector's last state (e.g. gitlab consults devportal.coveredRepos / repoEntities). */
  otherState: (source: string) => Promise<SyncState | null>;
  log: (msg: string) => void;
  /** Source-specific settings from .env (e.g. the GitLab host the Dev Portal links point to). */
  settings?: Record<string, string | undefined>;
  /** Optional enrichment lookups (undefined when not configured / no credentials). */
  enrich?: ProjectEnricher;
  /** Debug: only process items whose id/title contains this substring. */
  only?: string;
  concurrency: number;
}

export type Connector = (ctx: ConnectorContext) => AsyncGenerator<SyncEvent>;

/** Ids from the previous state that start with `prefix` (one entity / one repository). */
export function previousIdsWithPrefix(previous: Pick<SyncState, "items">, prefix: string): string[] {
  return Object.keys(previous.items).filter((id) => id.startsWith(prefix));
}
