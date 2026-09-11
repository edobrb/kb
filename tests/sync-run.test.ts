import { mkdtemp, readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSync, type SourceDefinition } from "../src/sync/index.js";
import { createHttp } from "../src/sync/http.js";
import { KB_DOC_VERSION } from "../src/sync/kb-writer.js";
import { readState } from "../src/sync/state.js";
import { DEFAULT_SOURCES } from "../src/sync/sources-config.js";
import type { SyncDoc, SyncEvent } from "../src/sync/types.js";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "ai-wiki-sync-"));
});
afterEach(async () => {
  await import("node:fs/promises").then((fs) => fs.rm(tmp, { recursive: true, force: true }));
});

const doc = (id: string, title: string, fingerprint: string, body = "Some body text long enough."): SyncDoc => ({
  sourceId: `fake:${id}`,
  sourceType: "fake",
  relPath: `fake/${id}-${title.toLowerCase()}.md`,
  title,
  sourceUrl: `https://example.com/${id}`,
  lastModified: "2026-01-01",
  body,
  fingerprint,
  extra: {},
});

function def(events: () => SyncEvent[], hasCredentials = true): Record<string, SourceDefinition> {
  return {
    fake: {
      folder: "fake",
      baseUrl: "https://example.com",
      enabled: true,
      credentialsHint: "set FAKE_TOKEN",
      hasCredentials,
      http: () => createHttp({ fetchImpl: (async () => new Response("{}")) as typeof fetch }),
      probe: async () => "ok",
      run: async function* () {
        for (const e of events()) yield e;
      },
    },
  };
}

const exists = (p: string) => stat(p).then(() => true, () => false);

describe("runSync orchestration", () => {
  it("adds, updates, keeps and removes files across runs and persists state", async () => {
    const kb = path.join(tmp, "kb");
    const st = path.join(tmp, "state");
    const opts = { kbDir: kb, stateDir: st, sourcesConfig: DEFAULT_SOURCES };

    const r1 = await runSync({ ...opts, definitions: def(() => [{ type: "doc", doc: doc("1", "One", "v1") }, { type: "doc", doc: doc("2", "Two", "v1") }, { type: "meta", key: "k", value: 42 }]) });
    expect(r1[0]).toMatchObject({ added: 2, updated: 0, unchanged: 0, removed: 0 });
    expect(r1[0]?.fatal).toBeUndefined();
    expect(await exists(path.join(kb, "fake/1-one.md"))).toBe(true);
    const state1 = await readState(st, "fake");
    expect(state1?.items["fake:1"]?.fingerprint).toBe("v1");
    expect(state1?.meta["k"]).toBe(42);
    const file1 = await readFile(path.join(kb, "fake/1-one.md"), "utf8");
    expect(file1).toContain("source_id: fake:1");
    expect(file1).toContain("# One");

    // Run 2: doc 1 unchanged, doc 2 changed (renamed -> new path), doc 3 new; doc 2's old file goes away.
    const r2 = await runSync({
      ...opts,
      definitions: def(() => [{ type: "unchanged", sourceId: "fake:1" }, { type: "doc", doc: doc("2", "Zwei", "v2") }, { type: "doc", doc: doc("3", "Three", "v1") }]),
    });
    expect(r2[0]).toMatchObject({ added: 1, updated: 1, unchanged: 1, removed: 0 });
    expect(await exists(path.join(kb, "fake/2-two.md"))).toBe(false);
    expect(await exists(path.join(kb, "fake/2-zwei.md"))).toBe(true);
    const state2 = await readState(st, "fake");
    expect(state2?.meta["k"]).toBe(42); // meta carried over when not re-emitted

    // Run 3: doc 3 disappeared from the source -> removed.
    const r3 = await runSync({ ...opts, definitions: def(() => [{ type: "unchanged", sourceId: "fake:1" }, { type: "unchanged", sourceId: "fake:2" }]) });
    expect(r3[0]).toMatchObject({ removed: 1, unchanged: 2 });
    expect(await exists(path.join(kb, "fake/3-three.md"))).toBe(false);
    expect((await readdir(path.join(kb, "fake"))).sort()).toEqual(["1-one.md", "2-zwei.md"]);
  });

  it("does not prune when the connector aborts or when --only is used", async () => {
    const kb = path.join(tmp, "kb");
    const st = path.join(tmp, "state");
    const opts = { kbDir: kb, stateDir: st, sourcesConfig: DEFAULT_SOURCES };
    await runSync({ ...opts, definitions: def(() => [{ type: "doc", doc: doc("1", "One", "v1") }, { type: "doc", doc: doc("2", "Two", "v1") }]) });

    const aborting: Record<string, SourceDefinition> = def(() => []);
    aborting["fake"]!.run = async function* () {
      yield { type: "unchanged", sourceId: "fake:1" };
      throw new Error("network down");
    };
    const r = await runSync({ ...opts, definitions: aborting });
    expect(r[0]?.fatal).toMatch(/network down/);
    expect(r[0]?.removed).toBe(0);
    expect(await exists(path.join(kb, "fake/2-two.md"))).toBe(true);
    expect((await readState(st, "fake"))?.items["fake:2"]).toBeDefined();

    const r2 = await runSync({ ...opts, only: "1", definitions: def(() => [{ type: "unchanged", sourceId: "fake:1" }]) });
    expect(r2[0]?.removed).toBe(0);
    expect(await exists(path.join(kb, "fake/2-two.md"))).toBe(true);
  });

  it("reports foreign files and prunes them only with pruneForeign", async () => {
    const kb = path.join(tmp, "kb");
    const st = path.join(tmp, "state");
    await mkdir(path.join(kb, "fake"), { recursive: true });
    await writeFile(path.join(kb, "fake/old-import.md"), "# old", "utf8");
    const opts = { kbDir: kb, stateDir: st, sourcesConfig: DEFAULT_SOURCES, definitions: def(() => [{ type: "doc", doc: doc("1", "One", "v1") }]) };
    const r1 = await runSync(opts);
    expect(r1[0]?.foreign).toBe(1);
    expect(await exists(path.join(kb, "fake/old-import.md"))).toBe(true);
    const r2 = await runSync({ ...opts, pruneForeign: true });
    expect(r2[0]?.foreign).toBe(1);
    expect(await exists(path.join(kb, "fake/old-import.md"))).toBe(false);
  });

  it("applies rules (skip / source_type / authority) and skips sources without credentials", async () => {
    const kb = path.join(tmp, "kb");
    const st = path.join(tmp, "state");
    const cfg = structuredClone(DEFAULT_SOURCES);
    cfg.rules = [
      { match: "fake:skipme", skip: true },
      { match: "fake:*", source_type: "adr", authority: "binding" },
    ];
    const r = await runSync({ kbDir: kb, stateDir: st, sourcesConfig: cfg, definitions: def(() => [{ type: "doc", doc: doc("skipme", "S", "v") }, { type: "doc", doc: doc("1", "One", "v") }]) });
    expect(r[0]).toMatchObject({ added: 1, skipped: 1 });
    const f = await readFile(path.join(kb, "fake/1-one.md"), "utf8");
    expect(f).toContain("source_type: adr");
    expect(f).toContain("authority: binding");

    const r2 = await runSync({ kbDir: kb, stateDir: st, sourcesConfig: cfg, definitions: def(() => [], false) });
    expect(r2[0]?.fatal).toMatch(/missing credentials/);
  });

  it("keeps the source fingerprint out of the file and writes the state as the run goes", async () => {
    const kb = path.join(tmp, "kb");
    const st = path.join(tmp, "state");
    const seen: unknown[] = [];
    const defs = def(() => []);
    defs["fake"]!.run = async function* () {
      yield { type: "doc", doc: doc("1", "One", "v1") };
      // Back here the runner has already handled document 1: a kill now must not cost the whole source.
      seen.push(await readState(st, "fake"));
      yield { type: "doc", doc: doc("2", "Two", "v1") };
    };
    await runSync({ kbDir: kb, stateDir: st, sourcesConfig: DEFAULT_SOURCES, definitions: defs });

    const file = await readFile(path.join(kb, "fake/1-one.md"), "utf8");
    expect(file).not.toContain("fingerprint:");
    expect(file).toContain("fetched_at:");
    expect(seen[0]).toMatchObject({ items: { "fake:1": { relPath: "fake/1-one.md", fingerprint: "v1" } } });
    expect((await readState(st, "fake"))?.docVersion).toBe(KB_DOC_VERSION);
  });

  it("re-renders every document when the kb document format changes", async () => {
    const kb = path.join(tmp, "kb");
    const st = path.join(tmp, "state");
    // A connector that trusts its own fingerprints, like the real ones do.
    const defs = def(() => []);
    defs["fake"]!.run = async function* (ctx) {
      const d = doc("1", "One", "v1");
      if (ctx.previous.items[d.sourceId]?.fingerprint === d.fingerprint) yield { type: "unchanged", sourceId: d.sourceId };
      else yield { type: "doc", doc: d };
    };
    const opts = { kbDir: kb, stateDir: st, sourcesConfig: DEFAULT_SOURCES, definitions: defs };

    expect((await runSync(opts))[0]).toMatchObject({ added: 1 });
    expect((await runSync(opts))[0]).toMatchObject({ unchanged: 1, updated: 0 });

    // An older renderer wrote these files: the fingerprint must not be allowed to keep them.
    const state = JSON.parse(await readFile(path.join(st, "fake.json"), "utf8")) as Record<string, unknown>;
    delete state["docVersion"];
    await writeFile(path.join(st, "fake.json"), JSON.stringify(state), "utf8");

    expect((await runSync(opts))[0]).toMatchObject({ updated: 1, unchanged: 0 });
    expect((await runSync(opts))[0]).toMatchObject({ unchanged: 1, updated: 0 });
  });

  it("dry run writes nothing", async () => {
    const kb = path.join(tmp, "kb");
    const st = path.join(tmp, "state");
    const r = await runSync({ kbDir: kb, stateDir: st, dryRun: true, sourcesConfig: DEFAULT_SOURCES, definitions: def(() => [{ type: "doc", doc: doc("1", "One", "v1") }]) });
    expect(r[0]?.added).toBe(1);
    expect(await exists(path.join(kb, "fake"))).toBe(false);
    expect(await readState(st, "fake")).toBeNull();
  });
});
