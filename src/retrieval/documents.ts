import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config, paths } from "../config.js";
import { estimateTokens } from "../ingest/chunker.js";
import { adrStatus, type AdrStatusInfo } from "../ingest/adr-status.js";
import { loadDocument } from "../ingest/loader.js";
import { headingText } from "../markdown.js";
import { readManifest } from "../ingest/manifest.js";

/**
 * Whole-document access on top of the chunk index.
 *
 * Retrieval returns ~450-token chunks, which is the right unit for ranking but often the wrong
 * unit for answering: a retry policy table, the rest of a numbered procedure or the next section
 * of an ADR sits just outside the chunk that matched. This store maps a source_id back to its
 * kb/*.md file so the model (via the `fetch_document` tool) or the UI can pull the whole page.
 */

export interface FetchedDocument {
  sourceId: string;
  title: string;
  sourceType: string;
  kind: string;
  authority: string;
  lang: string;
  sourceUrl: string | null;
  relPath: string;
  /** From the frontmatter, which the body does not carry — "is this still current?" needs it. */
  lastModified: string | null;
  /** Markdown actually returned: the whole body, one section, or a truncated head. */
  content: string;
  /** Heading outline of the *whole* document ("## Retry policy" -> "Retry policy"), for follow-up requests. */
  outline: string[];
  /** Heading of the section returned, when the request narrowed to one. */
  section: string | null;
  /** Set when a section was asked for but no heading matched, so the caller is not misled. */
  sectionNotFound: string | null;
  /** Other sections that matched the request as well as the one returned (a heading used twice). */
  sectionAlternatives: string[];
  /** Headings in the whole document; `outline` may list fewer. */
  outlineTotal: number;
  /** Character offset the returned content starts at, and where the next call should start (null: the end). */
  offset: number;
  nextOffset: number | null;
  /** Set when the stored copy itself is incomplete: sync kept `kept` of `total` characters. */
  cutAtSync: { kept: number; total: number } | null;
  /** What a decision record says about its own status ("Deprecated — as of 2025-06-01"), when it is one. */
  adrStatus: AdrStatusInfo | null;
  totalChars: number;
  returnedChars: number;
  tokenEstimate: number;
  truncated: boolean;
}

export class DocumentNotFoundError extends Error {
  constructor(public readonly requested: string, public readonly suggestions: string[]) {
    super(
      `No document with source_id "${requested}" in the knowledge base` +
        (suggestions.length ? `. Closest ids: ${suggestions.join(", ")}` : ""),
    );
    this.name = "DocumentNotFoundError";
  }
}

export interface FetchOptions {
  /** Only return this section (matched against the document's headings, case-insensitively). */
  section?: string | null;
  /** Character budget for the returned markdown. Defaults to DOC_TOOL_MAX_CHARS. */
  maxChars?: number;
  /** Start this many characters into the body (or the section): the way past a truncation without headings. */
  offset?: number;
}

/** Lowercase, alphanumeric-only form used for forgiving id/heading matching. */
function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

interface Heading {
  level: number;
  text: string;
  /** Index into the body's line array. */
  line: number;
}

/** ATX headings of a markdown body, ignoring anything inside fenced code blocks. */
export function outlineOf(lines: string[]): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  lines.forEach((line, i) => {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (f) {
      if (!fence) fence = f[1] as string;
      else if (line.trimStart().startsWith(fence)) fence = null;
      return;
    }
    if (fence) return;
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) out.push({ level: (h[1] as string).length, text: headingText(h[2] as string), line: i });
  });
  return out;
}

/** A heading with its ancestors, "Operations > GET /items", to tell apart two sections with the same name. */
function headingPathOf(headings: Heading[], h: Heading): string {
  const chain = [h.text];
  let level = h.level;
  for (let i = headings.indexOf(h) - 1; i >= 0 && level > 2; i--) {
    const p = headings[i] as Heading;
    if (p.level < level) {
      chain.unshift(p.text);
      level = p.level;
    }
  }
  return chain.join(" > ");
}

/** Headings in `pool` matching `want`, best tier first: exact, then contains, then contained. */
function matchHeadings(pool: Heading[], want: string): Heading[] {
  const tiers = [
    pool.filter((h) => normalize(h.text) === want),
    pool.filter((h) => normalize(h.text).includes(want)),
    pool.filter((h) => want.includes(normalize(h.text)) && normalize(h.text).length > 3),
  ];
  return tiers.find((t) => t.length) ?? [];
}

const sectionEnd = (lines: string[], headings: Heading[], h: Heading): number =>
  headings.find((n) => n.line > h.line && n.level <= h.level)?.line ?? lines.length;

/**
 * The lines of one section: from its heading down to the next heading of the same or a higher level.
 * `wanted` is a heading, or a path of them ("Ricerca delle gestite > Query Parameters") when the same
 * heading occurs under several parents. `alternatives` lists the other sections that matched as well.
 */
function sliceSection(
  lines: string[],
  headings: Heading[],
  wanted: string,
): { text: string; heading: string; alternatives: string[] } | null {
  const whole = normalize(wanted);
  if (!whole) return null;
  let matches: Heading[] = [];
  if (/[>›]/.test(wanted)) {
    // A path, parent first. A heading may itself contain ">" ("Business > VatConfiguration"), so the
    // whole string is the fallback when the path leads nowhere.
    let pool = headings;
    for (const part of wanted.split(/\s*[>›]\s*/).map(normalize).filter(Boolean)) {
      matches = matchHeadings(pool, part);
      const parent = matches[0];
      if (!parent) break;
      const end = sectionEnd(lines, headings, parent);
      pool = headings.filter((h) => h.line > parent.line && h.line < end);
    }
  }
  if (!matches.length) matches = matchHeadings(headings, whole);
  const found = matches[0];
  if (!found) return null;
  return {
    text: lines.slice(found.line, sectionEnd(lines, headings, found)).join("\n").trim(),
    heading: headingPathOf(headings, found),
    alternatives: matches.slice(1, 6).map((h) => headingPathOf(headings, h)),
  };
}

/** What a Dev Portal, Confluence or GitLab URL is called here, so a link copied from a page can be fetched. */
export function sourceIdFromUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const p = decodeURIComponent(u.pathname);
  const api = /\/catalog\/([^/]+)\/api\/([^/]+)\/definition\/?$/i.exec(p);
  if (api) return `devportal:${api[1]?.toLowerCase()}/api/${api[2]}#definition`;
  const docs = /\/docs\/([^/]+)\/([^/]+)\/([^/]+)(\/.*)?$/i.exec(p);
  if (docs) {
    const rest = (docs[4] ?? "/").replace(/\/?$/, "/");
    return `devportal:${docs[1]?.toLowerCase()}/${docs[2]?.toLowerCase()}/${docs[3]}${rest}`;
  }
  const wiki = /\/wiki\/spaces\/([^/]+)\/pages\/(\d+)/i.exec(p);
  if (wiki) return `confluence:${wiki[1]}:${wiki[2]}`;
  const blob = /^\/(.+?)\/-\/blob\/[^/]+\/(.+)$/.exec(p);
  if (blob) return `gitlab:${blob[1]}:${blob[2]}`;
  const repo = /^\/(.+?)(?:\/-\/(?:tree|blob)\/[^/]+\/?)?\/?$/.exec(p);
  if (repo && /gitlab|biosphere/i.test(u.hostname)) return `gitlab:${repo[1]}:__project`;
  return null;
}

/** Documents worth asking for an ADR status: the adrs repository, `adr` folders, "ADR<n>" titles. */
export function isAdrLike(sourceId: string, sourceType: string, title: string): boolean {
  return sourceType === "adr" || /(?:^|[/:_-])adrs?(?:[/_.-]|\d|$)/i.test(sourceId) || /\badr[- _]?\d/i.test(title);
}

/** The notice src/ingest/api-spec.ts puts in a definition sync cut: "keeps the first 200,000 of 424,986". */
const CUT_RE = /^> \*\*Cut at sync:\*\* this copy keeps the first ([\d,]+) of ([\d,]+) characters/m;

/** Cut at a line boundary so a truncated document never ends mid-sentence or inside a table row. */
function truncateAtLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const nl = cut.lastIndexOf("\n");
  return (nl > maxChars * 0.5 ? cut.slice(0, nl) : cut).trimEnd();
}

/** What the manifest says about one indexed document. */
export interface IndexedEntry {
  /** Path relative to the kb folder. */
  relPath: string;
  /** Hashes as of the last ingest (see DocMeta); null in a manifest that does not carry them. */
  contentHash: string | null;
  embedHash: string | null;
}

export class DocumentStore {
  private constructor(
    private readonly kbDir: string,
    private readonly byId: Map<string, IndexedEntry>,
    private readonly byNormalizedId: Map<string, string>,
  ) {}

  /**
   * Open the store from the ingest manifest (source_id -> relPath), which is written by
   * `npm run ingest` and therefore always agrees with what retrieval can cite.
   */
  static async open(manifestFile = paths.manifest, kbDir = config.kbDir): Promise<DocumentStore> {
    const manifest = await readManifest(manifestFile);
    const byId = new Map<string, IndexedEntry>();
    const byNormalizedId = new Map<string, string>();
    for (const entry of Object.values(manifest?.docs ?? {})) {
      byId.set(entry.sourceId, { relPath: entry.relPath, contentHash: entry.contentHash ?? null, embedHash: entry.embedHash ?? null });
      byNormalizedId.set(normalize(entry.sourceId), entry.sourceId);
      // A kb-relative path is a legitimate handle too (and what the UI has at hand), with or
      // without the .md extension.
      byNormalizedId.set(normalize(entry.relPath), entry.sourceId);
      byNormalizedId.set(normalize(entry.relPath.replace(/\.md$/i, "")), entry.sourceId);
    }
    return new DocumentStore(kbDir, byId, byNormalizedId);
  }

  get size(): number {
    return this.byId.size;
  }

  /** Resolve a possibly sloppy id (case, punctuation, or a kb path) to a real source_id. */
  resolve(requested: string): string | null {
    let raw = requested.trim();
    if (this.byId.has(raw)) return raw;
    if (/^https?:\/\//i.test(raw)) raw = sourceIdFromUrl(raw) ?? raw;
    if (this.byId.has(raw)) return raw;
    const n = normalize(raw);
    return this.byNormalizedId.get(n) ?? this.byNormalizedId.get(normalize(raw.replace(/\.md$/i, ""))) ?? null;
  }

  /** sha256 of the kb file as it is on disk now (manifest `contentHash` is the version indexed). */
  async fileHash(sourceId: string): Promise<string | null> {
    const entry = this.byId.get(sourceId);
    if (!entry) return null;
    try {
      const raw = await readFile(path.join(this.kbDir, entry.relPath));
      return `sha256:${createHash("sha256").update(raw).digest("hex")}`;
    } catch {
      return null;
    }
  }

  /** The manifest entry of a source_id exactly as `resolve` returns it. */
  entry(sourceId: string): IndexedEntry | null {
    return this.byId.get(sourceId) ?? null;
  }

  /** Ids that look like the requested one, to put in the error the model reads. */
  suggest(requested: string, limit = 5): string[] {
    const n = normalize(requested);
    if (n.length < 4) return [];
    const tail = n.slice(-24);
    return [...this.byId.keys()].filter((id) => normalize(id).includes(tail)).slice(0, limit);
  }

  private readonly statuses = new Map<string, Promise<AdrStatusInfo | null>>();

  /** The status line of an indexed decision record, read once per process (search shows it next to authority). */
  adrStatus(sourceId: string): Promise<AdrStatusInfo | null> {
    let hit = this.statuses.get(sourceId);
    if (!hit) {
      const entry = this.byId.get(sourceId);
      hit = entry
        ? loadDocument(this.kbDir, entry.relPath)
            .then((doc) => adrStatus(doc.body, doc.frontmatter["status"]))
            .catch(() => null)
        : Promise.resolve(null);
      this.statuses.set(sourceId, hit);
    }
    return hit;
  }

  async fetch(requested: string, opts: FetchOptions = {}): Promise<FetchedDocument> {
    const sourceId = this.resolve(requested);
    if (!sourceId) throw new DocumentNotFoundError(requested, this.suggest(requested));
    const { relPath } = this.byId.get(sourceId) as IndexedEntry;
    // The manifest is generated, but never trust a path from it (or from a tool call) blindly.
    const full = path.resolve(this.kbDir, relPath);
    if (!full.startsWith(path.resolve(this.kbDir) + path.sep)) {
      throw new DocumentNotFoundError(requested, []);
    }

    const doc = await loadDocument(this.kbDir, relPath);
    const lines = doc.body.split("\n");
    const headings = outlineOf(lines);
    const maxChars = Math.max(500, opts.maxChars ?? config.tools.docMaxChars);

    let content = doc.body;
    let section: string | null = null;
    let sectionAlternatives: string[] = [];
    if (opts.section) {
      const picked = sliceSection(lines, headings, opts.section);
      if (picked) {
        content = picked.text;
        section = picked.heading;
        sectionAlternatives = picked.alternatives;
      }
    }

    // Past a truncation: start at the beginning of the line the requested offset falls in.
    const wantedOffset = Math.max(0, Math.min(opts.offset ?? 0, content.length));
    const offset = wantedOffset > 0 && content[wantedOffset - 1] !== "\n" ? content.lastIndexOf("\n", wantedOffset - 1) + 1 : wantedOffset;
    const returned = truncateAtLine(content.slice(offset), maxChars);
    let end = offset + returned.length;
    while (end < content.length && /\s/.test(content[end] as string)) end++;

    // h2-h4 is the useful depth (h4 holds Confluence sub-steps); fall back to h2-h3 when that is too long a list.
    let outline = headings.filter((h) => h.level >= 2 && h.level <= 4);
    if (outline.length > 120) outline = outline.filter((h) => h.level <= 3);
    const cut = CUT_RE.exec(doc.body);
    return {
      sourceId,
      title: doc.meta.title,
      sourceType: doc.meta.sourceType,
      kind: doc.meta.kind,
      authority: doc.meta.authority,
      lang: doc.meta.lang,
      sourceUrl: doc.meta.sourceUrl,
      relPath,
      lastModified: doc.meta.lastModified,
      content: returned,
      outline: outline.map((h) => h.text),
      outlineTotal: headings.length,
      section,
      sectionNotFound: opts.section && !section ? opts.section : null,
      sectionAlternatives,
      offset,
      nextOffset: end < content.length ? end : null,
      adrStatus: isAdrLike(sourceId, doc.meta.sourceType, doc.meta.title) ? adrStatus(doc.body, doc.frontmatter["status"]) : null,
      cutAtSync: cut ? { kept: Number((cut[1] as string).replace(/,/g, "")), total: Number((cut[2] as string).replace(/,/g, "")) } : null,
      totalChars: content.length,
      returnedChars: returned.length,
      tokenEstimate: estimateTokens(returned),
      truncated: end < content.length,
    };
  }
}

let cached: Promise<DocumentStore> | null = null;
export function getDocumentStore(): Promise<DocumentStore> {
  if (!cached) cached = DocumentStore.open();
  return cached;
}

/** Drop the cached store so the next fetch sees a re-ingested manifest. */
export function resetDocumentStore(): void {
  cached = null;
}
