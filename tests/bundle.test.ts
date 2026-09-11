import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";
import { beforeAll, describe, expect, it } from "vitest";
import { DocumentStore } from "../src/retrieval/documents.js";
import { buildBundle, slug, zip } from "../src/server/bundle.js";
import type { Citation } from "../src/types.js";

const page = (id: string, title: string, body: string) => `---
source_id: "${id}"
source_type: confluence
title: ${title}
authority: normative
source_url: "https://example.atlassian.net/wiki/${slug(title)}"
lang: en
last_modified: "2026-08-01T10:00:00.000Z"
---

# ${title}

${body}
`;

const TRANSFER = "confluence:TeamCore/transfer-flow";
const RETRY = "confluence:TeamCore/retry-policy";
const LONG = "confluence:TeamCore/long-page";

/** Read a zip back through its central directory: name -> uncompressed bytes. */
function unzip(archive: Buffer): Map<string, string> {
  const eocd = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThan(-1);
  const count = archive.readUInt16LE(eocd + 10);
  let at = archive.readUInt32LE(eocd + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(archive.readUInt32LE(at)).toBe(0x02014b50);
    const method = archive.readUInt16LE(at + 10);
    const csize = archive.readUInt32LE(at + 20);
    const usize = archive.readUInt32LE(at + 24);
    const nameLen = archive.readUInt16LE(at + 28);
    const extraLen = archive.readUInt16LE(at + 30);
    const commentLen = archive.readUInt16LE(at + 32);
    const offset = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLen).toString("utf8");

    expect(archive.readUInt32LE(offset)).toBe(0x04034b50);
    const localName = archive.readUInt16LE(offset + 26);
    const localExtra = archive.readUInt16LE(offset + 28);
    const start = offset + 30 + localName + localExtra;
    const body = archive.subarray(start, start + csize);
    const data = method === 8 ? inflateRawSync(body) : body;
    expect(data.length).toBe(usize);
    out.set(name, data.toString("utf8"));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const citation = (n: number, sourceId: string, over: Partial<Citation> = {}): Citation => ({
  n,
  chunkId: `${sourceId}#${n}`,
  sourceId,
  title: over.title ?? sourceId,
  sourceUrl: over.sourceUrl ?? null,
  sourceType: "confluence",
  kind: "doc",
  authority: "normative",
  headingPath: over.headingPath ?? "Some heading",
  relPath: over.relPath ?? "",
  excerpt: over.excerpt ?? "…excerpt…",
  lineStart: null,
  lineEnd: null,
  score: 0.5,
  ...over,
});

let store: DocumentStore;

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ai-wiki-bundle-"));
  const kbDir = path.join(root, "kb");
  await mkdir(path.join(kbDir, "confluence"), { recursive: true });
  await writeFile(path.join(kbDir, "confluence", "transfer-flow.md"), page(TRANSFER, "Transfer Flow", "Packages move to the new company.\n\n## Retry policy\n\nThree attempts."), "utf8");
  await writeFile(path.join(kbDir, "confluence", "retry-policy.md"), page(RETRY, "Retry Policy", "Waits are 1s, 5s and 25s."), "utf8");
  const long = Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1} of a page far past any sane character cap.`).join("\n\n");
  await writeFile(path.join(kbDir, "confluence", "long-page.md"), page(LONG, "Long Page", long), "utf8");
  const manifest = {
    version: 1,
    embeddingModel: "mock",
    embeddingDimensions: 8,
    chunking: { targetTokens: 450, maxTokens: 700, overlapTokens: 60 },
    docs: {
      [TRANSFER]: { sourceId: TRANSFER, relPath: "confluence/transfer-flow.md", contentHash: "sha256:a", chunkCount: 2, indexedAt: new Date().toISOString() },
      [RETRY]: { sourceId: RETRY, relPath: "confluence/retry-policy.md", contentHash: "sha256:b", chunkCount: 1, indexedAt: new Date().toISOString() },
      [LONG]: { sourceId: LONG, relPath: "confluence/long-page.md", contentHash: "sha256:c", chunkCount: 9, indexedAt: new Date().toISOString() },
    },
  };
  const manifestFile = path.join(root, "manifest.json");
  await writeFile(manifestFile, JSON.stringify(manifest), "utf8");
  store = await DocumentStore.open(manifestFile, kbDir);
});

describe("zip", () => {
  it("round-trips names and contents", () => {
    const text = "line\n".repeat(500);   // compressible: takes the deflate path
    const entries = unzip(zip([{ name: "a/b.md", data: text }, { name: "c.json", data: "{}\n" }]));
    expect([...entries.keys()]).toEqual(["a/b.md", "c.json"]);
    expect(entries.get("a/b.md")).toBe(text);
    expect(entries.get("c.json")).toBe("{}\n");
  });

  it("stores rather than deflates when compression would not help", () => {
    const archive = zip([{ name: "tiny.txt", data: "x" }]);
    // Method sits at offset 8 of the local header, which starts the file.
    expect(archive.readUInt16LE(8)).toBe(0);
    expect(unzip(archive).get("tiny.txt")).toBe("x");
  });

  it("keeps non-ASCII names readable", () => {
    expect([...unzip(zip([{ name: "sources/01-città.md", data: "ok" }])).keys()]).toEqual(["sources/01-città.md"]);
  });
});

describe("buildBundle", () => {
  it("packs the answer and the full text of every cited document", async () => {
    const citations = [
      citation(1, TRANSFER, { title: "Transfer Flow", headingPath: "Transfer Flow" }),
      citation(2, TRANSFER, { title: "Transfer Flow", headingPath: "Transfer Flow > Retry policy" }),
      citation(3, RETRY, { title: "Retry Policy" }),
    ];
    const bundle = await buildBundle(
      { question: "How does the transfer flow retry?", answer: "It retries three times [1][2].", citations, usedCitations: [1, 2] },
      store,
    );
    expect(bundle.filename).toBe("ai-wiki-how-does-the-transfer-flow-retry.zip");
    expect(bundle.report).toMatchObject({ documents: 2, missing: [], skipped: 0 });

    const files = unzip(bundle.zip);
    expect([...files.keys()]).toEqual(["README.md", "sources/01-transfer-flow.md", "sources/02-retry-policy.md", "manifest.json"]);

    const readme = files.get("README.md") as string;
    expect(readme).toContain("# How does the transfer flow retry?");
    expect(readme).toContain("It retries three times [1][2].");
    expect(readme).toContain("[1] [2] **Transfer Flow** — `sources/01-transfer-flow.md`");
    // [3] was retrieved but the answer never cited it: same bundle, listed apart.
    expect(readme).toContain("### Retrieved but not cited");
    expect(readme).toMatch(/### Retrieved but not cited[\s\S]*Retry Policy/);

    // The documents travel whole, not as the excerpts the browser kept.
    const first = files.get("sources/01-transfer-flow.md") as string;
    expect(first).toContain(`source_id: "${TRANSFER}"`);
    expect(first).toContain("citations: [1, 2]");
    expect(first).toContain("Packages move to the new company.");
    expect(first).toContain("Three attempts.");
    expect(first).not.toContain("…excerpt…");
    expect(files.get("sources/02-retry-policy.md")).toContain("1s, 5s and 25s");

    const manifest = JSON.parse(files.get("manifest.json") as string);
    expect(manifest.documents.map((d: { file: string }) => d.file)).toEqual(["sources/01-transfer-flow.md", "sources/02-retry-policy.md"]);
    expect(manifest.passages).toHaveLength(3);
    expect(manifest.passages[2]).toMatchObject({ n: 3, cited: false, file: "sources/02-retry-policy.md" });
    expect(manifest.usedCitations).toEqual([1, 2]);
  });

  it("reports a document that has left the knowledge base instead of failing", async () => {
    const bundle = await buildBundle(
      {
        question: "gone?",
        answer: "[1][2]",
        citations: [citation(1, TRANSFER, { title: "Transfer Flow" }), citation(2, "confluence:TeamCore/deleted-page")],
      },
      store,
    );
    expect(bundle.report.documents).toBe(1);
    expect(bundle.report.missing).toEqual(["confluence:TeamCore/deleted-page"]);
    const files = unzip(bundle.zip);
    expect(files.get("README.md")).toContain("no longer in the knowledge base");
    expect(JSON.parse(files.get("manifest.json") as string).missing).toEqual(["confluence:TeamCore/deleted-page"]);
  });

  it("adds the reasoning only when there is some, and marks truncation", async () => {
    const plain = await buildBundle({ question: "q", answer: "a", citations: [citation(1, RETRY)] }, store);
    expect([...unzip(plain.zip).keys()]).not.toContain("reasoning.md");

    const withThinking = await buildBundle(
      { question: "q", answer: "a", thinking: "First I checked the retry policy.", citations: [citation(1, RETRY)], maxChars: 1000 },
      store,
    );
    const files = unzip(withThinking.zip);
    expect(files.get("reasoning.md")).toContain("First I checked the retry policy.");
  });

  it("cuts a long document at the character cap and says so", async () => {
    const bundle = await buildBundle({ question: "q", answer: "a", citations: [citation(1, LONG, { title: "Long Page" })], maxChars: 1000 }, store);
    const doc = unzip(bundle.zip).get("sources/01-long-page.md") as string;
    expect(doc).toContain("truncated: true");
    expect(doc).toMatch(/_Truncated at [\d,]+ of [\d,]+ characters\._/);
    expect(doc).toContain("Paragraph 1 of a page");
    expect(doc).not.toContain("Paragraph 80 of a page");
  });
});
