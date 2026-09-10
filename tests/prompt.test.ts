import { describe, expect, it } from "vitest";
import { CARRIED_CONTEXT_NOTE, NO_TOOLS_NOTE, blocksFor, buildMessages, deepLink, extractCitedNumbers, formatContext, stripToolCallText, toolInstructions } from "../src/generation/prompt.js";
import type { RetrievedChunk } from "../src/types.js";

const chunk = (id: string, content: string, extra: Partial<RetrievedChunk> = {}): RetrievedChunk => ({
  id, sourceId: `s:${id}`, sourceType: "adr", kind: "doc", title: "T", sourceUrl: "https://x", authority: "binding", lang: "en",
  relPath: "adr/x.md", ordinal: 0, headingPath: `T > ${id}`, content, lineStart: null, lineEnd: null, score: 1, vectorRank: 1, bm25Rank: null,
  ...extra,
});

describe("prompt", () => {
  it("numbers context blocks starting at 1 and keeps recent history", () => {
    const ctx = formatContext(blocksFor([chunk("a", "AAA"), chunk("b", "BBB")]));
    expect(ctx).toMatch(/^\[1\] T > a/);
    expect(ctx).toContain("[2] T > b");
    const msgs = buildMessages(
      [{ role: "user", content: "old q" }, { role: "assistant", content: "old a" }],
      "new q",
      blocksFor([chunk("a", "AAA")]),
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
    const ctx = formatContext(blocksFor([code]));
    expect(ctx).toContain("(lines 10-24)");
    expect(ctx).toContain("kind=code");
    expect(deepLink(code)).toBe("https://biosphere.teamsystem.com/oneplatform/x/-/blob/main/src/a.ts#L10-24");
    expect(deepLink(chunk("a", "x"))).toBe("https://x");
    expect(blocksFor([code])[0]?.citation.sourceUrl).toContain("#L10-24");
  });

  it("adds instructions only for the tools the model is actually given", () => {
    const none = buildMessages([], "q", blocksFor([chunk("a", "AAA")]));
    expect(none[0]?.content).not.toContain("search(query)");
    expect(none[0]?.content).not.toContain("fetch_document(");

    const both = buildMessages([], "q", blocksFor([chunk("a", "AAA")]), { tools: ["search", "fetch_document"] });
    expect(both[0]?.content).toContain("search(query)");
    expect(both[0]?.content).toContain("fetch_document(source_id, section?)");
    expect(both[0]?.content).toContain("either call a tool or write the answer");

    const fetchOnly = toolInstructions(["fetch_document"]);
    expect(fetchOnly).toContain("fetch_document(");
    expect(fetchOnly).not.toContain("search(query)");
    expect(toolInstructions([])).toBe("");
  });

  it("pushes the model to keep searching only in extended research mode", () => {
    const fast = buildMessages([], "q", blocksFor([chunk("a", "AAA")]), { tools: ["search", "fetch_document"] })[0]!.content;
    const research = buildMessages([], "q", blocksFor([chunk("a", "AAA")]), { tools: ["search", "fetch_document"], mode: "research" })[0]!.content;
    expect(fast).not.toContain("EXTENDED RESEARCH");
    expect(research).toContain("EXTENDED RESEARCH");
    expect(research).toContain("even when the CONTEXT looks sufficient");
    expect(research).toContain("fetch_document");
    // Without the search tool the note must not promise a search.
    expect(toolInstructions(["fetch_document"], "research")).not.toContain("search again");
  });

  it("extracts the used citation numbers in first-use order, ignoring numbers with no block", () => {
    expect(extractCitedNumbers("Yes [2]. Also [1][2] and [9].", [1, 2, 3])).toEqual([2, 1]);
  });

  it("keeps a citation whose number runs past the number of blocks", () => {
    // A carried context of 3 blocks numbered [7][9][26]: checking [n] against the count would drop
    // every citation the answer actually made, and the UI would report "1 cited" for all of them.
    const carried = [7, 9, 26];
    expect(extractCitedNumbers("Il caller controlla il claim exp [26]. Vedi anche [7].", carried)).toEqual([26, 7]);
    expect(extractCitedNumbers("Inventato [3].", carried)).toEqual([]);
  });

  it("keeps the numbers a carried block already had, so earlier answers' [n] still point at it", () => {
    const ctx = formatContext(blocksFor([chunk("a", "AAA"), chunk("b", "BBB")], 7));
    expect(ctx).toMatch(/^\[7\] T > a/);
    expect(ctx).toContain("[8] T > b");
    expect(blocksFor([chunk("a", "AAA")], 7)[0]?.citation.n).toBe(7);
  });
});

describe("carried context", () => {
  const blocks = blocksFor([chunk("a", "AAA")]);
  const tools = ["search", "fetch_document"];

  it("tells the model the blocks are the chat's, not a search for this question", () => {
    const fresh = buildMessages([], "q", blocks, { tools })[0]!.content;
    const carried = buildMessages([], "q", blocks, { tools, carried: true })[0]!.content;
    expect(fresh).toContain("found by one search on the user's question");
    expect(fresh).not.toContain("gathered earlier in this conversation");
    expect(carried).toContain("gathered earlier in this conversation");
    expect(carried).toContain("This question has NOT been searched for");
    expect(carried).toContain("search(query)");
  });

  it("does not point at search when the model has no search tool", () => {
    const carried = toolInstructions(["fetch_document"], "fast", true);
    expect(carried).toContain("gathered earlier in this conversation");
    expect(carried).not.toContain("This question has NOT been searched for");
    expect(carried).not.toContain("search(query)");
  });

  it("still says where the context came from on the rounds that carry no tools", () => {
    const exhausted = buildMessages([], "q", blocks, { toolsExhausted: true, carried: true })[0]!.content;
    expect(exhausted).toContain(NO_TOOLS_NOTE);
    expect(exhausted).toContain(CARRIED_CONTEXT_NOTE);
    expect(exhausted).not.toContain("search(query)");
    // A model with no tools at all gets the note on its own, not the tool section.
    const noTools = buildMessages([], "q", blocks, { carried: true })[0]!.content;
    expect(noTools).toContain(CARRIED_CONTEXT_NOTE);
    expect(noTools).not.toContain("fetch_document(");
  });
});

describe("tool instructions on the final round", () => {
  const blocks = blocksFor([chunk("a", "AAA")]);

  it("swaps the tool instructions for NO_TOOLS_NOTE when tools are exhausted", () => {
    const withTools = buildMessages([], "q", blocks, { tools: ["search", "fetch_document"] })[0]!.content;
    const exhausted = buildMessages([], "q", blocks, { toolsExhausted: true })[0]!.content;
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
