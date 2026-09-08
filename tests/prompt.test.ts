import { describe, expect, it } from "vitest";
import { buildMessages, extractCitedNumbers, formatContext } from "../src/generation/prompt.js";
import type { RetrievedChunk } from "../src/types.js";

const chunk = (id: string, content: string): RetrievedChunk => ({
  id, sourceId: `s:${id}`, sourceType: "adr", title: "T", sourceUrl: "https://x", authority: "binding", lang: "en",
  relPath: "adr/x.md", ordinal: 0, headingPath: `T > ${id}`, content, score: 1, vectorRank: 1, bm25Rank: null,
});

describe("prompt", () => {
  it("numbers context blocks starting at 1 and keeps recent history", () => {
    const ctx = formatContext([chunk("a", "AAA"), chunk("b", "BBB")]);
    expect(ctx).toMatch(/^\[1\] T > a/);
    expect(ctx).toContain("[2] T > b");
    const msgs = buildMessages(
      [{ role: "user", content: "old q" }, { role: "assistant", content: "old a" }],
      "new q",
      [chunk("a", "AAA")],
    );
    expect(msgs[0]?.role).toBe("system");
    expect(msgs.at(-1)).toEqual({ role: "user", content: "new q" });
    expect(msgs).toHaveLength(4);
  });

  it("extracts used citation numbers within range, in first-use order", () => {
    expect(extractCitedNumbers("Yes [2]. Also [1][2] and [9].", 3)).toEqual([2, 1]);
  });
});
