import { describe, expect, it } from "vitest";
import { chunkDocument, estimateTokens, parseBlocks } from "../src/ingest/chunker.js";
import type { Document } from "../src/types.js";

const opts = { targetTokens: 120, maxTokens: 200, overlapTokens: 20 };

function doc(body: string, title = "Test Doc"): Document {
  return {
    body,
    meta: {
      sourceId: "test:doc",
      sourceType: "test",
      title,
      sourceUrl: null,
      authority: "descriptive",
      lang: "en",
      lastModified: null,
      contentHash: "x",
      relPath: "test/doc.md",
    },
  };
}

describe("parseBlocks", () => {
  it("separates headings, code, tables and paragraphs and tracks heading paths", () => {
    const blocks = parseBlocks(`# Title\n\nIntro para.\n\n## Section A\n\n\`\`\`js\nconst x = 1;\n\`\`\`\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n### Sub\nText under sub.`);
    expect(blocks.map((b) => b.kind)).toEqual(["heading", "text", "heading", "code", "table", "heading", "text"]);
    expect(blocks.at(-1)?.path).toEqual(["Title", "Section A", "Sub"]);
    expect(blocks[3]?.text).toContain("const x = 1;");
  });
});

describe("chunkDocument", () => {
  it("prefixes chunks with a breadcrumb and keeps them under maxTokens", () => {
    const para = "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. ".repeat(6);
    const body = `# Test Doc\n\n## Alpha\n\n${para}\n\n${para}\n\n## Beta\n\n${para}`;
    const chunks = chunkDocument(doc(body), opts);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.startsWith("Test Doc")).toBe(true);
      expect(estimateTokens(c.content)).toBeLessThanOrEqual(opts.maxTokens + 5);
    }
    expect(chunks.some((c) => c.headingPath === "Test Doc > Alpha")).toBe(true);
    expect(chunks.some((c) => c.headingPath === "Test Doc > Beta")).toBe(true);
    expect(chunks.map((c) => c.id)).toEqual(chunks.map((_, i) => `test:doc::${i}`));
  });

  it("does not duplicate the title in the heading path when H1 equals the title", () => {
    const chunks = chunkDocument(doc("# Test Doc\n\nHello world content here."), opts);
    expect(chunks[0]?.headingPath).toBe("Test Doc");
  });

  it("splits oversized tables while repeating the header row", () => {
    const rows = Array.from({ length: 80 }, (_, i) => `| row${i} | ${"value ".repeat(8)} |`).join("\n");
    const body = `# T\n\n| col1 | col2 |\n|------|------|\n${rows}`;
    const chunks = chunkDocument(doc(body, "T"), opts);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content).toContain("| col1 | col2 |");
  });

  it("keeps fenced code blocks intact when they fit", () => {
    const code = "```ts\n" + Array.from({ length: 10 }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n```";
    const chunks = chunkDocument(doc(`# T\n\nSome intro.\n\n${code}\n\nOutro.`, "T"), opts);
    const joined = chunks.map((c) => c.content).join("\n");
    expect(joined).toContain(code);
  });

  it("returns no chunks for an empty body", () => {
    expect(chunkDocument(doc(""), opts)).toEqual([]);
    expect(chunkDocument(doc("# Only a heading"), opts)).toEqual([]);
  });
});
