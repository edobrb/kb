import YAML from "yaml";
import type { SyncDoc } from "./types.js";

/** File-name safe slug, ASCII only, max `max` chars. */
export function slugify(s: string, max = 80): string {
  const slug = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "untitled";
}

/** Title from the first ATX H1, if any. */
export function firstHeading(md: string): string | null {
  const m = /^#\s+(.+?)\s*#*\s*$/m.exec(md);
  return m?.[1] ? m[1].replace(/[*_`]/g, "").trim() || null : null;
}

/** Ensure the body starts with `# title` (the chunker uses it as the breadcrumb root). */
export function ensureTitleHeading(body: string, title: string): string {
  const trimmed = body.trim();
  // Skip leading HTML comments (e.g. <!-- confluence-page-id: … -->) and blank lines before looking for the H1.
  const lead = trimmed.replace(/^(\s*<!--[\s\S]*?-->\s*)+/, "").trimStart();
  const firstLine = lead.split("\n", 1)[0] ?? "";
  if (/^#\s+/.test(firstLine)) return trimmed;
  return `# ${title}\n\n${trimmed}`;
}

/** Render frontmatter + body exactly as `src/ingest/loader.ts` expects it. */
export function renderKbDocument(doc: SyncDoc, fetchedAt: string): string {
  const fm: Record<string, unknown> = {
    source_id: doc.sourceId,
    source_type: doc.sourceType,
    kind: doc.kind ?? "doc",
    title: doc.title,
    source_url: doc.sourceUrl ?? undefined,
    authority: doc.authority ?? "descriptive",
    lang: doc.lang ?? "und",
    last_modified: doc.lastModified ?? undefined,
    fetched_at: fetchedAt,
    fingerprint: doc.fingerprint,
  };
  for (const [k, v] of Object.entries(doc.extra)) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    if (!(k in fm)) fm[k] = v;
  }
  for (const k of Object.keys(fm)) if (fm[k] === undefined) delete fm[k];
  const yaml = YAML.stringify(fm, { lineWidth: 0, defaultStringType: "PLAIN", defaultKeyType: "PLAIN" }).trimEnd();
  return `---\n${yaml}\n---\n\n${ensureTitleHeading(doc.body, doc.title)}\n`;
}
