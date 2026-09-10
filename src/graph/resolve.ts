import path from "node:path";
import { config } from "../config.js";

/**
 * Reverse-mapping of a link into a `source_id`.
 *
 * Sync writes ids from the URL it fetched a document from, so the mapping back is deterministic:
 * `…/wiki/spaces/CTO/pages/1037566023/Slug` is `confluence:CTO:1037566023`, `…/-/blob/main/docs/a.md`
 * in `oneplatform/adrs` is `gitlab:oneplatform/adrs:docs/a.md`, `/docs/default/module/x/page/` is
 * `devportal:default/module/x/page/`. A target that is not in the index is dropped rather than
 * guessed at, which is what keeps every edge pointing at something the model can actually fetch.
 */

/** Why a link did not become an edge. `internal` reasons are dangling references worth reporting. */
export const RESOLUTION_REASONS: Record<string, { internal: boolean; what: string }> = {
  external: { internal: false, what: "points outside the indexed systems" },
  unparsable: { internal: false, what: "not a URL" },
  "devportal-page": { internal: true, what: "Dev Portal page that is not indexed (renamed, or filtered out)" },
  "devportal-other": { internal: false, what: "Dev Portal URL that is not a TechDocs page" },
  "confluence-page": { internal: true, what: "Confluence page that is not indexed (excluded tree, or another space)" },
  "confluence-tiny": { internal: false, what: "Confluence tiny link (/wiki/x/…), which carries no page id" },
  "confluence-other": { internal: false, what: "Confluence URL that is not a page" },
  "gitlab-file": { internal: true, what: "file in an indexed repository that is not itself indexed" },
  "gitlab-repo": { internal: false, what: "repository outside the sync scope" },
  "gitlab-other": { internal: false, what: "GitLab URL that is not a file or a repository root" },
  "relative-target": { internal: true, what: "relative link whose target is not indexed" },
  "relative-outside": { internal: true, what: "relative link that climbs out of its repository" },
  "relative-unsupported": { internal: false, what: "relative link in a source type with no path to resolve against" },
};

export type Resolution = { id: string } | { reason: string };

const isId = (r: Resolution): r is { id: string } => "id" in r;
export { isId as isResolved };

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/** Lowercase key for a Dev Portal id, so a link that differs only in case still resolves. */
const portalKey = (idOrPath: string): string => idOrPath.replace(/^devportal:/, "").replace(/\/+$/, "").toLowerCase();

export class LinkResolver {
  private readonly byConfluencePage = new Map<string, string>();
  private readonly byPortalPath = new Map<string, string>();
  private readonly byGitlabFile = new Map<string, string>();
  private readonly gitlabProjects = new Set<string>();
  private readonly ids: Set<string>;

  readonly devportalHost: string;
  readonly gitlabHost: string;
  readonly confluenceHost: string;

  constructor(indexedIds: Iterable<string>, hosts?: { devportal?: string; gitlab?: string; confluence?: string }) {
    this.devportalHost = hosts?.devportal ?? hostOf(config.sync.devportal.baseUrl);
    this.gitlabHost = hosts?.gitlab ?? hostOf(config.sync.gitlab.baseUrl);
    this.confluenceHost = hosts?.confluence ?? hostOf(config.sync.confluence.baseUrl);

    this.ids = new Set(indexedIds);
    for (const id of this.ids) {
      if (id.startsWith("confluence:")) {
        const pageId = id.split(":")[2];
        if (pageId) this.byConfluencePage.set(pageId, id);
      } else if (id.startsWith("devportal:")) {
        this.byPortalPath.set(portalKey(id), id);
      } else if (id.startsWith("gitlab:")) {
        const rest = id.slice("gitlab:".length);
        const cut = rest.lastIndexOf(":");
        if (cut <= 0) continue;
        const project = rest.slice(0, cut);
        const file = rest.slice(cut + 1);
        this.gitlabProjects.add(project.toLowerCase());
        this.byGitlabFile.set(`${project}:${file}`.toLowerCase(), id);
      }
    }
  }

  get size(): number {
    return this.ids.size;
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  /** `gitlab:<project>:__project` when that repository has a project card. */
  projectCard(project: string): string | null {
    const id = `gitlab:${project}:__project`;
    return this.ids.has(id) ? id : null;
  }

  confluencePage(pageId: string): string | null {
    return this.byConfluencePage.get(pageId) ?? null;
  }

  /** Resolve one href found in the body of `self` (a `source_id`). */
  resolve(href: string, self: string): Resolution {
    const raw = href.trim().replace(/^<|>$/g, "");
    if (!raw || /^(#|mailto:|tel:|data:|javascript:)/i.test(raw)) return { reason: "unparsable" };
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return this.resolveUrl(raw);
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return { reason: "unparsable" };
    return this.resolveRelative(raw, self);
  }

  resolveUrl(url: string): Resolution {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { reason: "unparsable" };
    }
    const host = u.hostname.toLowerCase();
    let pathname: string;
    try {
      pathname = decodeURIComponent(u.pathname);
    } catch {
      pathname = u.pathname;
    }

    if (host === this.confluenceHost || host.endsWith(".atlassian.net")) return this.resolveConfluencePath(pathname);
    if (host === this.devportalHost) return this.resolvePortalPath(pathname);
    if (host === this.gitlabHost) return this.resolveGitlabPath(pathname);
    return { reason: "external" };
  }

  private resolveConfluencePath(pathname: string): Resolution {
    const m = /\/pages\/(\d+)/.exec(pathname);
    if (m?.[1]) {
      const id = this.byConfluencePage.get(m[1]);
      return id ? { id } : { reason: "confluence-page" };
    }
    if (/\/wiki\/x\//.test(pathname)) return { reason: "confluence-tiny" };
    return { reason: "confluence-other" };
  }

  private resolvePortalPath(pathname: string): Resolution {
    const m = /^\/docs\/(.+)$/.exec(pathname);
    if (!m?.[1]) return { reason: "devportal-other" };
    return this.lookupPortal(m[1]);
  }

  /** A TechDocs path (`default/module/x/page/`), with the `.md` and `index` forms of the same page. */
  lookupPortal(rawPath: string): Resolution {
    const candidates = [rawPath];
    const noExt = rawPath.replace(/\.(md|markdown)$/i, "");
    if (noExt !== rawPath) candidates.push(noExt);
    for (const c of [...candidates]) {
      const asIndex = c.replace(/\/?index$/i, "");
      if (asIndex !== c) candidates.push(asIndex);
    }
    for (const c of candidates) {
      const id = this.byPortalPath.get(portalKey(c));
      if (id) return { id };
    }
    return { reason: "devportal-page" };
  }

  private resolveGitlabPath(pathname: string): Resolution {
    const blob = /^\/(.+?)\/-\/(?:blob|raw)\/[^/]+\/(.*)$/.exec(pathname);
    if (blob?.[1] !== undefined && blob[2] !== undefined) {
      const project = blob[1];
      const file = blob[2].split("#")[0] ?? "";
      const id = this.gitlabFile(project, file);
      if (id) return { id };
      return { reason: this.gitlabProjects.has(project.toLowerCase()) ? "gitlab-file" : "gitlab-repo" };
    }
    // A tree URL is a directory, and `/-/issues`, `/-/merge_requests`… are not documents.
    if (/\/-\//.test(pathname)) {
      const project = pathname.replace(/^\/|\/$/g, "").split("/-/")[0] ?? "";
      return { reason: this.gitlabProjects.has(project.toLowerCase()) ? "gitlab-other" : "gitlab-repo" };
    }
    const project = pathname.replace(/^\/|\/$/g, "");
    if (!project) return { reason: "gitlab-other" };
    const card = this.projectCard(project) ?? this.projectCard(project.toLowerCase());
    if (card) return { id: card };
    return { reason: this.gitlabProjects.has(project.toLowerCase()) ? "gitlab-other" : "gitlab-repo" };
  }

  /** A portal path that did not resolve: an asset is not a dangling documentation reference. */
  private portalOrReason(p: string): Resolution {
    const hit = this.lookupPortal(p);
    if (isId(hit)) return hit;
    return { reason: /\.(png|jpe?g|gif|svg|webp|pdf|zip)$/i.test(p) ? "relative-unsupported" : "devportal-page" };
  }

  /** `oneplatform/adrs` + `Platform/ADR0010.md` -> the indexed id, trying the `.md` form too. */
  gitlabFile(project: string, file: string): string | null {
    const clean = file.replace(/^\.?\//, "");
    return (
      this.byGitlabFile.get(`${project}:${clean}`.toLowerCase()) ??
      this.byGitlabFile.get(`${project}:${clean}.md`.toLowerCase()) ??
      this.byGitlabFile.get(`${project}:${clean.replace(/\/$/, "")}/README.md`.toLowerCase()) ??
      null
    );
  }

  /**
   * A link written relative to the document that contains it. Repository documents resolve against
   * their path in the repository; Dev Portal pages against their URL path, which is how TechDocs
   * cross-links between pages of the same site (`../overview/`, `./setup.md`).
   */
  resolveRelative(href: string, self: string): Resolution {
    const target = href.split("#")[0]?.split("?")[0] ?? "";
    if (!target) return { reason: "unparsable" };

    if (self.startsWith("gitlab:")) {
      const rest = self.slice("gitlab:".length);
      const cut = rest.lastIndexOf(":");
      if (cut <= 0) return { reason: "relative-unsupported" };
      const project = rest.slice(0, cut);
      const from = rest.slice(cut + 1);
      const joined = target.startsWith("/")
        ? path.posix.normalize(target.slice(1))
        : path.posix.normalize(path.posix.join(path.posix.dirname(from), target));
      if (joined.startsWith("..")) return { reason: "relative-outside" };
      const id = this.gitlabFile(project, joined);
      if (id) return { id };
      // Only a markdown/spec target is a document we would have indexed; a link to an image or a
      // source file is not a dangling reference, it is just not part of the knowledge base.
      return { reason: /\.(md|markdown|ya?ml|json)$/i.test(joined) ? "relative-target" : "relative-unsupported" };
    }

    if (self.startsWith("devportal:")) {
      const base = self.slice("devportal:".length);
      if (target.startsWith("/")) {
        const abs = path.posix.normalize(target.replace(/^\/docs\//, "").replace(/^\//, ""));
        return this.portalOrReason(abs);
      }
      // The corpus mixes two spellings: hrefs from the rendered TechDocs HTML are relative to the
      // page's own URL (which ends in "/", so it behaves as a directory), while hrefs kept from the
      // markdown source are relative to the source file (one level up). Try both.
      const candidates = [path.posix.join(base, target), path.posix.join(path.posix.dirname(base.replace(/\/$/, "")), target)];
      for (const candidate of candidates) {
        const joined = path.posix.normalize(candidate);
        if (joined.startsWith("..")) continue;
        const hit = this.lookupPortal(joined);
        if (isId(hit)) return hit;
      }
      const joined = path.posix.normalize(candidates[0] as string);
      if (joined.startsWith("..")) return { reason: "relative-outside" };
      return this.portalOrReason(joined);
    }

    return { reason: "relative-unsupported" };
  }
}
