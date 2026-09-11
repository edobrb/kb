import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

// `config` resolves its paths at import time, so the environment has to be set before anything that
// pulls it in. The mock embedder makes the whole pipeline runnable without Ollama.
const tmp = await mkdtemp(path.join(os.tmpdir(), "ai-wiki-ingest-"));
process.env["KB_DIR"] = path.join(tmp, "kb");
process.env["DATA_DIR"] = path.join(tmp, "data");
process.env["EMBEDDING_PROVIDER"] = "mock";
process.env["GRAPH"] = "false";

const { ingest } = await import("../src/ingest/pipeline.js");
const { paths } = await import("../src/config.js");
const { VectorStore } = await import("../src/store/vector-store.js");

const kb = path.join(tmp, "kb");
afterAll(() => rm(tmp, { recursive: true, force: true }));

const BODY_A = "# Alpha\n\nThe token endpoint returns a JWT valid for one hour.\n\n## Refresh\n\nRefresh tokens rotate on use.\n";
const BODY_B = "# Beta\n\nThe gateway routes by host header.\n";

async function writeDoc(name: string, fm: Record<string, string>, body: string): Promise<void> {
  const front = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  await mkdir(path.join(kb, "src"), { recursive: true });
  await writeFile(path.join(kb, "src", `${name}.md`), `---\n${front}\n---\n\n${body}`, "utf8");
}

const metaA = (extra: Record<string, string> = {}) => ({
  source_id: "test:a",
  source_type: "test",
  kind: "doc",
  title: "Alpha",
  authority: "binding",
  lang: "en",
  ...extra,
});

const run = () => ingest({});

/** Vectors of one document, keyed by ordinal, straight from the table. */
async function vectorsOf(sourceId: string): Promise<Map<number, { text: string; vector: number[] }>> {
  const store = await VectorStore.open(paths.lanceDb, 256);
  const byDoc = await store.chunkVectorsBySourceIds([sourceId], 1000);
  return byDoc.get(sourceId) ?? new Map();
}

describe("incremental ingest", () => {
  it("indexes everything on the first run", async () => {
    await writeDoc("a", metaA({ fetched_at: "2026-01-01", last_modified: "2026-01-01" }), BODY_A);
    await writeDoc("b", { source_id: "test:b", source_type: "test", kind: "doc", title: "Beta", lang: "en" }, BODY_B);
    const r = await run();
    expect(r).toMatchObject({ filesSeen: 2, docsAdded: 2, docsUpdated: 0, docsRefreshed: 0, docsUnchanged: 0 });
    expect(r.chunksWritten).toBeGreaterThan(0);
    expect(r.totalChunks).toBe(r.chunksWritten);
  });

  it("skips files whose bytes did not change", async () => {
    const r = await run();
    expect(r).toMatchObject({ docsUnchanged: 2, docsAdded: 0, docsUpdated: 0, docsRefreshed: 0, chunksWritten: 0 });
  });

  it("reuses the stored vectors when only metadata changed", async () => {
    const before = await vectorsOf("test:a");
    // A new fetched_at, a new last_modified, an extra City Map field: nothing the embedder ever sees.
    await writeDoc("a", metaA({ fetched_at: "2026-09-11", last_modified: "2026-09-10", area: "platform" }), BODY_A);

    const r = await run();
    expect(r).toMatchObject({ docsRefreshed: 1, docsUpdated: 0, docsAdded: 0, chunksWritten: 0 });

    const after = await vectorsOf("test:a");
    expect(after.size).toBe(before.size);
    for (const [ordinal, chunk] of before) {
      expect(after.get(ordinal)?.text).toBe(chunk.text);
      expect(after.get(ordinal)?.vector).toEqual(chunk.vector);
    }
    // The rows really were rewritten: the new metadata is in the table, not just in the file.
    const store = await VectorStore.open(paths.lanceDb, 256);
    const rows = await store.getByIds(["test:a::0"]);
    expect(rows.get("test:a::0")?.last_modified).toBe("2026-09-10");
    expect(await store.count()).toBe(r.totalChunks);
  });

  it("re-embeds when the body changes", async () => {
    await writeDoc("a", metaA({ fetched_at: "2026-09-11", last_modified: "2026-09-10", area: "platform" }), `${BODY_A}\n## Scopes\n\nScopes are space separated.\n`);
    const r = await run();
    expect(r).toMatchObject({ docsUpdated: 1, docsRefreshed: 0, docsAdded: 0 });
    expect(r.chunksWritten).toBeGreaterThan(0);
    const store = await VectorStore.open(paths.lanceDb, 256);
    expect(await store.count()).toBe(r.totalChunks);
  });

  it("re-embeds when the title changes, because the heading path is embedded", async () => {
    const before = await vectorsOf("test:b");
    await writeDoc("b", { source_id: "test:b", source_type: "test", kind: "doc", title: "Beta Gateway", lang: "en" }, BODY_B);
    const r = await run();
    expect(r).toMatchObject({ docsUpdated: 1, docsRefreshed: 0 });
    const after = await vectorsOf("test:b");
    expect(after.get(0)?.text).not.toBe(before.get(0)?.text);
  });

  it("still reuses vectors when the manifest predates embedHash", async () => {
    // Entries written by an older build have no embedHash; the stored chunk text has to settle it.
    const manifest = JSON.parse(await readFile(paths.manifest, "utf8")) as { docs: Record<string, { embedHash?: string }> };
    for (const entry of Object.values(manifest.docs)) delete entry.embedHash;
    await writeFile(paths.manifest, JSON.stringify(manifest, null, 2), "utf8");

    await writeDoc("b", { source_id: "test:b", source_type: "test", kind: "doc", title: "Beta Gateway", lang: "en", owner: "platform-team" }, BODY_B);
    const r = await run();
    expect(r).toMatchObject({ docsRefreshed: 1, docsUpdated: 0, chunksWritten: 0 });

    const written = JSON.parse(await readFile(paths.manifest, "utf8")) as { docs: Record<string, { embedHash?: string }> };
    expect(written.docs["test:b"]?.embedHash).toMatch(/^sha256:/);
    // The untouched document got its embedHash backfilled from the file it already describes.
    expect(written.docs["test:a"]?.embedHash).toMatch(/^sha256:/);
  });

  it("drops documents whose file disappeared", async () => {
    await rm(path.join(kb, "src", "b.md"));
    const r = await run();
    expect(r.docsRemoved).toBe(1);
    const store = await VectorStore.open(paths.lanceDb, 256);
    expect((await store.chunkVectorsBySourceIds(["test:b"], 100)).size).toBe(0);
    expect(await store.count()).toBe(r.totalChunks);
  });
});
