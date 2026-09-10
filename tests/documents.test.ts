import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DocumentNotFoundError, DocumentStore, outlineOf } from "../src/retrieval/documents.js";

const PAGE = `---
source_id: "devportal:default/component/m3/core-features/transfer-flow/"
source_type: devportal
title: Transfer Flow
authority: descriptive
source_url: "https://development.teamsystem.com/transfer-flow"
lang: en
---

# Transfer Flow

Intro paragraph.

## Retry policy

Metering retries 3 times with 1s, 5s and 25s waits.

\`\`\`ts
// ### not a heading: it is inside a fence
const retries = 3;
\`\`\`

### Dead letter

After the third failure the action goes to the DLQ.

## Side effects

Packages are moved to the new company, the old company keeps its consumption history, and the
aggregator is notified so the readonly flag is recomputed on the next run. This paragraph is long
on purpose: it gives the truncation test something to cut, at a line boundary, well past the
500-character floor that fetch() enforces on the character budget.
`;

let kbDir: string;
let store: DocumentStore;

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ai-wiki-docs-"));
  kbDir = path.join(root, "kb");
  await mkdir(path.join(kbDir, "devportal"), { recursive: true });
  await writeFile(path.join(kbDir, "devportal", "transfer-flow.md"), PAGE, "utf8");
  const manifest = {
    version: 1,
    embeddingModel: "mock",
    embeddingDimensions: 8,
    chunking: { targetTokens: 450, maxTokens: 700, overlapTokens: 60 },
    docs: {
      "devportal:default/component/m3/core-features/transfer-flow/": {
        sourceId: "devportal:default/component/m3/core-features/transfer-flow/",
        relPath: "devportal/transfer-flow.md",
        contentHash: "sha256:x",
        chunkCount: 2,
        indexedAt: new Date().toISOString(),
      },
    },
  };
  const manifestFile = path.join(root, "manifest.json");
  await writeFile(manifestFile, JSON.stringify(manifest), "utf8");
  store = await DocumentStore.open(manifestFile, kbDir);
});

describe("outlineOf", () => {
  it("ignores headings inside fenced code", () => {
    const headings = outlineOf(PAGE.split("\n")).map((h) => h.text);
    expect(headings).toEqual(["Transfer Flow", "Retry policy", "Dead letter", "Side effects"]);
  });
});

describe("DocumentStore", () => {
  const id = "devportal:default/component/m3/core-features/transfer-flow/";

  it("returns the whole document with its outline, frontmatter stripped", async () => {
    const doc = await store.fetch(id);
    expect(doc.title).toBe("Transfer Flow");
    expect(doc.content).not.toContain("source_id:");
    expect(doc.content).toContain("Metering retries 3 times");
    expect(doc.outline).toEqual(["Retry policy", "Dead letter", "Side effects"]);
    expect(doc.truncated).toBe(false);
    expect(doc.section).toBeNull();
  });

  it("resolves sloppy ids and kb paths", async () => {
    expect(store.resolve(id.toUpperCase())).toBe(id);
    expect(store.resolve("devportal/transfer-flow.md")).toBe(id);
    expect(store.resolve("devportal/transfer-flow")).toBe(id);
    expect(store.resolve("no/such/thing")).toBeNull();
  });

  it("slices one section down to the next heading of the same level", async () => {
    const doc = await store.fetch(id, { section: "retry policy" });
    expect(doc.section).toBe("Retry policy");
    expect(doc.sectionNotFound).toBeNull();
    expect(doc.content).toContain("1s, 5s and 25s");
    expect(doc.content).toContain("Dead letter"); // nested H3 belongs to the section
    expect(doc.content).not.toContain("Side effects");
  });

  it("says when the requested section does not exist instead of pretending", async () => {
    const doc = await store.fetch(id, { section: "Pricing" });
    expect(doc.section).toBeNull();
    expect(doc.sectionNotFound).toBe("Pricing");
    expect(doc.content).toContain("Intro paragraph");
  });

  it("truncates at a line boundary and reports it", async () => {
    const doc = await store.fetch(id, { maxChars: 600 });
    expect(doc.truncated).toBe(true);
    expect(doc.returnedChars).toBeLessThanOrEqual(600);
    expect(doc.returnedChars).toBeLessThan(doc.totalChars);
    expect(doc.content.endsWith("\n")).toBe(false);
  });

  it("suggests near ids and refuses unknown ones", async () => {
    await expect(store.fetch("devportal:default/component/m3/core-features/nope/")).rejects.toBeInstanceOf(
      DocumentNotFoundError,
    );
    expect(store.suggest("something/core-features/transfer-flow/")).toEqual([id]);
  });

  it("only serves documents the manifest knows, so a path cannot escape the kb", async () => {
    await expect(store.fetch("../../../etc/passwd")).rejects.toBeInstanceOf(DocumentNotFoundError);
  });
});
