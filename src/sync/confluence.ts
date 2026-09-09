import { HttpError, type HttpClient } from "./http.js";
import type { ConfluenceHit, ProjectEnricher } from "./types.js";

/**
 * Confluence Cloud lookup (REST API, basic auth with an Atlassian API token).
 *
 * Confluence pages are no longer indexed as documents. Instead, while the GitLab connector builds the
 * card of a repository, it asks here for the few wiki pages whose title or text mention the project, and
 * puts their titles, links and search snippets on the card — so "what is project X" answers and the chunk
 * contexts of that repository can point at the functional documentation.
 *
 * Atlassian issues two kinds of API tokens: classic ones work against the site URL
 * (`https://<site>.atlassian.net/wiki/...`), *scoped* ones only through the gateway
 * (`https://api.atlassian.com/ex/confluence/<cloudId>/wiki/...`). `resolveConfluenceApi` tries the site
 * first and falls back to the gateway, resolving the cloudId from `/_edge/tenant_info`.
 */

export interface ConfluenceApi {
  /** Origin to prepend to `/wiki/...` paths (site URL or gateway). */
  apiOrigin: string;
  /** Site URL, used for human-facing links. */
  siteUrl: string;
  mode: "site" | "gateway";
}

export async function resolveConfluenceApi(http: HttpClient, siteUrl: string, cloudId?: string): Promise<ConfluenceApi> {
  const site = siteUrl.replace(/\/$/, "");
  if (!cloudId) {
    try {
      await http.json(`${site}/wiki/api/v2/spaces?limit=1`);
      return { apiOrigin: site, siteUrl: site, mode: "site" };
    } catch (err) {
      if (!(err instanceof HttpError && (err.status === 401 || err.status === 403))) throw err;
    }
    const info = await http.json<{ cloudId?: string }>(`${site}/_edge/tenant_info`);
    if (!info.cloudId) throw new Error(`${site}/_edge/tenant_info did not return a cloudId; set CONFLUENCE_CLOUD_ID`);
    cloudId = info.cloudId;
  }
  const apiOrigin = `https://api.atlassian.com/ex/confluence/${cloudId}`;
  await http.json(`${apiOrigin}/wiki/api/v2/spaces?limit=1`);
  return { apiOrigin, siteUrl: site, mode: "gateway" };
}

export interface ConfluenceLookupConfig {
  spaces: { include: string[]; exclude: string[] };
  max_pages_per_project: number;
  excerpt_chars: number;
}

interface SearchResult {
  content?: { id?: string; title?: string; type?: string; _links?: { webui?: string } };
  title?: string;
  url?: string;
  excerpt?: string;
  lastModified?: string;
  resultGlobalContainer?: { title?: string; displayUrl?: string };
}

/** Words too generic to identify a repository in a wiki search. */
const GENERIC_TERMS = new Set(
  "api apis app apps web core common lib libs library service services frontend backend platform docs doc documentation demo test tests tools utils util sdk cli ui client server infra infrastructure config configuration template templates example examples training playground archive archived deprecated legacy old new main master monorepo repo repository project".split(
    " ",
  ),
);

/** Turn a project name / path slug into search terms: dedupe, drop short or generic words, escape quotes. */
export function searchTerms(candidates: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const term = raw.replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
    const key = term.toLowerCase();
    if (term.length < 4 || seen.has(key) || GENERIC_TERMS.has(key)) continue;
    seen.add(key);
    out.push(term);
  }
  return out;
}

/** Strip the `@@@hl@@@` highlight markers and collapse whitespace. */
export function cleanExcerpt(s: string | undefined, max: number): string {
  const t = (s ?? "")
    .replace(/@@@(end)?hl@@@/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

const cqlString = (s: string) => `"${s.replace(/["\\]/g, "")}"`;

export function buildCql(terms: string[], field: "title" | "text", spaces: ConfluenceLookupConfig["spaces"]): string {
  const parts = [`type=page`];
  if (spaces.include.length) parts.push(`space in (${spaces.include.map(cqlString).join(",")})`);
  if (spaces.exclude.length) parts.push(`space not in (${spaces.exclude.map(cqlString).join(",")})`);
  parts.push(`(${terms.map((t) => `${field} ~ ${cqlString(t)}`).join(" OR ")})`);
  return parts.join(" AND ");
}

export function createConfluenceLookup(http: HttpClient, siteUrl: string, cfg: ConfluenceLookupConfig, cloudId?: string): ProjectEnricher {
  let api: Promise<ConfluenceApi> | null = null;
  const resolve = () => (api ??= resolveConfluenceApi(http, siteUrl, cloudId));

  async function search(cql: string, limit: number): Promise<ConfluenceHit[]> {
    const { apiOrigin, siteUrl: site } = await resolve();
    const res = await http.json<{ results?: SearchResult[] }>(`${apiOrigin}/wiki/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${limit}`);
    const hits: ConfluenceHit[] = [];
    for (const r of res.results ?? []) {
      const webui = r.content?._links?.webui ?? r.url;
      const title = r.content?.title ?? r.title;
      if (!webui || !title || webui.startsWith("/spaces/~")) continue; // personal spaces are never used
      hits.push({
        title: title.trim(),
        url: `${site}/wiki${webui}`,
        space: r.resultGlobalContainer?.title ?? r.resultGlobalContainer?.displayUrl?.replace(/^\/spaces\//, "") ?? "",
        excerpt: cleanExcerpt(r.excerpt, cfg.excerpt_chars),
        lastModified: r.lastModified?.slice(0, 10) ?? null,
      });
    }
    return hits;
  }

  return {
    async confluencePages(candidates: string[]): Promise<ConfluenceHit[]> {
      const terms = searchTerms(candidates);
      const max = cfg.max_pages_per_project;
      if (!terms.length || max <= 0) return [];
      // Title matches are precise; text matches fill the remaining slots.
      const out = await search(buildCql(terms, "title", cfg.spaces), max);
      if (out.length < max) {
        const seen = new Set(out.map((h) => h.url));
        for (const h of await search(buildCql(terms, "text", cfg.spaces), max)) {
          if (out.length >= max) break;
          if (!seen.has(h.url)) out.push(h);
        }
      }
      return out;
    },
  };
}
