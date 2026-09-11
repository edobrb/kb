import { deflateRawSync } from "node:zlib";
import { config } from "../config.js";
import { DocumentNotFoundError, type DocumentStore, type FetchedDocument } from "../retrieval/documents.js";
import type { Citation } from "../types.js";

/**
 * Knowledge bundles: one answer packaged with the *full text* of every document behind it.
 *
 * `Export .md` gives a reader the answer and links back to Confluence / the Dev Portal / GitLab —
 * which is useless to an external model that cannot open those links, and to anyone offline. A
 * bundle instead carries the sources themselves: the answer, and each cited document's markdown as
 * a file, so the whole thing can be dropped into another assistant ("explain this further") or
 * archived as what the answer was actually based on.
 *
 * The zip is written here rather than with a dependency: store/deflate entries are ~80 lines and
 * the project keeps its dependency list short on purpose.
 */

// ---- zip container -----------------------------------------------------------

export interface ZipEntry {
  /** Path inside the archive, "/" separated. */
  name: string;
  data: Buffer | string;
}

let crcTable: Int32Array | null = null;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c;
    }
  }
  let crc = -1;
  for (const byte of buf) crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] as number);
  return (crc ^ -1) >>> 0;
}

/** MS-DOS date/time pair the zip headers carry (2-second resolution, epoch 1980). */
function dosStamp(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * A zip archive of `entries`, deflated (or stored, when deflating a file would make it bigger).
 * Single-disk, no zip64: bundles are megabytes of markdown, nowhere near the 4 GB limits.
 */
export function zip(entries: ZipEntry[], now = new Date()): Buffer {
  const { time, date } = dosStamp(now);
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const deflated = raw.length ? deflateRawSync(raw, { level: 9 }) : Buffer.alloc(0);
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // no extra field
    locals.push(local, name, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30); // extra
    dir.writeUInt16LE(0, 32); // comment
    dir.writeUInt16LE(0, 34); // disk
    dir.writeUInt16LE(0, 36); // internal attrs
    dir.writeUInt32LE((0o100644 << 16) >>> 0, 38); // unix mode, so unzip keeps it readable
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);

    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with the directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16); // where the central directory starts
  end.writeUInt16LE(0, 20); // comment length
  return Buffer.concat([...locals, directory, end]);
}

// ---- bundle ------------------------------------------------------------------

export interface BundleRequest {
  question: string;
  answer: string;
  /** Included as a separate file when present, never mixed into the answer. */
  thinking?: string;
  citations: Citation[];
  /** The `[n]` the answer actually used; the rest travel as "retrieved but not cited". */
  usedCitations?: number[];
  /** Per-document character cap. Defaults to BUNDLE_MAX_CHARS — whole pages, not a model's budget. */
  maxChars?: number;
  /** Documents the bundle may carry. Defaults to BUNDLE_MAX_DOCS. */
  maxDocs?: number;
}

/** One document in the bundle: the file that carries it and the passages that pointed at it. */
export interface BundledDoc {
  file: string;
  sourceId: string;
  title: string;
  sourceUrl: string | null;
  sourceType: string;
  kind: string;
  authority: string;
  relPath: string;
  lastModified: string | null;
  chars: number;
  truncated: boolean;
  /** Citation numbers, cited-by-the-answer ones marked. */
  citations: { n: number; cited: boolean; headingPath: string; lineStart: number | null; lineEnd: number | null }[];
}

export interface Bundle {
  filename: string;
  zip: Buffer;
  /** What went in, for the API response headers and the server log. */
  report: { documents: number; missing: string[]; skipped: number; bytes: number };
}

export function slug(s: string, max = 60): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, max)
      .replace(/-$/, "") || "untitled"
  );
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** YAML-safe double-quoted scalar (titles carry colons, quotes and the odd emoji). */
function yamlString(v: string | null): string {
  if (v === null) return "null";
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * One source document as a file: our own frontmatter (the loader strips the kb one, and an external
 * reader needs to know where this text came from and how binding it is), the passages that were
 * retrieved from it, then the whole markdown body.
 */
function sourceFile(doc: FetchedDocument, entry: BundledDoc): string {
  const front = [
    "---",
    `title: ${yamlString(doc.title)}`,
    `source_id: ${yamlString(doc.sourceId)}`,
    `source_url: ${yamlString(doc.sourceUrl)}`,
    `source_type: ${yamlString(doc.sourceType)}`,
    `kind: ${yamlString(doc.kind)}`,
    `authority: ${yamlString(doc.authority)}`,
    `lang: ${yamlString(doc.lang)}`,
    `last_modified: ${yamlString(doc.lastModified)}`,
    `kb_path: ${yamlString(doc.relPath)}`,
    `citations: [${entry.citations.map((c) => c.n).join(", ")}]`,
    `truncated: ${doc.truncated}`,
    "---",
    "",
  ];
  const passages = entry.citations
    .map((c) => `- [${c.n}]${c.cited ? " (cited)" : ""} ${c.headingPath || "—"}${c.lineStart ? ` · L${c.lineStart}-${c.lineEnd}` : ""}`)
    .join("\n");
  const head = [`<!-- Retrieved passages from this document:`, passages, `-->`, ""].join("\n");
  const tail = doc.truncated
    ? ["", "---", `_Truncated at ${doc.returnedChars.toLocaleString("en-US")} of ${doc.totalChars.toLocaleString("en-US")} characters._`, ""]
    : [];
  return front.join("\n") + head + "\n" + doc.content.trim() + "\n" + tail.join("\n");
}

/** The bundle's entry point: what was asked, what was answered, and which file holds which source. */
function readme(req: BundleRequest, docs: BundledDoc[], missing: string[], generatedAt: Date): string {
  const usedSet = new Set(req.usedCitations?.length ? req.usedCitations : req.citations.map((c) => c.n));
  const row = (d: BundledDoc) => {
    const ns = d.citations.map((c) => `[${c.n}]`).join(" ");
    const cited = d.citations.some((c) => c.cited);
    return [
      `- ${ns} **${d.title}** — \`${d.file}\``,
      `  ${d.sourceUrl ? `<${d.sourceUrl}>` : d.relPath}`,
      `  \`${d.sourceType}\`${d.kind && d.kind !== "doc" ? ` \`${d.kind}\`` : ""} \`${d.authority}\`` +
        (d.lastModified ? ` · updated ${d.lastModified.slice(0, 10)}` : "") +
        (cited ? "" : " · retrieved but not cited") +
        (d.truncated ? " · truncated" : ""),
    ].join("  \n");
  };
  const cited = docs.filter((d) => d.citations.some((c) => c.cited));
  const rest = docs.filter((d) => !d.citations.some((c) => c.cited));

  const out = [
    `# ${req.question.trim() || "ai-wiki answer"}`,
    "",
    "> Knowledge bundle exported from the ai-wiki assistant: the answer below, plus the **full text**",
    `> of every source it drew on under \`sources/\`. The \`[n]\` markers in the answer match the numbers`,
    "> in the source list and in each file's frontmatter.",
    "",
    "## Answer",
    "",
    req.answer.trim() || "_(no answer)_",
    "",
    "## Sources in this bundle",
    "",
  ];
  out.push(cited.length ? cited.map(row).join("\n") : "_No source was cited._");
  if (rest.length) out.push("", "### Retrieved but not cited", "", rest.map(row).join("\n"));
  if (missing.length) {
    out.push("", "### Not available", "", ...missing.map((id) => `- \`${id}\` — no longer in the knowledge base`));
  }
  const passages = req.citations.length;
  out.push(
    "",
    "## Contents",
    "",
    "| File | What it is |",
    "|---|---|",
    "| `README.md` | This file: question, answer, source index |",
    `| \`sources/\` | ${docs.length} document${docs.length === 1 ? "" : "s"}, full markdown, one file each |`,
    "| `manifest.json` | The same index machine-readable, with the retrieved passages and scores |",
    ...(req.thinking?.trim() ? ["| `reasoning.md` | The model's reasoning for this answer |"] : []),
    "",
    "---",
    `${passages} passage${passages === 1 ? "" : "s"} · ${docs.length} document${docs.length === 1 ? "" : "s"} · ` +
      `${usedSet.size} cited · generated by ai-wiki ${generatedAt.toISOString().slice(0, 16).replace("T", " ")}`,
    "",
  );
  return out.join("\n");
}

/**
 * Package one answer and the whole of every document behind it.
 *
 * Passages are grouped by document — twenty chunks routinely come from five pages — and each page
 * is re-read from `kb/` at export time, so the bundle carries the current text rather than the
 * 240-character excerpts the browser kept. Documents that have since left the knowledge base are
 * reported in `missing` instead of failing the export.
 */
export async function buildBundle(req: BundleRequest, store: DocumentStore, now = new Date()): Promise<Bundle> {
  const usedSet = new Set(req.usedCitations?.length ? req.usedCitations : req.citations.map((c) => c.n));
  const maxChars = Math.max(1000, req.maxChars ?? config.bundle.maxChars);
  const maxDocs = Math.max(1, req.maxDocs ?? config.bundle.maxDocs);

  // Group by document, keeping the order of first appearance: [1] is the first file in sources/.
  const groups = new Map<string, Citation[]>();
  for (const c of req.citations) {
    const key = c.sourceId || c.relPath || c.title;
    if (!key) continue;
    const at = groups.get(key);
    if (at) at.push(c);
    else groups.set(key, [c]);
  }
  const ordered = [...groups.entries()].sort((a, b) => Math.min(...a[1].map((c) => c.n)) - Math.min(...b[1].map((c) => c.n)));
  const skipped = Math.max(0, ordered.length - maxDocs);

  const entries: ZipEntry[] = [];
  const docs: BundledDoc[] = [];
  const missing: string[] = [];

  for (const [key, cites] of ordered.slice(0, maxDocs)) {
    let doc: FetchedDocument;
    try {
      doc = await store.fetch(key, { maxChars });
    } catch (err) {
      if (err instanceof DocumentNotFoundError) {
        missing.push(key);
        continue;
      }
      throw err;
    }
    const byN = [...cites].sort((a, b) => a.n - b.n);
    const entry: BundledDoc = {
      file: `sources/${pad2(docs.length + 1)}-${slug(doc.title || doc.sourceId, 48)}.md`,
      sourceId: doc.sourceId,
      title: doc.title,
      sourceUrl: doc.sourceUrl,
      sourceType: doc.sourceType,
      kind: doc.kind,
      authority: doc.authority,
      relPath: doc.relPath,
      lastModified: doc.lastModified,
      chars: doc.returnedChars,
      truncated: doc.truncated,
      citations: byN.map((c) => ({
        n: c.n,
        cited: usedSet.has(c.n),
        headingPath: c.headingPath,
        lineStart: c.lineStart ?? null,
        lineEnd: c.lineEnd ?? null,
      })),
    };
    docs.push(entry);
    entries.push({ name: entry.file, data: sourceFile(doc, entry) });
  }

  const manifest = {
    version: 1,
    generatedAt: now.toISOString(),
    question: req.question,
    answer: req.answer,
    usedCitations: [...usedSet].sort((a, b) => a - b),
    documents: docs,
    missing,
    skipped,
    passages: req.citations.map((c) => ({
      n: c.n,
      sourceId: c.sourceId,
      chunkId: c.chunkId,
      title: c.title,
      headingPath: c.headingPath,
      sourceUrl: c.sourceUrl,
      lineStart: c.lineStart ?? null,
      lineEnd: c.lineEnd ?? null,
      score: c.score ?? null,
      cited: usedSet.has(c.n),
      file: docs.find((d) => d.citations.some((x) => x.n === c.n))?.file ?? null,
      excerpt: c.excerpt ?? "",
    })),
  };

  // README first so a viewer that lists the archive shows it at the top.
  entries.unshift({ name: "README.md", data: readme(req, docs, missing, now) });
  entries.push({ name: "manifest.json", data: JSON.stringify(manifest, null, 2) + "\n" });
  if (req.thinking?.trim()) {
    entries.push({ name: "reasoning.md", data: `# Reasoning\n\n_Model's thinking for: ${req.question.trim()}_\n\n${req.thinking.trim()}\n` });
  }

  const archive = zip(entries, now);
  return {
    filename: `ai-wiki-${slug(req.question)}.zip`,
    zip: archive,
    report: { documents: docs.length, missing, skipped, bytes: archive.length },
  };
}
