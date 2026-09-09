import { parseFrontmatter } from "../ingest/loader.js";
import { tidyMarkdown } from "./html.js";
import { HttpError, mapLimit } from "./http.js";
import { firstHeading } from "./kb-writer.js";
import { detectLang } from "./lang.js";
import { matchesAny, wildcardToRegExp } from "./sources-config.js";
import { previousIdsWithPrefix, type Connector, type ConnectorContext, type SyncEvent } from "./types.js";

/**
 * GitLab connector (REST API v4, personal access token with `read_api`).
 * Lists the projects of the configured groups (recursively) and explicit projects, skips the ones
 * already covered by the Dev Portal, and indexes every markdown file matching sources.yaml.
 * Incremental at two levels: a project whose `last_activity_at` is unchanged is not even listed;
 * within a project only blobs whose sha changed are downloaded.
 */

interface Project {
  id: number;
  path_with_namespace: string;
  web_url: string;
  default_branch: string | null;
  last_activity_at: string;
  archived: boolean;
  empty_repo?: boolean;
}

interface TreeEntry {
  id: string;
  name: string;
  type: "blob" | "tree";
  path: string;
}

interface Commit {
  committed_date?: string;
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

async function discoverProjects(ctx: ConnectorContext): Promise<Project[]> {
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
  return [...byPath.values()].sort((a, b) => a.path_with_namespace.localeCompare(b.path_with_namespace));
}

export function selectMarkdownFiles(tree: TreeEntry[], include: string[], exclude: string[]): TreeEntry[] {
  const cache = new Map<string, RegExp>();
  return tree.filter((t) => t.type === "blob" && matchesAny(t.path, include, cache) && !matchesAny(t.path, exclude, cache));
}

export const syncGitLab: Connector = async function* (ctx): AsyncGenerator<SyncEvent> {
  const cfg = ctx.sources.gitlab;
  const base = ctx.baseUrl;

  const covered = new Set<string>();
  if (cfg.skip_if_in_devportal) {
    const dp = await ctx.otherState("devportal");
    const repos = dp?.meta["coveredRepos"];
    if (Array.isArray(repos)) for (const r of repos) if (typeof r === "string") covered.add(r.toLowerCase());
    ctx.log(`GitLab: ${covered.size} repositories are covered by the Dev Portal and will be skipped`);
  }

  const projects = await discoverProjects(ctx);
  if (!projects.length) {
    yield { type: "error", message: "no GitLab projects discovered (check gitlab.groups / gitlab.projects in sources.yaml and GITLAB_TOKEN)" };
  }

  const prevActivity = (ctx.previous.meta["projectActivity"] ?? {}) as Record<string, string>;
  const activity: Record<string, string> = {};
  const excluded = cfg.exclude_projects.map(wildcardToRegExp);
  let skippedCovered = 0;
  let skippedExcluded = 0;

  for (const p of projects) {
    const path = p.path_with_namespace;
    const prefix = `gitlab:${path}:`;
    if (excluded.some((re) => re.test(path))) {
      skippedExcluded++;
      continue;
    }
    if (covered.has(path.toLowerCase())) {
      skippedCovered++;
      continue;
    }
    if (ctx.only && !path.toLowerCase().includes(ctx.only.toLowerCase())) {
      for (const id of previousIdsWithPrefix(ctx.previous, prefix)) yield { type: "unchanged", sourceId: id };
      activity[path] = prevActivity[path] ?? p.last_activity_at;
      continue;
    }
    if (!p.default_branch || p.empty_repo) continue;

    const prevIds = previousIdsWithPrefix(ctx.previous, prefix);
    if (prevActivity[path] === p.last_activity_at && prevIds.length) {
      for (const id of prevIds) yield { type: "unchanged", sourceId: id };
      activity[path] = p.last_activity_at;
      continue;
    }

    let tree: TreeEntry[];
    try {
      tree = await paged<TreeEntry>(ctx, `${base}/api/v4/projects/${p.id}/repository/tree?recursive=true&ref=${enc(p.default_branch)}`);
    } catch (err) {
      yield { type: "error", sourceId: prefix, message: `tree: ${(err as Error).message}` };
      // Keep what we had; do not record activity so the project is retried next run.
      for (const id of prevIds) yield { type: "unchanged", sourceId: id };
      continue;
    }
    const files = selectMarkdownFiles(tree, cfg.include, cfg.exclude);
    ctx.log(`  ${path}: ${files.length} markdown files`);
    const branch = p.default_branch;

    const events = await mapLimit(files, ctx.concurrency, async (f): Promise<SyncEvent | null> => {
      const sourceId = `${prefix}${f.path}`;
      const prev = ctx.previous.items[sourceId];
      if (prev && prev.fingerprint === f.id) return { type: "unchanged", sourceId };
      try {
        const raw = await ctx.http.text(`${base}/api/v4/projects/${p.id}/repository/files/${enc(f.path)}/raw?ref=${enc(branch)}`, {
          headers: { accept: "text/plain, */*" },
        });
        if (raw.length > cfg.max_file_kb * 1024) return { type: "skip", sourceId, reason: `too large (${Math.round(raw.length / 1024)} KB)` };
        const { frontmatter, body } = parseFrontmatter(raw);
        const md = tidyMarkdown(body);
        if (md.length < cfg.min_body_chars) return { type: "skip", sourceId, reason: `stub (${md.length} chars)` };
        const fmTitle = typeof frontmatter["title"] === "string" ? frontmatter["title"].trim() : "";
        const title = fmTitle || firstHeading(md) || f.name.replace(/\.(md|markdown)$/i, "").replace(/[-_]+/g, " ");

        let lastModified: string | null = null;
        try {
          const commits = await ctx.http.json<Commit[]>(
            `${base}/api/v4/projects/${p.id}/repository/commits?path=${enc(f.path)}&ref_name=${enc(branch)}&per_page=1`,
          );
          lastModified = commits[0]?.committed_date?.slice(0, 10) ?? null;
        } catch {
          /* optional */
        }

        return {
          type: "doc",
          doc: {
            sourceId,
            sourceType: "gitlab",
            relPath: `gitlab/${path}/${f.path.replace(/\.markdown$/i, ".md").replace(/(?<!\.md)$/i, ".md")}`,
            title,
            sourceUrl: `${p.web_url}/-/blob/${branch}/${f.path}`,
            lang: detectLang(md),
            lastModified,
            body: md,
            fingerprint: f.id,
            extra: {
              project: path,
              project_url: p.web_url,
              ref: branch,
              file_path: f.path,
              blob_sha: f.id,
              project_last_activity: p.last_activity_at.slice(0, 10),
              doc_frontmatter_title: fmTitle || undefined,
            },
          },
        };
      } catch (err) {
        return { type: "error", sourceId, message: (err as Error).message };
      }
    });
    for (const ev of events) if (ev) yield ev;
    activity[path] = p.last_activity_at;
  }

  if (skippedExcluded) ctx.log(`GitLab: skipped ${skippedExcluded} projects listed in gitlab.exclude_projects`);
  if (skippedCovered) ctx.log(`GitLab: skipped ${skippedCovered} projects already covered by the Dev Portal`);
  yield { type: "meta", key: "projectActivity", value: activity };
  yield { type: "meta", key: "projects", value: projects.length };
};
