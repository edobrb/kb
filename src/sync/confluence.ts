import { createHash } from "node:crypto";
import { htmlToMarkdown } from "./html.js";
import { HttpError, mapLimit, type HttpClient } from "./http.js";
import { slugify } from "./kb-writer.js";
import { detectLang } from "./lang.js";
import { isStub, looksGenerated, proseStats } from "./quality.js";
import { wildcardToRegExp, type SourcesConfig } from "./sources-config.js";
import { previousIdsWithPrefix, type ConfluenceHit, type Connector, type ConnectorContext, type ProjectEnricher, type SyncEvent } from "./types.js";

/**
 * Confluence Cloud (REST API v2, basic auth with an Atlassian API token). Two jobs live here:
 *
 *  - `syncConfluence` indexes wiki pages as documents. Whole technical spaces are crawled, minus the
 *    subtrees, titles and stale or empty pages that only dilute retrieval (`roots`, `exclude_trees`,
 *    `exclude_titles`, `modified_since`, `min_*`). It is incremental on the page version number, so a run
 *    downloads only the bodies that changed.
 *  - `createConfluenceLookup` is the enrichment the GitLab connector uses while building the card of a
 *    repository: the few pages whose title or text mention the project, with their search snippet, so that
 *    "what is project X" answers and the chunk contexts of that repository point at the functional docs.
 *
 * Atlassian issues two kinds of API tokens: classic ones work against the site URL
 * (`https://<site>.atlassian.net/wiki/...`), *scoped* ones only through the gateway
 * (`https://api.atlassian.com/ex/confluence/<cloudId>/wiki/...`). `resolveConfluenceApi` tries the site
 * first and falls back to the gateway, resolving the cloudId from `/_edge/tenant_info`. Every API path goes
 * through `apiOrigin`; human-facing links always use `siteUrl`.
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

/* --------------------------------------------------------------------------- indexing connector */

/**
 * Navigation macros: they render the page tree / a label query inside the page, so their text is a copy of
 * other pages' titles and answers nothing. The *content* of an expand macro is kept, only its toggle goes.
 */
const REMOVE_SELECTORS = [
  '[data-macro-name="toc"]',
  ".toc-macro",
  '[data-macro-name="children"]',
  '[data-macro-name="pagetree"]',
  ".plugin_pagetree",
  '[data-macro-name="recently-updated"]',
  '[data-macro-name="contentbylabel"]',
  ".expand-control",
  ".confluence-information-macro-icon",
  ".aui-icon",
];

interface Space {
  id: string;
  key: string;
  name?: string;
  homepageId?: string;
  type?: string;
  status?: string;
}

interface PageSummary {
  id: string;
  status?: string;
  title?: string;
  spaceId?: string;
  parentId?: string | null;
  /** "page" | "folder" | "whiteboard" | ... — pages can hang under a folder. */
  parentType?: string | null;
  /** e.g. "live" for a live doc. */
  subtype?: string;
  version?: { number?: number; createdAt?: string; message?: string };
  _links?: { webui?: string };
}

interface PageWithBody extends PageSummary {
  body?: { export_view?: { value?: string } };
}

/** One step of the ancestor chain: a page or a folder. */
interface Ancestor {
  id: string;
  title: string;
  type: "page" | "folder";
  parentId: string | null;
  parentType: string | null;
}

/** `/folders/{id}` and `/pages/{id}` agree on the fields we need to walk one step up. */
interface AncestorResponse {
  id?: string;
  title?: string;
  parentId?: string | null;
  parentType?: string | null;
}

interface PagedV2<T> {
  results?: T[];
  /** Path (not a full URL) of the next page. */
  _links?: { next?: string };
}

/** A page that passed the filters and whose version moved: its body still has to be downloaded. */
interface Candidate {
  page: PageSummary;
  sourceId: string;
  title: string;
  fingerprint: string;
  /** Root → parent titles, without the space homepage. */
  ancestors: string[];
}

/** Follow `_links.next` until it is absent (it is a path on `apiOrigin`). */
async function listAllV2<T>(ctx: ConnectorContext, apiOrigin: string, path: string): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = path;
  for (let guard = 0; next && guard < 1000; guard++) {
    const page: PagedV2<T> = await ctx.http.json<PagedV2<T>>(next.startsWith("http") ? next : `${apiOrigin}${next}`);
    out.push(...(page.results ?? []));
    next = page._links?.next;
  }
  return out;
}

function regexOf(pattern: string, cache: Map<string, RegExp>): RegExp {
  let re = cache.get(pattern);
  if (!re) cache.set(pattern, (re = wildcardToRegExp(pattern)));
  return re;
}

const asAncestor = (p: PageSummary): Ancestor => ({
  id: String(p.id),
  title: (p.title ?? "").trim(),
  type: "page",
  parentId: p.parentId ?? null,
  parentType: p.parentType ?? null,
});

/** Title (or id) of the page/ancestor matching one of `exclude_trees`, or null when none does. */
function treeExclusion(trees: SourcesConfig["confluence"]["exclude_trees"], id: string, title: string, cache: Map<string, RegExp>): string | null {
  for (const t of trees) {
    if (t.id && t.id === id) return title || id;
    if (t.title && regexOf(t.title, cache).test(title)) return title;
  }
  return null;
}

/** Parent ids missing from the space listing: a folder, or a page outside `status=current`. Cached and never fatal. */
function createAncestorResolver(ctx: ConnectorContext, apiOrigin: string) {
  const cache = new Map<string, Ancestor | null>();
  const warned = new Set<string>();
  return async function resolve(id: string, type: string): Promise<Ancestor | null> {
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    let node: Ancestor | null = null;
    for (const endpoint of type === "folder" ? (["folders", "pages"] as const) : (["pages", "folders"] as const)) {
      try {
        const raw = await ctx.http.json<AncestorResponse>(`${apiOrigin}/wiki/api/v2/${endpoint}/${encodeURIComponent(id)}`);
        node = {
          id: String(raw.id ?? id),
          title: (raw.title ?? "").trim(),
          type: endpoint === "folders" ? "folder" : "page",
          parentId: raw.parentId ?? null,
          parentType: raw.parentType ?? null,
        };
        break;
      } catch {
        /* not that kind of container: try the other one */
      }
    }
    if (!node && !warned.has(id)) {
      warned.add(id);
      ctx.log(`  ! Confluence: ancestor ${type} ${id} is not readable; its children are treated as roots`);
    }
    cache.set(id, node);
    return node;
  };
}

/** Ancestors of a page, nearest parent first, stopping at the space homepage or at an id we cannot read. */
async function ancestorChain(
  page: PageSummary,
  listed: Map<string, PageSummary>,
  homepageId: string | undefined,
  resolve: (id: string, type: string) => Promise<Ancestor | null>,
): Promise<Ancestor[]> {
  const chain: Ancestor[] = [];
  const seen = new Set<string>([String(page.id)]);
  let parentId: string | null = page.parentId ?? null;
  let parentType: string | null = page.parentType ?? "page";
  for (let guard = 0; parentId && guard < 100; guard++) {
    if (seen.has(parentId)) break; // a cycle would loop forever
    seen.add(parentId);
    const fromListing: PageSummary | undefined = parentType === "page" ? listed.get(parentId) : undefined;
    const node: Ancestor | null = fromListing ? asAncestor(fromListing) : await resolve(parentId, parentType ?? "page");
    if (!node) break;
    chain.push(node);
    if (node.id === homepageId) break;
    parentId = node.parentId;
    parentType = node.parentType ?? "page";
  }
  return chain;
}

/** Labels are a bonus (they carry the space's own taxonomy): a failure must not lose the page. */
async function pageLabels(ctx: ConnectorContext, apiOrigin: string, id: string): Promise<string[]> {
  try {
    const res = await ctx.http.json<PagedV2<{ name?: string }>>(`${apiOrigin}/wiki/api/v2/pages/${id}/labels`);
    return (res.results ?? []).map((l) => (l.name ?? "").trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Download one page body and turn it into a document (or a skip/error event for it). */
async function fetchPage(ctx: ConnectorContext, api: ConfluenceApi, space: Space, c: Candidate): Promise<SyncEvent> {
  const cfg = ctx.sources.confluence;
  const id = String(c.page.id);
  try {
    const full = await ctx.http.json<PageWithBody>(`${api.apiOrigin}/wiki/api/v2/pages/${id}?body-format=export_view`);
    const title = (full.title ?? c.title).trim();
    let md = htmlToMarkdown(full.body?.export_view?.value ?? "", { baseUrl: api.siteUrl, removeSelectors: REMOVE_SELECTORS });
    if (md.length < cfg.min_body_chars || isStub(md, cfg.min_prose_words)) return { type: "skip", sourceId: c.sourceId, reason: `stub (${proseStats(md).proseWords} words) — ${title}` };
    if (looksGenerated(title, md)) return { type: "skip", sourceId: c.sourceId, reason: `generated — ${title}` };
    if (md.length > cfg.max_body_chars) md = `${md.slice(0, cfg.max_body_chars).trimEnd()}\n\n[… page truncated]`;
    const labels = await pageLabels(ctx, api.apiOrigin, id);
    const webui = full._links?.webui ?? c.page._links?.webui ?? `/spaces/${space.key}/pages/${id}`;
    const modifiedAt = full.version?.createdAt ?? c.page.version?.createdAt;
    return {
      type: "doc",
      doc: {
        sourceId: c.sourceId,
        sourceType: "confluence",
        kind: "doc",
        relPath: `confluence/${space.key}/${id}-${slugify(title, 80)}.md`,
        title,
        sourceUrl: `${api.siteUrl}/wiki${webui}`,
        lang: detectLang(md),
        lastModified: modifiedAt ? modifiedAt.slice(0, 10) : null,
        body: md,
        fingerprint: c.fingerprint,
        extra: {
          space: space.key,
          space_name: space.name,
          page_id: id,
          parent_id: c.page.parentId ?? undefined,
          ancestors: c.ancestors,
          labels,
          page_status: full.status ?? c.page.status,
          subtype: full.subtype ?? c.page.subtype,
          // Read by the ingest chunker as the heading-path prefix of every chunk: names only, no ids.
          breadcrumb: ["Confluence", space.name ?? space.key, ...c.ancestors].join(" › "),
          version: full.version?.number ?? c.page.version?.number,
        },
      },
    };
  } catch (err) {
    return { type: "error", sourceId: c.sourceId, message: (err as Error).message };
  }
}

interface SpaceCounts {
  name: string;
  listed: number;
  excluded: number;
  unchanged: number;
  fetched: number;
  indexed: number;
  /** Fetched but not worth indexing (stub, generated). */
  skipped: number;
  errors: number;
}

export const syncConfluence: Connector = async function* (ctx): AsyncGenerator<SyncEvent> {
  const cfg = ctx.sources.confluence;
  if (!cfg.spaces.include.length) {
    yield { type: "error", message: "confluence.spaces.include is empty; nothing to index" };
    return;
  }
  const excludedKeys = new Set(cfg.spaces.exclude.map((k) => k.toLowerCase()));
  const wantedKeys = cfg.spaces.include.filter((k) => !excludedKeys.has(k.toLowerCase()));
  if (!wantedKeys.length) {
    yield { type: "error", message: "every space in confluence.spaces.include is also in confluence.spaces.exclude; nothing to index" };
    return;
  }

  const api = await resolveConfluenceApi(ctx.http, ctx.baseUrl, ctx.settings?.["cloudId"]);
  // Part of every fingerprint: changing a quality threshold or the date limit must re-evaluate every page.
  const cfgHash = createHash("sha1").update(JSON.stringify([cfg.min_body_chars, cfg.min_prose_words, cfg.max_body_chars, cfg.modified_since])).digest("hex").slice(0, 8);
  const rootsByKey = new Map(Object.entries(cfg.roots).map(([k, v]) => [k.toLowerCase(), v]));
  const patterns = new Map<string, RegExp>();
  const resolveAncestor = createAncestorResolver(ctx, api.apiOrigin);
  const only = ctx.only?.toLowerCase();

  let spaces: Space[];
  try {
    spaces = await listAllV2<Space>(ctx, api.apiOrigin, `/wiki/api/v2/spaces?keys=${wantedKeys.map(encodeURIComponent).join(",")}&limit=250`);
  } catch (err) {
    yield { type: "error", message: `cannot list spaces ${wantedKeys.join(", ")}: ${(err as Error).message}` };
    // Nothing was seen: keep the previously indexed pages rather than letting the orchestrator delete them.
    for (const id of previousIdsWithPrefix(ctx.previous, "confluence:")) yield { type: "unchanged", sourceId: id };
    return;
  }
  spaces = spaces.filter((s) => s.key && !excludedKeys.has(s.key.toLowerCase()));
  const missing = wantedKeys.filter((k) => !spaces.some((s) => s.key.toLowerCase() === k.toLowerCase()));
  if (missing.length) ctx.log(`  ! Confluence: unknown space (or no access): ${missing.join(", ")}`);

  const counts: Record<string, SpaceCounts> = {};
  for (const space of spaces) {
    const key = space.key;
    const prefix = `confluence:${key}:`;
    const stat: SpaceCounts = { name: space.name ?? key, listed: 0, excluded: 0, unchanged: 0, fetched: 0, indexed: 0, skipped: 0, errors: 0 };
    counts[key] = stat;

    let pages: PageSummary[];
    try {
      pages = await listAllV2<PageSummary>(ctx, api.apiOrigin, `/wiki/api/v2/spaces/${space.id}/pages?limit=250&status=current`);
    } catch (err) {
      stat.errors++;
      yield { type: "error", message: `space ${key}: cannot list pages: ${(err as Error).message}` };
      // A listing that failed is not a space that was emptied: keep what the previous run indexed.
      for (const id of previousIdsWithPrefix(ctx.previous, prefix)) yield { type: "unchanged", sourceId: id };
      continue;
    }
    stat.listed = pages.length;

    const listed = new Map(pages.map((p) => [String(p.id), p]));
    const roots = rootsByKey.get(key.toLowerCase()) ?? [];
    const candidates: Candidate[] = [];

    for (const p of pages) {
      const id = String(p.id);
      const title = (p.title ?? "").trim();
      const sourceId = `${prefix}${id}`;
      // --only never prunes: everything it leaves out keeps the file it already has.
      if (only && !title.toLowerCase().includes(only) && !key.toLowerCase().includes(only)) {
        if (ctx.previous.items[sourceId]) {
          stat.unchanged++;
          yield { type: "unchanged", sourceId };
        }
        continue;
      }
      // Filters run before the incremental check: a page that now matches an exclusion is simply not
      // emitted, and the orchestrator deletes the file it had.
      if (cfg.exclude_titles.some((pat) => regexOf(pat, patterns).test(title))) {
        stat.excluded++;
        yield { type: "skip", sourceId, reason: `excluded title — ${title}` };
        continue;
      }
      const chain = await ancestorChain(p, listed, space.homepageId, resolveAncestor);
      let tree: string | null = null;
      for (const node of [{ id, title }, ...chain]) {
        tree = treeExclusion(cfg.exclude_trees, node.id, node.title, patterns);
        if (tree) break;
      }
      if (tree) {
        stat.excluded++;
        yield { type: "skip", sourceId, reason: `excluded tree "${tree}" — ${title}` };
        continue;
      }
      // A root page is itself inside its root.
      if (roots.length && !roots.includes(id) && !chain.some((n) => roots.includes(n.id))) {
        stat.excluded++;
        yield { type: "skip", sourceId, reason: `outside roots — ${title}` };
        continue;
      }
      const modifiedAt = (p.version?.createdAt ?? "").slice(0, 10);
      if (cfg.modified_since && modifiedAt && modifiedAt < cfg.modified_since) {
        stat.excluded++;
        yield { type: "skip", sourceId, reason: `older than modified_since (${modifiedAt}) — ${title}` };
        continue;
      }
      const fingerprint = `v${p.version?.number ?? 0}|${cfgHash}`;
      if (ctx.previous.items[sourceId]?.fingerprint === fingerprint) {
        stat.unchanged++;
        yield { type: "unchanged", sourceId };
        continue;
      }
      const ancestors = chain
        .filter((n) => n.id !== space.homepageId && n.title)
        .map((n) => n.title)
        .reverse();
      candidates.push({ page: p, sourceId, title, fingerprint, ancestors });
    }

    stat.fetched = candidates.length;
    ctx.log(`Confluence: ${space.name ?? key} (${key}): ${pages.length} pages listed → ${stat.excluded} excluded, ${stat.unchanged} unchanged, ${candidates.length} to fetch`);
    for (const ev of await mapLimit(candidates, ctx.concurrency, (c) => fetchPage(ctx, api, space, c))) {
      if (ev.type === "doc") stat.indexed++;
      else if (ev.type === "error") stat.errors++;
      else if (ev.type === "skip") stat.skipped++;
      yield ev;
    }
  }

  yield { type: "meta", key: "spaces", value: counts };
};
