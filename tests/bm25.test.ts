import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Bm25Index, tokenize } from "../src/store/bm25.js";

const docs = [
  { id: "a", text: "ADR0010 client credentials and token management for M2M access", sourceType: "adr", kind: "doc", authority: "binding", lang: "en" },
  { id: "b", text: "Social login in TSID: analysis of Google and Apple providers", sourceType: "confluence", kind: "doc", authority: "descriptive", lang: "en" },
  { id: "c", text: "Gestione dei ruoli legacy e nuove policy nel Policy Manager", sourceType: "confluence", kind: "doc", authority: "descriptive", lang: "it" },
  { id: "d", text: "Data store tiers for OnePlatform data products", sourceType: "adr", kind: "doc", authority: "binding", lang: "en" },
];

describe("tokenize", () => {
  it("lowercases, folds accents, drops stopwords and splits alnum codes", () => {
    expect(tokenize("Perché il Policy Manager")).toEqual(["perche", "policy", "manager"]);
    expect(tokenize("ADR0010")).toEqual(["adr0010", "adr", "0010"]);
  });
});

describe("Bm25Index", () => {
  const tmp = mkdtemp(path.join(os.tmpdir(), "bm25-"));
  afterAll(async () => rm(await tmp, { recursive: true, force: true }));

  it("ranks the matching document first and honours filters", async () => {
    const idx = Bm25Index.build(docs);
    expect(idx.search("client credentials M2M", 3)[0]?.id).toBe("a");
    expect(idx.search("social login", 3)[0]?.id).toBe("b");
    expect(idx.search("ADR 0010", 3)[0]?.id).toBe("a");
    expect(idx.search("policy", 3, { langs: ["en"] }).map((h) => h.id)).not.toContain("c");
    expect(idx.search("data tiers", 3, { sourceTypes: ["confluence"] })).toEqual([]);
  });

  it("round-trips through save/load", async () => {
    const idx = Bm25Index.build(docs);
    const file = path.join(await tmp, "bm25.json.gz");
    await idx.save(file);
    const loaded = await Bm25Index.load(file);
    expect(loaded?.size).toBe(4);
    expect(loaded?.search("token management", 1)[0]?.id).toBe("a");
  });
});
