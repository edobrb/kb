import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { config, paths } from "../config.js";
import { createConfluenceLookup, resolveConfluenceApi, syncConfluence } from "./confluence.js";
import { syncDevPortal } from "./devportal.js";
import { syncGitLab } from "./gitlab.js";
import { createHttp, type HttpClient } from "./http.js";
import { KB_DOC_VERSION, renderKbDocument } from "./kb-writer.js";
import { duplicateKey } from "./quality.js";
import { applyRules, loadSourcesConfig, type SourcesConfig } from "./sources-config.js";
import { emptyState, readState, writeState } from "./state.js";
import type { Connector, ProjectEnricher, SyncState } from "./types.js";

export interface SourceDefinition {
  /** Folder under kb/ that this connector owns (everything in it is managed by sync). */
  folder: string;
  baseUrl: string;
  enabled: boolean;
  /** Human hint printed when credentials are missing. */
  credentialsHint: string;
  hasCredentials: boolean;
  http: () => HttpClient;
  /** Passed to the connector as ctx.settings. */
  settings?: Record<string, string | undefined>;
  /** Cheap authenticated request used by `npm run doctor`; resolves to a short status string. */
  probe: (http: HttpClient) => Promise<string>;
  /** Optional enrichment lookups handed to the connector as ctx.enrich. */
  enrich?: () => ProjectEnricher | undefined;
  run: Connector;
}

/** A system that is consulted during sync without being a source of documents (today: Confluence). */
export interface EnricherDefinition {
  baseUrl: string;
  enabled: boolean;
  credentialsHint: string;
  hasCredentials: boolean;
  http: () => HttpClient;
  probe: (http: HttpClient) => Promise<string>;
  create: () => ProjectEnricher;
}

export function builtinEnrichers(sources: SourcesConfig): Record<string, EnricherDefinition> {
  const c = config.sync.confluence;
  const basic = Buffer.from(`${c.email}:${c.token}`).toString("base64");
  const http = () => createHttp({ headers: { authorization: `Basic ${basic}` } });
  return {
    confluence: {
      baseUrl: c.baseUrl,
      enabled: sources.confluence.enrich_projects,
      credentialsHint: "set CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN (Atlassian API token) or set confluence.enrich_projects: false",
      hasCredentials: Boolean(c.email && c.token),
      http,
      probe: async (h) => {
        const api = await resolveConfluenceApi(h, c.baseUrl, c.cloudId || undefined);
        return api.mode === "gateway" ? "reachable via api.atlassian.com gateway (scoped token)" : "reachable via site URL";
      },
      create: () => createConfluenceLookup(http(), c.baseUrl, sources.confluence, c.cloudId || undefined),
    },
  };
}

export interface SyncOptions {
  /** Subset of source names; default: every enabled source. */
  sources?: string[];
  /** Ignore previous state and re-fetch everything. */
  full?: boolean;
  /** Fetch and report, but do not write kb/ or state. */
  dryRun?: boolean;
  /** Also delete files in the owned folders that this sync did not produce (e.g. old imports). */
  pruneForeign?: boolean;
  /** Debug: only items whose id/title contain this substring (never prunes). */
  only?: string;
  kbDir?: string;
  stateDir?: string;
  sourcesConfig?: SourcesConfig;
  /** Override the built-in connectors (tests). */
  definitions?: Record<string, SourceDefinition>;
  concurrency?: number;
  log?: (msg: string) => void;
}

export interface SourceReport {
  source: string;
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  skipped: number;
  /** Documents skipped because their body duplicates one already written in this run (included in `skipped`). */
  duplicates: number;
  errors: number;
  foreign: number;
  durationMs: number;
  /** Set when the connector aborted; nothing was pruned in that case. */
  fatal?: string;
}

export function builtinDefinitions(sources: SourcesConfig): Record<string, SourceDefinition> {
  const c = config.sync;
  const enrichers = builtinEnrichers(sources);
  return {
    devportal: {
      folder: "devportal",
      baseUrl: c.devportal.baseUrl,
      enabled: sources.devportal.enabled,
      credentialsHint: "set DEVPORTAL_TOKEN (Backstage bearer token, see README)",
      hasCredentials: Boolean(c.devportal.token),
      http: () => createHttp({ headers: { authorization: `Bearer ${c.devportal.token}` } }),
      settings: { gitlabHost: new URL(c.gitlab.baseUrl).host },
      probe: async (http) => {
        const r = await http.json<{ items?: unknown[]; totalItems?: number }>(`${c.devportal.baseUrl}/api/catalog/entities/by-query?limit=1`);
        return `catalog reachable${r.totalItems !== undefined ? ` (${r.totalItems} entities)` : ""}`;
      },
      run: syncDevPortal,
    },
    gitlab: {
      folder: "gitlab",
      baseUrl: c.gitlab.baseUrl,
      enabled: sources.gitlab.enabled,
      credentialsHint: "set GITLAB_TOKEN (personal access token with read_api)",
      hasCredentials: Boolean(c.gitlab.token),
      http: () => createHttp({ headers: { "private-token": c.gitlab.token } }),
      probe: async (http) => {
        const u = await http.json<{ username?: string }>(`${c.gitlab.baseUrl}/api/v4/user`);
        return `authenticated as ${u.username ?? "?"}`;
      },
      enrich: () => {
        const cf = enrichers["confluence"];
        return cf && cf.enabled && cf.hasCredentials ? cf.create() : undefined;
      },
      run: syncGitLab,
    },
    confluence: {
      folder: "confluence",
      baseUrl: c.confluence.baseUrl,
      enabled: sources.confluence.enabled,
      credentialsHint: "set CONFLUENCE_EMAIL and CONFLUENCE_API_TOKEN (Atlassian API token) or set confluence.enabled: false",
      hasCredentials: Boolean(c.confluence.email && c.confluence.token),
      http: () => createHttp({ headers: { authorization: `Basic ${Buffer.from(`${c.confluence.email}:${c.confluence.token}`).toString("base64")}` } }),
      settings: { cloudId: c.confluence.cloudId || undefined },
      probe: async (http) => {
        const api = await resolveConfluenceApi(http, c.confluence.baseUrl, c.confluence.cloudId || undefined);
        return `${api.mode === "gateway" ? "reachable via api.atlassian.com gateway (scoped token)" : "reachable via site URL"}; spaces ${sources.confluence.spaces.include.join(", ") || "(none configured)"}`;
      },
      run: syncConfluence,
    },
  };
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(cur: string) {
    let entries;
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(cur, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && !e.name.startsWith(".")) out.push(full);
    }
  }
  await walk(dir);
  return out;
}

async function removeEmptyDirs(dir: string, stopAt: string): Promise<void> {
  let cur = dir;
  while (cur.startsWith(stopAt) && cur !== stopAt) {
    try {
      const entries = await readdir(cur);
      if (entries.length) return;
      await rm(cur, { recursive: false, force: true });
    } catch {
      return;
    }
    cur = path.dirname(cur);
  }
}

export async function runSync(opts: SyncOptions = {}): Promise<SourceReport[]> {
  const log = opts.log ?? (() => {});
  const kbDir = opts.kbDir ?? config.kbDir;
  const stateDir = opts.stateDir ?? paths.syncState;
  const sources = opts.sourcesConfig ?? (await loadSourcesConfig(config.sync.sourcesFile));
  const defs = opts.definitions ?? builtinDefinitions(sources);
  const concurrency = opts.concurrency ?? config.sync.concurrency;
  const fetchedAt = new Date().toISOString().slice(0, 10);

  const wanted = opts.sources?.length ? opts.sources : Object.keys(defs).filter((k) => defs[k]?.enabled);
  for (const name of wanted) if (!defs[name]) throw new Error(`Unknown source "${name}". Known: ${Object.keys(defs).join(", ")}`);

  const reports: SourceReport[] = [];
  for (const name of wanted) {
    const def = defs[name] as SourceDefinition;
    const started = Date.now();
    const report: SourceReport = { source: name, added: 0, updated: 0, unchanged: 0, removed: 0, skipped: 0, duplicates: 0, errors: 0, foreign: 0, durationMs: 0 };
    reports.push(report);

    if (!def.hasCredentials) {
      report.fatal = `missing credentials: ${def.credentialsHint}`;
      log(`\n[${name}] skipped: ${report.fatal}`);
      report.durationMs = Date.now() - started;
      continue;
    }

    log(`\n[${name}] ${opts.full ? "full sync" : "incremental sync"}${opts.dryRun ? " (dry run)" : ""} from ${def.baseUrl}`);
    const stored: SyncState = (opts.full ? null : await readState(stateDir, name)) ?? emptyState(name);
    // A change to what renderKbDocument writes must reach documents the source itself reports as unchanged:
    // blanking the stored fingerprints makes every connector re-render once, then the new version is recorded.
    const staleRender = stored.docVersion !== KB_DOC_VERSION;
    const itemCount = Object.keys(stored.items).length;
    if (staleRender && itemCount) log(`  kb document format v${stored.docVersion ?? 1} -> v${KB_DOC_VERSION}: re-rendering all ${itemCount} documents`);
    const previous: SyncState = staleRender
      ? { ...stored, items: Object.fromEntries(Object.entries(stored.items).map(([id, item]) => [id, { ...item, fingerprint: "" }])) }
      : stored;
    const next: SyncState = { ...emptyState(name), docVersion: KB_DOC_VERSION, lastRunAt: stored.lastRunAt, meta: { ...previous.meta } };
    // The state is what makes the next run incremental, so it must survive a Ctrl-C: flush it as the run
    // goes, not only at the end. A partial state only costs a re-fetch of the items it does not mention yet.
    const STATE_FLUSH_MS = 5_000;
    // 0, not Date.now(): the first document already puts a usable state on disk.
    let lastStateWrite = 0;
    const flushState = async () => {
      if (opts.dryRun || Date.now() - lastStateWrite < STATE_FLUSH_MS) return;
      await writeState(stateDir, next);
      lastStateWrite = Date.now();
    };
    const ownedDir = path.join(kbDir, def.folder);
    const takenPaths = new Map<string, string>();
    // Identical bodies under different ids (a README copied into ten repositories, a page duplicated in two
    // spaces) would come back as near-identical chunks: keep the first, skip the rest.
    const seenBodies = new Map<string, string>();
    // Why documents were skipped: counts go to the log, the full list next to the state file, so the quality
    // filters in sources.yaml can be audited without re-running with a debugger.
    const skipReasons = new Map<string, number>();
    const skipped: { id: string; reason: string }[] = [];
    const noteSkip = (id: string, reason: string) => {
      const key = reason.replace(/ — .*$/, "").replace(/\(.*?\)/g, "").replace(/".*?"/g, "").trim();
      skipReasons.set(key, (skipReasons.get(key) ?? 0) + 1);
      if (skipped.length < 50_000) skipped.push({ id, reason });
    };
    const now = new Date().toISOString();
    let completed = false;

    try {
      const gen = def.run({
        http: def.http(),
        baseUrl: def.baseUrl,
        sources,
        previous: { items: previous.items, meta: previous.meta },
        otherState: (other) => readState(stateDir, other),
        log,
        settings: def.settings,
        enrich: def.enrich?.(),
        only: opts.only,
        concurrency,
      });
      for await (const ev of gen) {
        switch (ev.type) {
          case "unchanged": {
            const prev = previous.items[ev.sourceId];
            if (prev) {
              next.items[ev.sourceId] = prev;
              takenPaths.set(prev.relPath, ev.sourceId);
              report.unchanged++;
            }
            break;
          }
          case "meta":
            next.meta[ev.key] = ev.value;
            break;
          case "skip":
            report.skipped++;
            noteSkip(ev.sourceId, ev.reason);
            break;
          case "error":
            report.errors++;
            log(`  ! ${ev.sourceId ? `${ev.sourceId}: ` : ""}${ev.message}`);
            break;
          case "doc": {
            const doc = applyRules(ev.doc, sources.rules);
            if (!doc) {
              report.skipped++;
              noteSkip(ev.doc.sourceId, "skipped by a sources.yaml rule");
              break;
            }
            if (doc.kind !== "project") {
              const key = duplicateKey(doc.body);
              const dupOf = key.length >= 80 ? seenBodies.get(key) : undefined;
              if (dupOf && dupOf !== doc.sourceId) {
                report.skipped++;
                report.duplicates++;
                noteSkip(doc.sourceId, `duplicate of ${dupOf}`);
                break;
              }
              if (key.length >= 80) seenBodies.set(key, doc.sourceId);
            }
            if (!doc.relPath.startsWith(`${def.folder}/`)) {
              report.errors++;
              log(`  ! ${doc.sourceId}: relPath ${doc.relPath} is outside ${def.folder}/; dropped`);
              break;
            }
            let relPath = doc.relPath;
            const owner = takenPaths.get(relPath);
            if (owner && owner !== doc.sourceId) {
              const suffix = Buffer.from(doc.sourceId).toString("base64url").slice(-6);
              relPath = relPath.replace(/\.md$/, `-${suffix}.md`);
            }
            takenPaths.set(relPath, doc.sourceId);

            const prev = previous.items[doc.sourceId];
            const rendered = renderKbDocument({ ...doc, relPath }, fetchedAt);
            const abs = path.join(kbDir, relPath);
            if (!opts.dryRun) {
              await mkdir(path.dirname(abs), { recursive: true });
              const existing = await readFile(abs, "utf8").catch(() => null);
              // Same content but a fresh fetched_at only: keep the file byte-identical so ingest skips it.
              if (existing === null || stripFetchedAt(existing) !== stripFetchedAt(rendered)) await writeFile(abs, rendered, "utf8");
              if (prev && prev.relPath !== relPath) {
                await rm(path.join(kbDir, prev.relPath), { force: true });
                await removeEmptyDirs(path.dirname(path.join(kbDir, prev.relPath)), ownedDir);
              }
            }
            next.items[doc.sourceId] = { relPath, fingerprint: doc.fingerprint, title: doc.title, sourceUrl: doc.sourceUrl, syncedAt: now };
            if (prev) report.updated++;
            else report.added++;
            break;
          }
        }
        await flushState();
      }
      completed = true;
    } catch (err) {
      report.fatal = (err as Error).message;
      log(`  ✗ aborted: ${report.fatal}`);
    }

    // Items that disappeared from the source: delete their files. Only when the connector finished
    // and was not restricted with --only (an unseen item is not necessarily a deleted one otherwise).
    const unseen = Object.keys(previous.items).filter((id) => !(id in next.items));
    if (completed && !opts.only) {
      for (const id of unseen) {
        const prev = previous.items[id] as SyncState["items"][string];
        if (!opts.dryRun) {
          await rm(path.join(kbDir, prev.relPath), { force: true });
          await removeEmptyDirs(path.dirname(path.join(kbDir, prev.relPath)), ownedDir);
        }
        report.removed++;
      }
    } else {
      for (const id of unseen) next.items[id] = previous.items[id] as SyncState["items"][string];
    }

    // Files in the owned folder that sync does not know about (old manual imports, renamed files...).
    const known = new Set(Object.values(next.items).map((i) => path.resolve(kbDir, i.relPath)));
    const foreign = (await listFiles(ownedDir)).filter((f) => !known.has(path.resolve(f)));
    report.foreign = foreign.length;
    if (foreign.length) {
      if (opts.pruneForeign && !opts.dryRun) {
        for (const f of foreign) {
          await rm(f, { force: true });
          await removeEmptyDirs(path.dirname(f), ownedDir);
        }
        log(`  pruned ${foreign.length} foreign file(s) from ${def.folder}/`);
      } else {
        log(`  ! ${foreign.length} file(s) in ${def.folder}/ were not produced by sync (re-run with --prune-foreign to delete them)`);
      }
    }

    if (skipReasons.size) {
      const top = [...skipReasons.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${n} ${r}`).join(", ");
      log(`  skipped ${report.skipped}: ${top}`);
    }
    if (!opts.dryRun) {
      await mkdir(stateDir, { recursive: true });
      await writeFile(path.join(stateDir, `${name}.skipped.jsonl`), skipped.map((s) => JSON.stringify(s)).join("\n") + (skipped.length ? "\n" : ""), "utf8");
    }

    next.lastRunAt = now;
    if (!opts.dryRun) await writeState(stateDir, next);
    report.durationMs = Date.now() - started;
    log(
      `[${name}] done in ${(report.durationMs / 1000).toFixed(1)}s — added ${report.added}, updated ${report.updated}, unchanged ${report.unchanged}, ` +
        `removed ${report.removed}, skipped ${report.skipped}${report.duplicates ? ` (${report.duplicates} duplicates)` : ""}, errors ${report.errors}${report.fatal ? ` — ABORTED: ${report.fatal}` : ""}`,
    );
  }
  return reports;
}

function stripFetchedAt(s: string): string {
  return s.replace(/^fetched_at: .*$/m, "");
}
