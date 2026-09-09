import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { htmlToMarkdown } from "./html.js";
import { HttpError, mapLimit } from "./http.js";
import { slugify } from "./kb-writer.js";
import { detectLang } from "./lang.js";
import type { EntitySummary } from "./project-card.js";
import { isStub, looksGenerated } from "./quality.js";
import { matchesAny, wildcardToRegExp } from "./sources-config.js";
import { previousIdsWithPrefix, type Connector, type ConnectorContext, type SyncEvent } from "./types.js";

/**
 * Developer Portal connector (Backstage + TechDocs).
 *
 * The portal is the source of truth: its catalog knows every documented component (including
 * repositories you cannot read on GitLab) and TechDocs already rendered the docs to HTML.
 * We list catalog entities that carry `backstage.io/techdocs-ref`, read the TechDocs metadata
 * (etag = build id) and download each HTML page only when the etag changed.
 *
 * Also emits `coveredRepos` (GitLab project paths behind those entities) so the GitLab connector can skip
 * the mkdocs content already rendered here, and `repoEntities` (owner, system, lifecycle, description per
 * repository) so the GitLab project cards can say who owns what.
 *
 * Not everything the portal renders is documentation: some entities publish generated API reference
 * (thousands of Swagger model pages, Sphinx module dumps). Those are dropped by `exclude_pages` globs on
 * `<kind>/<name>/<page path>` and by the generated-page heuristics in quality.ts, and pages without prose
 * (empty templates, link-only index pages) are skipped as stubs.
 */

interface Entity {
  kind: string;
  metadata: {
    name: string;
    namespace?: string;
    title?: string;
    description?: string;
    annotations?: Record<string, string>;
    tags?: string[];
  };
  spec?: Record<string, unknown>;
}

interface TechDocsMetadata {
  site_name?: string;
  site_description?: string;
  etag?: string;
  build_timestamp?: number;
  files?: string[];
}

interface SearchIndex {
  docs?: { location: string; title?: string }[];
}

const CONTENT_SELECTORS = ["article.md-content__inner", "article", '[role="main"]', ".md-content", "main"];
const REMOVE = [
  ".headerlink",
  ".md-source-file",
  ".md-content__button",
  ".md-feedback",
  ".md-sidebar",
  ".md-header",
  ".md-footer",
  ".md-search",
  ".md-nav",
  "nav",
  "footer",
  "header",
];

async function listEntities(ctx: ConnectorContext, filter: string): Promise<Entity[]> {
  const base = ctx.baseUrl;
  const out: Entity[] = [];
  // Newer Backstage: cursor-based /entities/by-query.
  try {
    let cursor: string | undefined;
    let guard = 0;
    do {
      const url = `${base}/api/catalog/entities/by-query?filter=${encodeURIComponent(filter)}&limit=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page = await ctx.http.json<{ items: Entity[]; pageInfo?: { nextCursor?: string } }>(url);
      out.push(...(page.items ?? []));
      cursor = page.pageInfo?.nextCursor;
    } while (cursor && guard++ < 1000);
    return out;
  } catch (err) {
    if (!(err instanceof HttpError && err.status === 404)) throw err;
  }
  // Older Backstage: offset-based /entities.
  for (let offset = 0, guard = 0; guard < 1000; guard++) {
    const url = `${base}/api/catalog/entities?filter=${encodeURIComponent(filter)}&limit=500&offset=${offset}`;
    const items = await ctx.http.json<Entity[]>(url);
    out.push(...items);
    if (items.length < 500) break;
    offset += items.length;
  }
  return out;
}

/**
 * "url:https://biosphere.teamsystem.com/grp/proj/-/tree/main/docs" -> "grp/proj" (lowercase).
 * Also accepts the legacy "…/grp/proj/blob/master/catalog-info.yml" form. Returns null for other hosts.
 */
export function gitlabProjectFromLocation(location: string | undefined, gitlabHost?: string): string | null {
  if (!location) return null;
  const raw = location.replace(/^url:/, "").trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (gitlabHost && u.host.toLowerCase() !== gitlabHost.toLowerCase()) return null;
  let p = u.pathname.replace(/^\/+/, "");
  const cut = /\/(?:-|blob|tree|raw|commits)(?:\/|$)/.exec(p);
  if (cut) p = p.slice(0, cut.index);
  p = p.replace(/\.git$/, "").replace(/\/+$/, "");
  return p && p.includes("/") ? p.toLowerCase() : null;
}

/** mkdocs `search_index.json` locations -> html files (use_directory_urls layout). */
export function pagesFromSearchIndex(index: SearchIndex): string[] {
  const files = new Set<string>();
  for (const d of index.docs ?? []) {
    const loc = (d.location ?? "").split("#")[0] ?? "";
    if (loc === "") files.add("index.html");
    else if (loc.endsWith("/")) files.add(`${loc}index.html`);
    else if (loc.endsWith(".html")) files.add(loc);
    else files.add(`${loc}/index.html`);
  }
  return [...files];
}

function isDocPage(file: string): boolean {
  return (
    file.endsWith(".html") &&
    !file.startsWith("assets/") &&
    !file.startsWith("search/") &&
    file !== "404.html" &&
    !file.endsWith("/404.html")
  );
}

/** TechDocs `build_timestamp` is documented in seconds but some publishers write milliseconds. */
export function buildDate(ts: number | undefined): string | null {
  if (!ts || !Number.isFinite(ts)) return null;
  const ms = ts > 1e12 ? ts : ts * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** "a/b/index.html" -> "a/b/", "index.html" -> "", "a/b.html" -> "a/b/". */
export function pagePathOf(file: string): string {
  if (file === "index.html") return "";
  if (file.endsWith("/index.html")) return file.slice(0, -"index.html".length);
  return `${file.replace(/\.html$/, "")}/`;
}

function entityRef(e: Entity): { ns: string; kind: string; name: string; ref: string } {
  const ns = (e.metadata.namespace ?? "default").toLowerCase();
  const kind = e.kind.toLowerCase();
  const name = e.metadata.name;
  return { ns, kind, name, ref: `${ns}/${kind}/${name}` };
}

export const syncDevPortal: Connector = async function* (ctx): AsyncGenerator<SyncEvent> {
  const cfg = ctx.sources.devportal;
  const base = ctx.baseUrl;
  const excludedEntity = entityExcluder(cfg.exclude_entities);
  const excludedPages = cfg.exclude_pages;
  const globCache = new Map<string, RegExp>();
  const coveredRepos = new Set<string>();
  const prevCovered = ctx.previous.meta["coveredRepos"];
  if (Array.isArray(prevCovered)) for (const r of prevCovered) if (typeof r === "string") coveredRepos.add(r);
  const repoEntities: Record<string, EntitySummary> = { ...((ctx.previous.meta["repoEntities"] ?? {}) as Record<string, EntitySummary>) };
  // Build id last seen per entity. Needed for entities that kept no page (every page a stub): they have no
  // items to compare against and would otherwise be re-downloaded and re-skipped on every run.
  const prevBuilds = (ctx.previous.meta["entityBuilds"] ?? {}) as Record<string, string>;
  const builds: Record<string, string> = {};

  // Part of every page fingerprint: a change to the page filters must re-evaluate entities whose TechDocs build did not move.
  const filterHash = createHash("sha1").update(JSON.stringify([cfg.exclude_pages, cfg.min_body_chars, cfg.min_prose_words, cfg.skip_generated])).digest("hex").slice(0, 8);

  const entities = await listEntities(ctx, "metadata.annotations.backstage.io/techdocs-ref");
  ctx.log(`Dev Portal: ${entities.length} entities with TechDocs`);

  let entityIndex = 0;
  for (const e of entities) {
    entityIndex++;
    const { ns, kind, name, ref } = entityRef(e);
    if (excludedEntity(kind, name, ref)) continue;
    const prefix = `devportal:${ref}/`;
    const ann = e.metadata.annotations ?? {};

    for (const key of ["backstage.io/source-location", "backstage.io/managed-by-location", "backstage.io/techdocs-ref"]) {
      const repo = gitlabProjectFromLocation(ann[key], ctx.settings?.["gitlabHost"] || undefined);
      if (!repo) continue;
      coveredRepos.add(repo);
      // Prefer the entity whose docs live in the repo (techdocs-ref) over catalog repos that merely register it.
      if (!repoEntities[repo] || key === "backstage.io/techdocs-ref") repoEntities[repo] = summarizeEntity(e, base);
    }

    if (ctx.only && !ref.includes(ctx.only)) {
      for (const id of previousIdsWithPrefix(ctx.previous, prefix)) yield { type: "unchanged", sourceId: id };
      if (prevBuilds[ref]) builds[ref] = prevBuilds[ref] as string;
      continue;
    }

    let meta: TechDocsMetadata;
    try {
      meta = await ctx.http.json<TechDocsMetadata>(`${base}/api/techdocs/metadata/techdocs/${ns}/${kind}/${encodeURIComponent(name)}`);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 0;
      yield { type: status === 404 ? "skip" : "error", sourceId: prefix, message: `TechDocs metadata: ${(err as Error).message}`, reason: "docs never built" } as SyncEvent;
      continue;
    }

    const build = String(meta.etag ?? meta.build_timestamp ?? "");
    const fingerprint = build ? `${build}|${filterHash}` : "";
    const prevIds = previousIdsWithPrefix(ctx.previous, prefix);
    const sameBuild = prevIds.length ? prevIds.every((id) => ctx.previous.items[id]?.fingerprint === fingerprint) : prevBuilds[ref] === fingerprint;
    if (fingerprint && sameBuild) {
      for (const id of prevIds) yield { type: "unchanged", sourceId: id };
      builds[ref] = fingerprint;
      continue;
    }
    if (fingerprint) builds[ref] = fingerprint;

    const staticBase = `${base}/api/techdocs/static/docs/${ns}/${kind}/${encodeURIComponent(name)}`;
    let files: string[];
    if (Array.isArray(meta.files) && meta.files.length) {
      files = meta.files.filter(isDocPage);
    } else {
      try {
        files = pagesFromSearchIndex(await ctx.http.json<SearchIndex>(`${staticBase}/search/search_index.json`));
      } catch (err) {
        yield { type: "error", sourceId: prefix, message: `cannot list pages: ${(err as Error).message}` };
        continue;
      }
    }
    ctx.log(`  [${entityIndex}/${entities.length}] ${ref}: ${files.length} pages`);

    const lastModified = buildDate(meta.build_timestamp);
    const spec = e.spec ?? {};
    const sourceLocation = ann["backstage.io/source-location"]?.replace(/^url:/, "");

    const entityTitle = e.metadata.title?.trim() || meta.site_name?.trim() || name;
    const pages = files.filter((file) => {
      const pagePath = pagePathOf(file);
      return !(excludedPages.length && matchesAny(`${kind}/${name}/${pagePath}`, excludedPages, globCache));
    });
    const excludedCount = files.length - pages.length;
    if (excludedCount) ctx.log(`    ${excludedCount} pages excluded by devportal.exclude_pages`);
    for (let i = 0; i < excludedCount; i++) yield { type: "skip", sourceId: prefix, reason: "excluded by devportal.exclude_pages" };

    const events = await mapLimit(pages, ctx.concurrency, async (file): Promise<SyncEvent | null> => {
      const pagePath = pagePathOf(file);
      const sourceId = `${prefix}${pagePath}`;
      const pageUrl = `${base}/docs/${ns}/${kind}/${name}/${pagePath}`;
      try {
        const html = await ctx.http.text(`${staticBase}/${file}`, { headers: { accept: "text/html" } });
        const $ = cheerio.load(html);
        const h1 = $("article h1").first().text().replace(/¶/g, "").trim();
        const docTitle = $("title").text().split(" - ")[0]?.trim() ?? "";
        const title = h1 || docTitle || meta.site_name || name;
        const editUrl = $('a[href*="/-/edit/"], a[href*="/-/blob/"], a.md-content__button[href]').first().attr("href");
        const md = htmlToMarkdown(html, { baseUrl: pageUrl, contentSelectors: CONTENT_SELECTORS, removeSelectors: REMOVE });
        if (md.length < cfg.min_body_chars) return { type: "skip", sourceId, reason: `stub (${md.length} chars)` };
        if (cfg.skip_generated && looksGenerated(title, md)) return { type: "skip", sourceId, reason: "generated reference page" };
        if (isStub(md, cfg.min_prose_words)) return { type: "skip", sourceId, reason: `stub (no prose)` };
        return {
          type: "doc",
          doc: {
            sourceId,
            sourceType: "devportal",
            relPath: `devportal/${kind}/${slugify(name)}/${pagePath ? slugify(pagePath.replace(/\/$/, "").replace(/\//g, "--"), 120) : "index"}.md`,
            title,
            sourceUrl: pageUrl,
            lang: detectLang(md),
            lastModified,
            body: md,
            fingerprint,
            extra: {
              breadcrumb: `Dev Portal › ${entityTitle}`,
              entity: ref,
              entity_kind: kind,
              entity_name: name,
              entity_title: e.metadata.title,
              entity_description: e.metadata.description,
              site_name: meta.site_name,
              owner: spec["owner"],
              system: spec["system"],
              lifecycle: spec["lifecycle"],
              component_type: spec["type"],
              tags: e.metadata.tags,
              source_location: sourceLocation,
              techdocs_ref: ann["backstage.io/techdocs-ref"]?.replace(/^url:/, ""),
              edit_url: editUrl,
            },
          },
        };
      } catch (err) {
        return { type: "error", sourceId, message: (err as Error).message };
      }
    });
    for (const ev of events) if (ev) yield ev;
  }

  if (cfg.include_api_definitions) {
    let apis: Entity[] = [];
    try {
      apis = await listEntities(ctx, "kind=api");
    } catch (err) {
      yield { type: "error", message: `API entities: ${(err as Error).message}` };
    }
    ctx.log(`Dev Portal: ${apis.length} API entities`);
    for (const e of apis) {
      const { ns, kind, name, ref } = entityRef(e);
      if (excludedEntity(kind, name, ref)) continue;
      const sourceId = `devportal:${ref}#definition`;
      if (ctx.only && !ref.includes(ctx.only)) {
        if (ctx.previous.items[sourceId]) yield { type: "unchanged", sourceId };
        continue;
      }
      const def = e.spec?.["definition"];
      if (typeof def !== "string" || !def.trim()) continue;
      const fingerprint = `sha256:${createHash("sha256").update(def).digest("hex").slice(0, 16)}`;
      if (ctx.previous.items[sourceId]?.fingerprint === fingerprint) {
        yield { type: "unchanged", sourceId };
        continue;
      }
      const title = `${e.metadata.title ?? name} (API definition)`;
      const description = e.metadata.description?.trim() ?? "";
      const apiType = typeof e.spec?.["type"] === "string" ? (e.spec["type"] as string) : "";
      const truncated = def.length > cfg.max_definition_chars;
      const lang = apiType === "openapi" || apiType === "asyncapi" ? "yaml" : apiType;
      const definition = truncated ? `${def.slice(0, cfg.max_definition_chars)}\n# … truncated (${def.length} chars)` : def.trimEnd();
      const body = [description, `API type: ${apiType || "unknown"}. Owner: ${String(e.spec?.["owner"] ?? "unknown")}.`, `\`\`\`${lang}\n${definition}\n\`\`\``]
        .filter(Boolean)
        .join("\n\n");
      yield {
        type: "doc",
        doc: {
          sourceId,
          sourceType: "devportal",
          kind: "api",
          relPath: `devportal/api/${slugify(name)}/__definition.md`,
          title,
          sourceUrl: `${base}/catalog/${ns}/api/${name}/definition`,
          lang: detectLang(description) === "it" ? "it" : "en",
          lastModified: null,
          body,
          fingerprint,
          extra: { breadcrumb: `Dev Portal › API › ${e.metadata.title ?? name}`, entity: ref, entity_kind: kind, entity_name: name, owner: e.spec?.["owner"], system: e.spec?.["system"], api_type: apiType, tags: e.metadata.tags },
        },
      };
    }
  }

  yield { type: "meta", key: "entityBuilds", value: builds };
  yield { type: "meta", key: "coveredRepos", value: [...coveredRepos].sort() };
  yield { type: "meta", key: "repoEntities", value: repoEntities };
  yield { type: "meta", key: "entities", value: entities.length };
};

/** `exclude_entities` accepts "kind/name" or "ns/kind/name", with wildcards, case-insensitive. */
export function entityExcluder(patterns: string[]): (kind: string, name: string, ref: string) => boolean {
  const res = patterns.map(wildcardToRegExp);
  return (kind, name, ref) => res.some((re) => re.test(`${kind}/${name}`) || re.test(ref));
}

function summarizeEntity(e: Entity, base: string): EntitySummary {
  const { ns, kind, name, ref } = entityRef(e);
  const spec = e.spec ?? {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  return {
    ref,
    kind,
    title: str(e.metadata.title),
    description: str(e.metadata.description),
    owner: str(spec["owner"]),
    system: str(spec["system"]),
    lifecycle: str(spec["lifecycle"]),
    type: str(spec["type"]),
    tags: Array.isArray(e.metadata.tags) && e.metadata.tags.length ? e.metadata.tags : undefined,
    url: `${base}/catalog/${ns}/${kind}/${name}`,
  };
}
