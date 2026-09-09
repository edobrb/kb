import { htmlToMarkdown } from "./html.js";
import { HttpError, mapLimit, type HttpClient } from "./http.js";
import { slugify } from "./kb-writer.js";
import { detectLang } from "./lang.js";
import type { Connector, ConnectorContext, SyncEvent } from "./types.js";

/**
 * Confluence Cloud connector (REST API v2, basic auth with an Atlassian API token).
 * Lists every space the token can see (minus include/exclude), lists the pages of each space
 * without bodies, and fetches the rendered body (`export_view`) only for pages whose version changed.
 *
 * Atlassian issues two kinds of API tokens: classic ones work against the site URL
 * (`https://<site>.atlassian.net/wiki/api/v2/...`), *scoped* ones only through the gateway
 * (`https://api.atlassian.com/ex/confluence/<cloudId>/wiki/api/v2/...`). `resolveConfluenceApi`
 * tries the site first and falls back to the gateway, resolving the cloudId from `/_edge/tenant_info`.
 */

export interface ConfluenceApi {
  /** Origin to prepend to `/wiki/api/v2/...` paths (site URL or gateway). */
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

interface Paged<T> {
  results: T[];
  _links?: { next?: string; base?: string };
}

interface V2Space {
  id: string;
  key: string;
  name: string;
  type: string;
  status: string;
}

interface V2Content {
  id: string;
  title: string;
  status: string;
  parentId?: string | null;
  spaceId: string;
  version?: { number: number; createdAt?: string };
  _links?: { webui?: string };
  body?: { export_view?: { value?: string } };
}

export const CONFLUENCE_REMOVE = [
  ".toc-macro", // table-of-contents macro
  ".plugin_pagetree", // children / page tree macros
  ".confluence-embedded-file-wrapper",
  ".expand-control-icon",
  ".aui-icon",
  ".confluence-information-macro-icon",
  ".hidden",
];

async function listAll<T>(ctx: ConnectorContext, apiOrigin: string, firstUrl: string): Promise<T[]> {
  const out: T[] = [];
  let url: string | undefined = firstUrl;
  let guard = 0;
  while (url && guard++ < 10_000) {
    const page: Paged<T> = await ctx.http.json<Paged<T>>(url);
    out.push(...(page.results ?? []));
    const next = page._links?.next;
    url = next ? (next.startsWith("http") ? next : `${apiOrigin}${next}`) : undefined;
  }
  return out;
}

/**
 * Space types are global | collaboration | knowledge_base | personal. Team spaces (e.g. CTO, TeamCore)
 * are "collaboration", so we never filter by type server-side; only personal spaces are opt-in.
 */
export function selectSpaces(spaces: V2Space[], include: string[], exclude: string[], includePersonal: boolean): V2Space[] {
  const inc = new Set(include.map((k) => k.toLowerCase()));
  const exc = new Set(exclude.map((k) => k.toLowerCase()));
  return spaces.filter((s) => {
    if (s.status && s.status !== "current") return false;
    if (!includePersonal && (s.type === "personal" || s.key.startsWith("~"))) return false;
    const key = s.key.toLowerCase();
    if (exc.has(key)) return false;
    return inc.size === 0 || inc.has(key);
  });
}

function breadcrumbOf(page: V2Content, titles: Map<string, V2Content>, spaceName: string): string {
  const chain: string[] = [];
  let cur: V2Content | undefined = page.parentId ? titles.get(page.parentId) : undefined;
  let guard = 0;
  while (cur && guard++ < 25) {
    chain.unshift(cur.title);
    cur = cur.parentId ? titles.get(cur.parentId) : undefined;
  }
  return [spaceName, ...chain].join(" > ");
}

export const syncConfluence: Connector = async function* (ctx): AsyncGenerator<SyncEvent> {
  const cfg = ctx.sources.confluence;
  const { apiOrigin, siteUrl, mode } = await resolveConfluenceApi(ctx.http, ctx.baseUrl, ctx.settings?.["cloudId"] || undefined);
  const base = apiOrigin;
  ctx.log(`Confluence: using ${mode === "gateway" ? `api.atlassian.com gateway (scoped token)` : "site URL"}`);

  const spaces = await listAll<V2Space>(ctx, apiOrigin, `${base}/wiki/api/v2/spaces?limit=250&status=current`);
  const selected = selectSpaces(spaces, cfg.spaces.include, cfg.spaces.exclude, cfg.include_personal_spaces);
  const byType = selected.reduce<Record<string, number>>((acc, s) => ((acc[s.type] = (acc[s.type] ?? 0) + 1), acc), {});
  ctx.log(`Confluence: ${selected.length}/${spaces.length} spaces selected (${Object.entries(byType).map(([t, n]) => `${t}=${n}`).join(", ")})`);

  const kinds: ("pages" | "blogposts")[] = cfg.include_blogposts ? ["pages", "blogposts"] : ["pages"];

  for (const space of selected) {
    for (const kind of kinds) {
      let items: V2Content[];
      try {
        items = await listAll<V2Content>(ctx, apiOrigin, `${base}/wiki/api/v2/spaces/${space.id}/${kind}?limit=250&status=current`);
      } catch (err) {
        yield { type: "error", message: `space ${space.key} (${kind}): ${(err as Error).message}` };
        continue;
      }
      const byId = new Map(items.map((p) => [p.id, p]));
      ctx.log(`  ${space.key}: ${items.length} ${kind}`);

      const events = await mapLimit(items, ctx.concurrency, async (p): Promise<SyncEvent | null> => {
        const sourceId = `confluence:${space.key}:${p.id}`;
        const prev = ctx.previous.items[sourceId];
        if (ctx.only && !sourceId.includes(ctx.only) && !p.title.toLowerCase().includes(ctx.only.toLowerCase())) {
          return prev ? { type: "unchanged", sourceId } : null;
        }
        const version = p.version?.number ?? 0;
        const fingerprint = `v${version}`;
        if (prev && prev.fingerprint === fingerprint) return { type: "unchanged", sourceId };

        try {
          const singular = kind === "pages" ? "pages" : "blogposts";
          const full = await ctx.http.json<V2Content>(`${base}/wiki/api/v2/${singular}/${p.id}?body-format=export_view`);
          const html = full.body?.export_view?.value ?? "";
          const md = htmlToMarkdown(html, { baseUrl: `${siteUrl}/wiki/`, removeSelectors: CONFLUENCE_REMOVE });
          if (md.length < cfg.min_body_chars) return { type: "skip", sourceId, reason: `stub (${md.length} chars)` };

          const webui = full._links?.webui ?? p._links?.webui;
          const sourceUrl = webui ? `${siteUrl}/wiki${webui}` : `${siteUrl}/wiki/spaces/${space.key}/pages/${p.id}`;
          const title = (full.title ?? p.title).trim() || `Page ${p.id}`;
          return {
            type: "doc",
            doc: {
              sourceId,
              sourceType: "confluence",
              relPath: `confluence/${space.key}/${p.id}-${slugify(title)}.md`,
              title,
              sourceUrl,
              lang: detectLang(md),
              lastModified: full.version?.createdAt?.slice(0, 10) ?? p.version?.createdAt?.slice(0, 10) ?? null,
              body: md,
              fingerprint: `v${full.version?.number ?? version}`,
              extra: {
                space_key: space.key,
                space_name: space.name,
                space_type: space.type,
                page_id: p.id,
                parent_id: p.parentId ?? undefined,
                breadcrumb: breadcrumbOf(p, byId, space.name),
                content_kind: kind === "pages" ? "page" : "blogpost",
                version: full.version?.number ?? version,
              },
            },
          };
        } catch (err) {
          return { type: "error", sourceId, message: (err as Error).message };
        }
      });

      for (const ev of events) if (ev) yield ev;
    }
  }
};
