import { createHash } from "node:crypto";
import YAML from "yaml";
import { parseFrontmatter } from "../ingest/loader.js";
import { codeSkipReason, languageOf, renderCodeBody } from "./code.js";
import { tidyMarkdown } from "./html.js";
import { HttpError, mapLimit } from "./http.js";
import { firstHeading } from "./kb-writer.js";
import { detectLang } from "./lang.js";
import { buildProjectCard, type EntitySummary } from "./project-card.js";
import { isBoilerplateReadme, isStub } from "./quality.js";
import { matchesAny, wildcardToRegExp, type SourcesConfig } from "./sources-config.js";
import { previousIdsWithPrefix, type ConfluenceHit, type Connector, type ConnectorContext, type SyncEvent } from "./types.js";

/**
 * GitLab connector (REST API v4, personal access token with `read_api`).
 *
 * For every project of the configured groups (recursively), the explicit projects and — with
 * `include_devportal_repos` — the repositories the Dev Portal catalog points at, it produces:
 *  - the markdown documentation (`gitlab.docs` globs), minus stubs and generator boilerplate;
 *  - the OpenAPI/AsyncAPI contracts kept in the repository (`gitlab.api_specs`), as `kind: api`;
 *  - one "project card" (`kind: project`) combining the GitLab metadata, the Dev Portal entity
 *    (owner/system/lifecycle), the README, the languages and the Confluence pages that mention the project;
 *  - optionally (`gitlab.code.enabled`, off by default: too much noise for a technical Q&A corpus) every
 *    source file matching `gitlab.code` globs as one fenced block per file (`kind: code`).
 *
 * Incremental at two levels: a project whose default-branch head commit is unchanged is skipped entirely;
 * within a changed project only blobs whose sha changed are downloaded. Repository archives are not used
 * because this instance refuses them (HTTP 406), so files are fetched one by one with bounded concurrency.
 */

interface Project {
  id: number;
  name: string;
  path_with_namespace: string;
  web_url: string;
  description?: string | null;
  default_branch: string | null;
  last_activity_at: string;
  archived: boolean;
  empty_repo?: boolean;
  topics?: string[];
  tag_list?: string[];
}

interface TreeEntry {
  id: string;
  name: string;
  type: "blob" | "tree";
  path: string;
}

interface Commit {
  id?: string;
  committed_date?: string;
}

interface Branch {
  commit?: Commit;
}

interface Enrichment {
  at: string;
  hits: ConfluenceHit[];
}

async function paged<T>(ctx: ConnectorContext, urlWithoutPage: string): Promise<T[]> {
  const out: T[] = [];
  let page = 1;
  for (let guard = 0; guard < 10_000; guard++) {
    const sep = urlWithoutPage.includes("?") ? "&" : "?";
    const { data, headers } = await ctx.http.jsonWithHeaders<T[]>(`${urlWithoutPage}${sep}per_page=100&page=${page}`);
    out.push(...data);
    const next = headers.get("x-next-page");
    if (!next) break;
    page = Number(next);
    if (!Number.isFinite(page) || page <= 0) break;
  }
  return out;
}

const enc = encodeURIComponent;

async function discoverProjects(ctx: ConnectorContext, extraPaths: Iterable<string> = []): Promise<Project[]> {
  const cfg = ctx.sources.gitlab;
  const base = ctx.baseUrl;
  const byPath = new Map<string, Project>();
  for (const group of cfg.groups) {
    try {
      const archived = cfg.include_archived ? "" : "&archived=false";
      const list = await paged<Project>(ctx, `${base}/api/v4/groups/${enc(group)}/projects?include_subgroups=true&simple=false${archived}`);
      for (const p of list) byPath.set(p.path_with_namespace.toLowerCase(), p);
      ctx.log(`GitLab: group ${group}: ${list.length} projects`);
    } catch (err) {
      const hint = err instanceof HttpError && err.status === 404 ? " (group not found or no access)" : "";
      ctx.log(`  ! group ${group}: ${(err as Error).message}${hint}`);
    }
  }
  for (const path of cfg.projects) {
    if (byPath.has(path.toLowerCase())) continue;
    try {
      const p = await ctx.http.json<Project>(`${base}/api/v4/projects/${enc(path)}`);
      byPath.set(p.path_with_namespace.toLowerCase(), p);
    } catch (err) {
      ctx.log(`  ! project ${path}: ${(err as Error).message}`);
    }
  }
  // Repositories the portal documents but that live outside the configured groups. Many are not readable
  // with this token (404/403): count them instead of logging one line each.
  const extra = [...new Set([...extraPaths].map((p) => p.toLowerCase()))].filter((p) => !byPath.has(p));
  if (extra.length) {
    let unreadable = 0;
    const found = await mapLimit(extra, ctx.concurrency, async (path) => {
      try {
        return await ctx.http.json<Project>(`${base}/api/v4/projects/${enc(path)}`);
      } catch {
        unreadable++;
        return null;
      }
    });
    for (const p of found) if (p) byPath.set(p.path_with_namespace.toLowerCase(), p);
    ctx.log(`GitLab: ${found.length - unreadable} of ${extra.length} Dev Portal repositories outside the configured groups are readable${unreadable ? ` (${unreadable} not accessible with this token)` : ""}`);
  }
  return [...byPath.values()].sort((a, b) => a.path_with_namespace.localeCompare(b.path_with_namespace));
}

export interface SelectedFiles {
  docs: TreeEntry[];
  /** OpenAPI / AsyncAPI contracts (`kind: api`). */
  api: TreeEntry[];
  code: TreeEntry[];
  /** Files that look like source code by extension, whether or not code indexing is on (for the card). */
  sourceFileCount: number;
}

/** mkdocs content the Dev Portal already renders for repositories it covers. */
const TECHDOCS_PATTERNS = ["docs/**", "mkdocs.yml", "mkdocs.yaml"];

/** Split the repository tree into documentation and source files according to sources.yaml. */
export function selectFiles(tree: TreeEntry[], gitlab: SourcesConfig["gitlab"], coveredByDevportal: boolean): SelectedFiles {
  const cache = new Map<string, RegExp>();
  const docs: TreeEntry[] = [];
  const api: TreeEntry[] = [];
  const code: TreeEntry[] = [];
  let sourceFileCount = 0;
  for (const t of tree) {
    if (t.type !== "blob") continue;
    if (gitlab.docs.enabled && matchesAny(t.path, gitlab.docs.include, cache) && !matchesAny(t.path, gitlab.docs.exclude, cache)) {
      if (!(coveredByDevportal && gitlab.docs.skip_techdocs_if_in_devportal && matchesAny(t.path, TECHDOCS_PATTERNS, cache))) docs.push(t);
      continue;
    }
    if (gitlab.api_specs.enabled && matchesAny(t.path, gitlab.api_specs.include, cache) && !matchesAny(t.path, gitlab.api_specs.exclude, cache)) {
      api.push(t);
      continue;
    }
    if (matchesAny(t.path, gitlab.code.include, cache) && !matchesAny(t.path, gitlab.code.exclude, cache)) {
      if (gitlab.code.skip_tests && matchesAny(t.path, gitlab.code.test_patterns, cache)) continue;
      sourceFileCount++;
      if (gitlab.code.enabled) code.push(t);
    }
  }
  return { docs, api, code, sourceFileCount };
}

/** Parsed head of an OpenAPI / AsyncAPI / Swagger document, or null when the file is not one. */
export function apiSpecInfo(raw: string): { flavour: "openapi" | "asyncapi" | "swagger"; version: string; title: string; description: string; format: "yaml" | "json" } | null {
  const head = raw.slice(0, 4096);
  const key = /^\s*\{?\s*["']?(openapi|asyncapi|swagger)["']?\s*:\s*["']?(\d[\w.-]*)/m.exec(head);
  if (!key) return null;
  const format = /^\s*\{/.test(raw) ? "json" : "yaml";
  let title = "";
  let description = "";
  try {
    const parsed = YAML.parse(raw) as { info?: { title?: unknown; description?: unknown } } | null;
    const info = parsed?.info ?? {};
    title = typeof info.title === "string" ? info.title.trim() : "";
    description = typeof info.description === "string" ? info.description.trim() : "";
  } catch {
    /* an unparsable spec is still worth indexing as text */
  }
  return { flavour: key[1] as "openapi" | "asyncapi" | "swagger", version: key[2] as string, title, description, format };
}

/** Kept for callers/tests of the previous API: markdown selection only. */
export function selectMarkdownFiles(tree: TreeEntry[], include: string[], exclude: string[]): TreeEntry[] {
  const cache = new Map<string, RegExp>();
  return tree.filter((t) => t.type === "blob" && matchesAny(t.path, include, cache) && !matchesAny(t.path, exclude, cache));
}

const isReadme = (t: TreeEntry) => !t.path.includes("/") && /^readme(\.(md|markdown|mdx|txt|rst))?$/i.test(t.name);

function sha256(s: string): string {
  return `sha256:${createHash("sha256").update(s).digest("hex").slice(0, 24)}`;
}

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 86_400_000;
}

export const syncGitLab: Connector = async function* (ctx): AsyncGenerator<SyncEvent> {
  const cfg = ctx.sources.gitlab;
  const base = ctx.baseUrl;

  // What the Dev Portal already knows: repositories it renders (to skip their mkdocs content) and entity metadata.
  const covered = new Set<string>();
  const entities = new Map<string, EntitySummary>();
  {
    const dp = await ctx.otherState("devportal");
    const repos = dp?.meta["coveredRepos"];
    if (Array.isArray(repos)) for (const r of repos) if (typeof r === "string") covered.add(r.toLowerCase());
    const ents = dp?.meta["repoEntities"];
    if (ents && typeof ents === "object") for (const [k, v] of Object.entries(ents as Record<string, EntitySummary>)) entities.set(k.toLowerCase(), v);
    if (covered.size) ctx.log(`GitLab: ${covered.size} repositories are documented in the Dev Portal (their docs/ content is ${cfg.docs.skip_techdocs_if_in_devportal ? "skipped" : "indexed too"})`);
  }

  const projects = await discoverProjects(ctx, cfg.include_devportal_repos ? covered : []);
  if (!projects.length) {
    yield { type: "error", message: "no GitLab projects discovered (check gitlab.groups / gitlab.projects in sources.yaml and GITLAB_TOKEN)" };
  }

  const prevHeads = (ctx.previous.meta["projectHeads"] ?? {}) as Record<string, string>;
  const heads: Record<string, string> = {};
  const prevEnrichment = (ctx.previous.meta["projectEnrichment"] ?? {}) as Record<string, Enrichment>;
  const enrichment: Record<string, Enrichment> = {};
  const excluded = cfg.exclude_projects.map(wildcardToRegExp);
  const enrichCfg = ctx.sources.confluence;
  let skippedExcluded = 0;
  let unchangedProjects = 0;
  let projectIndex = 0;

  for (const p of projects) {
    projectIndex++;
    const path = p.path_with_namespace;
    const prefix = `gitlab:${path}:`;
    if (excluded.some((re) => re.test(path))) {
      skippedExcluded++;
      continue;
    }
    const keepPrevious = function* () {
      for (const id of previousIdsWithPrefix(ctx.previous, prefix)) yield { type: "unchanged", sourceId: id } as SyncEvent;
      if (prevHeads[path]) heads[path] = prevHeads[path] as string;
      if (prevEnrichment[path]) enrichment[path] = prevEnrichment[path] as Enrichment;
    };
    if (ctx.only && !path.toLowerCase().includes(ctx.only.toLowerCase())) {
      yield* keepPrevious();
      continue;
    }
    if (!p.default_branch || p.empty_repo) continue;
    const branch = p.default_branch;

    // Head commit of the default branch = the incremental key for the whole project.
    let head: Commit = {};
    try {
      head = (await ctx.http.json<Branch>(`${base}/api/v4/projects/${p.id}/repository/branches/${enc(branch)}`)).commit ?? {};
    } catch (err) {
      yield { type: "error", sourceId: prefix, message: `branch ${branch}: ${(err as Error).message}` };
    }
    // The incremental key also covers what the Dev Portal says about the repo (a portal sync that adds
    // owner/system, or starts rendering the repo's docs, refreshes the card and the docs/** rule next run) and
    // the file-selection settings (changing a glob re-lists every repository; unchanged blobs still cost nothing).
    const isCovered = covered.has(path.toLowerCase());
    const entity = entities.get(path.toLowerCase()) ?? null;
    const headKey = `${head.id ?? p.last_activity_at}|${sha256(JSON.stringify([isCovered, entity, cfg.docs, cfg.api_specs, cfg.code, cfg.min_body_chars, cfg.min_prose_words, cfg.skip_boilerplate_readmes])).slice(7, 19)}`;
    const prevIds = previousIdsWithPrefix(ctx.previous, prefix);
    if (prevHeads[path] === headKey && prevIds.length) {
      yield* keepPrevious();
      unchangedProjects++;
      continue;
    }

    let tree: TreeEntry[];
    try {
      tree = await paged<TreeEntry>(ctx, `${base}/api/v4/projects/${p.id}/repository/tree?recursive=true&ref=${enc(branch)}`);
    } catch (err) {
      yield { type: "error", sourceId: prefix, message: `tree: ${(err as Error).message}` };
      // Keep what we had; do not record the head so the project is retried next run.
      for (const id of prevIds) yield { type: "unchanged", sourceId: id };
      continue;
    }
    const files = selectFiles(tree, cfg, isCovered);
    if (files.code.length > cfg.code.max_files_per_project) {
      const byDir = new Map<string, number>();
      for (const f of files.code) {
        const parts = f.path.split("/");
        const dir = parts.length > 2 ? parts.slice(0, 2).join("/") : parts.length > 1 ? (parts[0] as string) : "(root)";
        byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
      }
      const top = [...byDir.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d, n]) => `${d}=${n}`).join(", ");
      yield {
        type: "error",
        sourceId: prefix,
        message: `${files.code.length} source files exceed gitlab.code.max_files_per_project (${cfg.code.max_files_per_project}); code skipped, docs kept. Likely vendored/generated folders: ${top}. Add them to gitlab.code.exclude or raise the limit.`,
      };
      files.code = [];
    }
    ctx.log(`  [${projectIndex}/${projects.length}] ${path}: ${files.docs.length} docs, ${files.api.length} API specs${cfg.code.enabled ? `, ${files.code.length} source files` : ""}`);
    const headDate = head.committed_date?.slice(0, 10) ?? p.last_activity_at.slice(0, 10);
    const common = { project: path, project_url: p.web_url, ref: branch, project_last_activity: p.last_activity_at.slice(0, 10) };

    // Side lookups for the project card run while the files download.
    const readmeEntry = tree.find(isReadme) ?? null;
    const readmePromise: Promise<string | null> = readmeEntry
      ? ctx.http.text(`${base}/api/v4/projects/${p.id}/repository/files/${enc(readmeEntry.path)}/raw?ref=${enc(branch)}`, { headers: { accept: "text/plain, */*" } }).then(
          (raw) => {
            const md = tidyMarkdown(parseFrontmatter(raw).body);
            // A generator README says nothing about this repository: leave the card without an excerpt.
            return cfg.skip_boilerplate_readmes && isBoilerplateReadme(md) ? null : md;
          },
          () => null,
        )
      : Promise.resolve(null);
    const languagesPromise: Promise<Record<string, number>> = ctx.http.json<Record<string, number>>(`${base}/api/v4/projects/${p.id}/languages`).catch(() => ({}));
    const cached = prevEnrichment[path];
    const enrichPromise: Promise<Enrichment> =
      !cfg.project_cards || !enrichCfg.enrich_projects || !ctx.enrich
        ? Promise.resolve({ at: new Date().toISOString(), hits: [] })
        : cached && daysBetween(cached.at, new Date().toISOString()) < enrichCfg.refresh_days
          ? Promise.resolve(cached)
          : ctx.enrich.confluencePages([p.name, path.split("/").pop() ?? ""]).then(
              (hits) => ({ at: new Date().toISOString(), hits }),
              (err) => {
                ctx.log(`  ! ${path}: Confluence lookup failed: ${(err as Error).message}`);
                return cached ?? { at: new Date(0).toISOString(), hits: [] };
              },
            );

    const docEvents = await mapLimit(files.docs, ctx.concurrency, async (f): Promise<SyncEvent | null> => {
      const sourceId = `${prefix}${f.path}`;
      const prev = ctx.previous.items[sourceId];
      if (prev && prev.fingerprint === f.id) return { type: "unchanged", sourceId };
      try {
        const raw = await ctx.http.text(`${base}/api/v4/projects/${p.id}/repository/files/${enc(f.path)}/raw?ref=${enc(branch)}`, {
          headers: { accept: "text/plain, */*" },
        });
        if (raw.length > cfg.docs.max_file_kb * 1024) return { type: "skip", sourceId, reason: `too large (${Math.round(raw.length / 1024)} KB)` };
        const { frontmatter, body } = parseFrontmatter(raw);
        const md = tidyMarkdown(body);
        if (md.length < cfg.min_body_chars) return { type: "skip", sourceId, reason: `stub (${md.length} chars)` };
        if (cfg.skip_boilerplate_readmes && isBoilerplateReadme(md)) return { type: "skip", sourceId, reason: "generator boilerplate" };
        if (isStub(md, cfg.min_prose_words)) return { type: "skip", sourceId, reason: "stub (no prose)" };
        const fmTitle = typeof frontmatter["title"] === "string" ? frontmatter["title"].trim() : "";
        const title = fmTitle || firstHeading(md) || f.name.replace(/\.(md|markdown|mdx)$/i, "").replace(/[-_]+/g, " ");

        let lastModified: string | null = null;
        try {
          const commits = await ctx.http.json<Commit[]>(`${base}/api/v4/projects/${p.id}/repository/commits?path=${enc(f.path)}&ref_name=${enc(branch)}&per_page=1`);
          lastModified = commits[0]?.committed_date?.slice(0, 10) ?? null;
        } catch {
          /* optional */
        }

        return {
          type: "doc",
          doc: {
            sourceId,
            sourceType: "gitlab",
            kind: "doc",
            relPath: `gitlab/${path}/${f.path.replace(/\.(markdown|mdx)$/i, ".md").replace(/(?<!\.md)$/i, ".md")}`,
            title,
            sourceUrl: `${p.web_url}/-/blob/${branch}/${f.path}`,
            lang: detectLang(md),
            lastModified: lastModified ?? headDate,
            body: md,
            fingerprint: f.id,
            extra: { ...common, breadcrumb: `GitLab › ${path}`, file_path: f.path, blob_sha: f.id, doc_frontmatter_title: fmTitle || undefined },
          },
        };
      } catch (err) {
        return { type: "error", sourceId, message: (err as Error).message };
      }
    });
    for (const ev of docEvents) if (ev) yield ev;

    const apiEvents = await mapLimit(files.api, ctx.concurrency, async (f): Promise<SyncEvent | null> => {
      const sourceId = `${prefix}${f.path}`;
      const prev = ctx.previous.items[sourceId];
      if (prev && prev.fingerprint === f.id) return { type: "unchanged", sourceId };
      try {
        const raw = await ctx.http.text(`${base}/api/v4/projects/${p.id}/repository/files/${enc(f.path)}/raw?ref=${enc(branch)}`, {
          headers: { accept: "text/plain, */*" },
        });
        if (raw.length > cfg.api_specs.max_file_kb * 1024) return { type: "skip", sourceId, reason: `too large (${Math.round(raw.length / 1024)} KB)` };
        const info = apiSpecInfo(raw);
        if (!info) return { type: "skip", sourceId, reason: "not an OpenAPI/AsyncAPI document" };
        const label = info.flavour === "asyncapi" ? "AsyncAPI" : "OpenAPI";
        const title = info.title ? `${info.title} (${label} definition)` : `${f.name} (${label} definition)`;
        const intro = [info.description, `${label} ${info.version} definition \`${f.path}\` of the repository \`${path}\`.`].filter(Boolean).join("\n\n");
        return {
          type: "doc",
          doc: {
            sourceId,
            sourceType: "gitlab",
            kind: "api",
            relPath: `gitlab/${path}/${f.path}.md`,
            title,
            sourceUrl: `${p.web_url}/-/blob/${branch}/${f.path}`,
            lang: detectLang(info.description) === "it" ? "it" : "en",
            lastModified: headDate,
            body: `${intro}\n\n${renderCodeBody(raw, info.format)}`,
            fingerprint: f.id,
            extra: { ...common, breadcrumb: `GitLab › ${path}`, file_path: f.path, blob_sha: f.id, api_type: info.flavour, api_version: info.version },
          },
        };
      } catch (err) {
        return { type: "error", sourceId, message: (err as Error).message };
      }
    });
    for (const ev of apiEvents) if (ev) yield ev;

    const codeEvents = await mapLimit(files.code, ctx.concurrency, async (f): Promise<SyncEvent | null> => {
      const sourceId = `${prefix}${f.path}`;
      const prev = ctx.previous.items[sourceId];
      if (prev && prev.fingerprint === f.id) return { type: "unchanged", sourceId };
      try {
        const raw = await ctx.http.text(`${base}/api/v4/projects/${p.id}/repository/files/${enc(f.path)}/raw?ref=${enc(branch)}`, {
          headers: { accept: "text/plain, */*" },
        });
        if (raw.length > cfg.code.max_file_kb * 1024) return { type: "skip", sourceId, reason: `too large (${Math.round(raw.length / 1024)} KB)` };
        const reason = codeSkipReason(raw, { maxLines: cfg.code.max_lines });
        if (reason) return { type: "skip", sourceId, reason };
        if (raw.trim().length < cfg.min_body_chars) return { type: "skip", sourceId, reason: `stub (${raw.trim().length} chars)` };
        const language = languageOf(f.path);
        const lines = raw.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n").length;
        return {
          type: "doc",
          doc: {
            sourceId,
            sourceType: "gitlab",
            kind: "code",
            relPath: `gitlab/${path}/${f.path}.md`,
            title: f.path,
            sourceUrl: `${p.web_url}/-/blob/${branch}/${f.path}`,
            lang: "und",
            lastModified: headDate,
            body: renderCodeBody(raw, language),
            fingerprint: f.id,
            extra: { ...common, file_path: f.path, blob_sha: f.id, language: language || undefined, lines },
          },
        };
      } catch (err) {
        return { type: "error", sourceId, message: (err as Error).message };
      }
    });
    for (const ev of codeEvents) if (ev) yield ev;

    if (cfg.project_cards) {
      const [readme, languages, enr] = await Promise.all([readmePromise, languagesPromise, enrichPromise]);
      enrichment[path] = enr;
      const topDirs = [...new Set(tree.filter((t) => t.type === "tree" && !t.path.includes("/")).map((t) => t.name))].sort().slice(0, 12);
      const card = buildProjectCard({
        path,
        name: p.name,
        webUrl: p.web_url,
        description: p.description ?? null,
        defaultBranch: branch,
        lastActivity: p.last_activity_at.slice(0, 10),
        topics: p.topics ?? p.tag_list ?? [],
        languages,
        entity,
        readme,
        confluence: enr.hits,
        files: { total: tree.filter((t) => t.type === "blob").length, code: files.sourceFileCount, docs: files.docs.length, topDirs },
      });
      const cardId = `${prefix}__project`;
      const fingerprint = sha256(card.body);
      if (ctx.previous.items[cardId]?.fingerprint === fingerprint) yield { type: "unchanged", sourceId: cardId };
      else
        yield {
          type: "doc",
          doc: {
            sourceId: cardId,
            sourceType: "gitlab",
            kind: "project",
            relPath: `gitlab/${path}/__project.md`,
            title: card.title,
            sourceUrl: p.web_url,
            lang: detectLang(card.body) === "it" ? "it" : "en",
            lastModified: headDate,
            body: card.body,
            fingerprint,
            extra: {
              ...common,
              project_name: p.name,
              description: p.description || undefined,
              entity: entity?.ref,
              owner: entity?.owner,
              system: entity?.system,
              languages: Object.keys(languages).slice(0, 6),
              confluence_pages: enr.hits.map((h) => h.url),
            },
          },
        };
    }
    heads[path] = headKey;
  }

  if (skippedExcluded) ctx.log(`GitLab: skipped ${skippedExcluded} projects listed in gitlab.exclude_projects`);
  if (unchangedProjects) ctx.log(`GitLab: ${unchangedProjects} projects unchanged since last run`);
  yield { type: "meta", key: "projectHeads", value: heads };
  yield { type: "meta", key: "projectEnrichment", value: enrichment };
  yield { type: "meta", key: "projects", value: projects.length };
};
