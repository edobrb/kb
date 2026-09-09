import type { HttpClient } from "./http.js";
import type { SourcesConfig } from "./sources-config.js";

/** One document produced by a connector, before it is rendered to `kb/<relPath>`. */
export interface SyncDoc {
  /** Stable id across runs, e.g. "confluence:CTO:1079836744", "gitlab:oneplatform/adrs:Platform/ADR0001.md". */
  sourceId: string;
  /** Default source type; rules in sources.yaml may override it (e.g. gitlab -> adr). */
  sourceType: string;
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
  /** Extra frontmatter fields (space_key, project, owner, ...). */
  extra: Record<string, unknown>;
  /** Version marker from the source (Confluence version, git blob sha, TechDocs etag...). */
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
  /** Connector-specific memory (e.g. devportal.coveredRepos, gitlab.projectActivity). */
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

export interface ConnectorContext {
  http: HttpClient;
  baseUrl: string;
  sources: SourcesConfig;
  /** State from the previous run of this connector (empty on --full). */
  previous: Pick<SyncState, "items" | "meta">;
  /** Read another connector's last state (e.g. gitlab consults devportal.coveredRepos). */
  otherState: (source: string) => Promise<SyncState | null>;
  log: (msg: string) => void;
  /** Source-specific settings from .env (e.g. confluence cloudId override). */
  settings?: Record<string, string | undefined>;
  /** Debug: only process items whose id/title contains this substring. */
  only?: string;
  concurrency: number;
}

export type Connector = (ctx: ConnectorContext) => AsyncGenerator<SyncEvent>;

/** Ids from the previous state that start with `prefix` (one entity / one repository). */
export function previousIdsWithPrefix(previous: Pick<SyncState, "items">, prefix: string): string[] {
  return Object.keys(previous.items).filter((id) => id.startsWith(prefix));
}
