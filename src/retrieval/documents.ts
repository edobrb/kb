import path from "node:path";
import { config, paths } from "../config.js";
import { estimateTokens } from "../ingest/chunker.js";
import { loadDocument } from "../ingest/loader.js";
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
    if (h) out.push({ level: (h[1] as string).length, text: (h[2] as string).replace(/[*_`]/g, "").trim(), line: i });
  });
  return out;
}

/** The lines of one section: from its heading down to the next heading of the same or a higher level. */
function sliceSection(lines: string[], headings: Heading[], wanted: string): { text: string; heading: string } | null {
  const want = normalize(wanted);
  if (!want) return null;
  const found =
    headings.find((h) => normalize(h.text) === want) ??
    headings.find((h) => normalize(h.text).includes(want)) ??
    headings.find((h) => want.includes(normalize(h.text)) && normalize(h.text).length > 3);
  if (!found) return null;
  const next = headings.find((h) => h.line > found.line && h.level <= found.level);
  return { text: lines.slice(found.line, next ? next.line : lines.length).join("\n").trim(), heading: found.text };
}

/** Cut at a line boundary so a truncated document never ends mid-sentence or inside a table row. */
function truncateAtLine(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const nl = cut.lastIndexOf("\n");
  return (nl > maxChars * 0.5 ? cut.slice(0, nl) : cut).trimEnd();
}

export class DocumentStore {
  private constructor(
    private readonly kbDir: string,
    /** source_id -> path relative to kbDir. */
    private readonly byId: Map<string, string>,
    private readonly byNormalizedId: Map<string, string>,
  ) {}

  /**
   * Open the store from the ingest manifest (source_id -> relPath), which is written by
   * `npm run ingest` and therefore always agrees with what retrieval can cite.
   */
  static async open(manifestFile = paths.manifest, kbDir = config.kbDir): Promise<DocumentStore> {
    const manifest = await readManifest(manifestFile);
    const byId = new Map<string, string>();
    const byNormalizedId = new Map<string, string>();
    for (const entry of Object.values(manifest?.docs ?? {})) {
      byId.set(entry.sourceId, entry.relPath);
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
    const raw = requested.trim();
    if (this.byId.has(raw)) return raw;
    const n = normalize(raw);
    return this.byNormalizedId.get(n) ?? this.byNormalizedId.get(normalize(raw.replace(/\.md$/i, ""))) ?? null;
  }

  /** Ids that look like the requested one, to put in the error the model reads. */
  suggest(requested: string, limit = 5): string[] {
    const n = normalize(requested);
    if (n.length < 4) return [];
    const tail = n.slice(-24);
    return [...this.byId.keys()].filter((id) => normalize(id).includes(tail)).slice(0, limit);
  }

  async fetch(requested: string, opts: FetchOptions = {}): Promise<FetchedDocument> {
    const sourceId = this.resolve(requested);
    if (!sourceId) throw new DocumentNotFoundError(requested, this.suggest(requested));
    const relPath = this.byId.get(sourceId) as string;
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
    if (opts.section) {
      const picked = sliceSection(lines, headings, opts.section);
      if (picked) {
        content = picked.text;
        section = picked.heading;
      }
    }

    const returned = truncateAtLine(content, maxChars);
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
      outline: headings.filter((h) => h.level >= 2 && h.level <= 3).map((h) => h.text),
      section,
      sectionNotFound: opts.section && !section ? opts.section : null,
      totalChars: doc.body.length,
      returnedChars: returned.length,
      tokenEstimate: estimateTokens(returned),
      truncated: returned.length < content.length,
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
