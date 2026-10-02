import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildWhere, needsTableFilter, VectorStore } from "../src/store/vector-store.js";
import type { StoredChunk } from "../src/types.js";

const row = (id: string, lastModified: string, text: string): StoredChunk => ({
  id,
  source_id: id,
  source_type: "gitlab",
  kind: "doc",
  title: id,
  source_url: "",
  authority: "descriptive",
  lang: "en",
  last_modified: lastModified,
  rel_path: `${id}.md`,
  ordinal: 0,
  heading_path: id,
  content: text,
  text,
  line_start: -1,
  line_end: -1,
  vector: [1, 0, 0, 0],
});

describe("buildWhere", () => {
  it("quotes every value, including the literal text", () => {
    expect(buildWhere({ contains: "it's" })).toBe("strpos(lower(text), 'it''s') > 0");
  });

  it("only asks for the table when BM25 cannot evaluate a filter itself", () => {
    expect(needsTableFilter({ sourceTypes: ["adr"], langs: ["en"] })).toBe(false);
    expect(needsTableFilter({ modifiedBefore: "2026" })).toBe(true);
    expect(needsTableFilter({ contains: "x" })).toBe(true);
  });
});

// The predicates run on LanceDB's SQL engine, so they are checked against a real table.
describe("date and literal filters on a table", () => {
  let dir: string;
  let store: VectorStore;
  const ids = (filters: Parameters<VectorStore["idsMatching"]>[0]) => store.idsMatching(filters).then((s) => [...s].sort());

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "ai-wiki-lance-"));
    store = await VectorStore.open(dir, 4);
    await store.add([
      row("may", "2026-05-31", "Set ORDER_SERVICE_URL to the gateway."),
      row("june", "2026-06-01", "The ORDERxSERVICExURL typo is not the variable."),
      row("july", "2026-07-01", "GET /api/v1/orders returns 100% of the orders."),
      row("undated", "", "ORDER_SERVICE_URL again, with no date."),
    ]);
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));

  it("treats a date prefix as the whole period, after inclusive and before exclusive", async () => {
    expect(await ids({ modifiedAfter: "2026-06" })).toEqual(["july", "june"]);
    expect(await ids({ modifiedAfter: "2026-06", modifiedBefore: "2026-07" })).toEqual(["june"]);
    expect(await ids({ modifiedAfter: "2026-06-01", modifiedBefore: "2026-06-02" })).toEqual(["june"]);
  });

  it("leaves undated documents out of any date range", async () => {
    expect(await ids({ modifiedBefore: "2027" })).toEqual(["july", "june", "may"]);
  });

  it("matches literal text case-insensitively, with _ and % as plain characters", async () => {
    expect(await ids({ contains: "order_service_url" })).toEqual(["may", "undated"]);
    expect(await ids({ contains: "100%" })).toEqual(["july"]);
    expect(await ids({ contains: "/API/V1/orders" })).toEqual(["july"]);
    expect(await ids({ contains: "order_service_url", modifiedAfter: "2026" })).toEqual(["may"]);
  });

  it("applies the same predicate to vector search", async () => {
    const hits = await store.search([1, 0, 0, 0], 10, { contains: "ORDER_SERVICE_URL" });
    expect(hits.map((h) => h.row.id).sort()).toEqual(["may", "undated"]);
  });
});
