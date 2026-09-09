import { describe, expect, it } from "vitest";
import { buildMessages, deepLink, extractCitedNumbers, formatContext, toCitations } from "../src/generation/prompt.js";
import type { RetrievedChunk } from "../src/types.js";

const chunk = (id: string, content: string, extra: Partial<RetrievedChunk> = {}): RetrievedChunk => ({
  id, sourceId: `s:${id}`, sourceType: "adr", kind: "doc", title: "T", sourceUrl: "https://x", authority: "binding", lang: "en",
  relPath: "adr/x.md", ordinal: 0, headingPath: `T > ${id}`, content, lineStart: null, lineEnd: null, score: 1, vectorRank: 1, bm25Rank: null,
  ...extra,
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

  it("puts line ranges in the context, and deep-links code citations", () => {
    const code = chunk("c", "```ts\nexport const x = 1;\n```", {
      kind: "code",
      sourceUrl: "https://biosphere.teamsystem.com/oneplatform/x/-/blob/main/src/a.ts",
      lineStart: 10,
      lineEnd: 24,
    });
    const ctx = formatContext([code]);
    expect(ctx).toContain("(lines 10-24)");
    expect(ctx).toContain("kind=code");
    expect(deepLink(code)).toBe("https://biosphere.teamsystem.com/oneplatform/x/-/blob/main/src/a.ts#L10-24");
    expect(deepLink(chunk("a", "x"))).toBe("https://x");
    expect(toCitations([code])[0]?.sourceUrl).toContain("#L10-24");
  });

  it("extracts used citation numbers within range, in first-use order", () => {
    expect(extractCitedNumbers("Yes [2]. Also [1][2] and [9].", 3)).toEqual([2, 1]);
  });
});
