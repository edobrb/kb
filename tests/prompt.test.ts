import { describe, expect, it } from "vitest";
import { NO_TOOLS_NOTE, buildMessages, deepLink, extractCitedNumbers, formatContext, stripToolCallText, toCitations, toolInstructions } from "../src/generation/prompt.js";
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

  it("adds instructions only for the tools the model is actually given", () => {
    const none = buildMessages([], "q", [chunk("a", "AAA")]);
    expect(none[0]?.content).not.toContain("search(query)");
    expect(none[0]?.content).not.toContain("fetch_document(");

    const both = buildMessages([], "q", [chunk("a", "AAA")], { tools: ["search", "fetch_document"] });
    expect(both[0]?.content).toContain("search(query)");
    expect(both[0]?.content).toContain("fetch_document(source_id, section?)");
    expect(both[0]?.content).toContain("either call a tool or write the answer");

    const fetchOnly = toolInstructions(["fetch_document"]);
    expect(fetchOnly).toContain("fetch_document(");
    expect(fetchOnly).not.toContain("search(query)");
    expect(toolInstructions([])).toBe("");
  });

  it("extracts used citation numbers within range, in first-use order", () => {
    expect(extractCitedNumbers("Yes [2]. Also [1][2] and [9].", 3)).toEqual([2, 1]);
  });
});

describe("tool instructions on the final round", () => {
  const chunks = [chunk("a", "AAA")];

  it("swaps the tool instructions for NO_TOOLS_NOTE when tools are exhausted", () => {
    const withTools = buildMessages([], "q", chunks, { tools: ["search", "fetch_document"] })[0]!.content;
    const exhausted = buildMessages([], "q", chunks, { toolsExhausted: true })[0]!.content;
    expect(withTools).toContain("search(query)");
    expect(exhausted).not.toContain("search(query)");
    expect(exhausted).toContain(NO_TOOLS_NOTE);
    expect(exhausted).toContain("CONTEXT:");
  });

  it("strips a tool call the model wrote as text", () => {
    const leak =
      "Ecco la risposta [1].\n\n<tool_call> <function=search> <parameter=query> relations </parameter> </function> </tool_call>";
    expect(stripToolCallText(leak)).toBe("Ecco la risposta [1].");
    expect(stripToolCallText("Ora leggo.\n<tool_call> <function=fetch_document>")).toBe("Ora leggo.");
    expect(stripToolCallText("Nessun tool qui [1].")).toBe("Nessun tool qui [1].");
  });
});
