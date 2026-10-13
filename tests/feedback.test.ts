import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendJsonl, logEvent } from "../src/feedback/index.js";

describe("the JSONL files", () => {
  it("keep every line whole when several writers append at once", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "ai-wiki-feedback-")), "nested", "events.jsonl");
    const note = "x".repeat(5000);
    await Promise.all(Array.from({ length: 40 }, (_, i) => appendJsonl(file, { i, note })));
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(40);
    expect(new Set(lines.map((l) => (JSON.parse(l) as { i: number }).i)).size).toBe(40);
  });

  it("never fail the call they describe", async () => {
    // A directory where the file should be: the write fails, and logEvent swallows it.
    const dir = await mkdtemp(path.join(tmpdir(), "ai-wiki-feedback-"));
    await expect(logEvent({ ts: "t", event: "search" }, dir)).resolves.toBeUndefined();
  });
});
