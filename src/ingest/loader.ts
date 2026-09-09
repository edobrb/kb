import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { DOC_KINDS, type Authority, type DocKind, type DocMeta, type Document } from "../types.js";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** Split a markdown file into YAML frontmatter (if any) and body. Never throws on bad YAML. */
export function parseFrontmatter(raw: string): ParsedMarkdown {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) return { frontmatter: {}, body: raw };
  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = YAML.parse(m[1] ?? "");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) frontmatter = parsed as Record<string, unknown>;
  } catch {
    // Malformed YAML: fall back to a lenient key: value scan so we still get title/source_id.
    for (const line of (m[1] ?? "").split(/\r?\n/)) {
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (kv) frontmatter[kv[1] as string] = (kv[2] ?? "").replace(/^"(.*)"$/, "$1");
    }
  }
  return { frontmatter, body: raw.slice(m[0].length) };
}

function asString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return null;
}

function normalizeAuthority(v: unknown): Authority {
  const s = asString(v)?.toLowerCase();
  if (s === "binding" || s === "normative" || s === "descriptive") return s;
  return "unknown";
}

function normalizeKind(v: unknown): DocKind {
  const s = asString(v)?.toLowerCase();
  return (DOC_KINDS as readonly string[]).includes(s ?? "") ? (s as DocKind) : "doc";
}

/** Derive a title from the first markdown H1, else from the filename. */
function fallbackTitle(body: string, relPath: string): string {
  const h1 = /^#\s+(.+)$/m.exec(body);
  if (h1?.[1]) return h1[1].replace(/[*_`]/g, "").trim();
  return path.basename(relPath, path.extname(relPath)).replace(/[-_]+/g, " ");
}

export function buildDocMeta(fm: Record<string, unknown>, body: string, relPath: string, raw: string): DocMeta {
  const topFolder = relPath.split(/[\\/]/)[0] ?? "kb";
  const sourceType = asString(fm["source_type"]) ?? (relPath.includes("/") || relPath.includes("\\") ? topFolder : "kb");
  const sourceId =
    asString(fm["source_id"]) ?? `${sourceType}:${relPath.replace(/\.md$/i, "").replace(/[\\/]/g, "-")}`;
  // Always hash the actual file bytes: the frontmatter body_hash is informative, but a manual
  // edit that forgets to update it must still be picked up by the incremental ingest.
  const contentHash = `sha256:${createHash("sha256").update(raw).digest("hex")}`;

  return {
    sourceId,
    sourceType,
    kind: normalizeKind(fm["kind"]),
    title: asString(fm["title"]) ?? fallbackTitle(body, relPath),
    sourceUrl: asString(fm["source_url"]),
    authority: normalizeAuthority(fm["authority"]),
    lang: asString(fm["lang"]) ?? "und",
    lastModified: asString(fm["last_modified"]) ?? asString(fm["fetched_at"]),
    contentHash,
    relPath,
  };
}

/** Recursively list markdown files under `dir`, returning paths relative to it. */
export async function listMarkdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const full = path.join(current, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) out.push(path.relative(dir, full));
    }
  }
  await walk(dir);
  return out.sort();
}

export async function loadDocument(kbDir: string, relPath: string): Promise<Document> {
  const raw = await readFile(path.join(kbDir, relPath), "utf8");
  const { frontmatter, body } = parseFrontmatter(raw);
  const meta = buildDocMeta(frontmatter, body, relPath.split(path.sep).join("/"), raw);
  return { meta, body: cleanBody(body, meta.kind), frontmatter };
}

/**
 * Remove noise that hurts embeddings but carries no meaning for readers. Source files are left alone
 * (an HTML comment or a run of blank lines is content there); prose gets HTML comments stripped and the
 * `\_` escapes that some exporters put in tables undone, so `subject_token` is one BM25 token everywhere.
 */
export function cleanBody(body: string, kind: DocKind = "doc"): string {
  const unix = body.replace(/\r\n/g, "\n");
  if (kind === "code") return unix.replace(/\n+$/, "").trim();
  return unix
    .replace(/<!--[\s\S]*?-->/g, "") // html comments (confluence-page-id etc.)
    .replace(/\\_/g, "_")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
