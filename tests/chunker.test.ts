import { describe, expect, it } from "vitest";
import { chunkCode, chunkDocument, composeChunkText, estimateTokens, extractFencedCode, parseBlocks } from "../src/ingest/chunker.js";
import type { Document } from "../src/types.js";

const opts = { targetTokens: 120, maxTokens: 200, overlapTokens: 20 };

function doc(body: string, title = "Test Doc", kind: Document["meta"]["kind"] = "doc", frontmatter: Record<string, unknown> = {}): Document {
  return {
    body,
    frontmatter,
    meta: {
      sourceId: "test:doc",
      sourceType: "test",
      kind,
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

describe("chunkCode", () => {
  const fn = (name: string, body = 3) => `export function ${name}(a: number): number {\n${Array.from({ length: body }, (_, i) => `  const v${i} = a * ${i}; // some comment to add weight`).join("\n")}\n  return a;\n}`;
  const source = ["import { x } from './x';", "", fn("alpha"), "", fn("beta"), "", "export class Gamma {", "  run() {", "    return 1;", "  }", "}", "", fn("delta"), "", fn("epsilon")].join("\n");
  const body = `# src/a.ts\n\n\`\`\`typescript\n${source}\n\`\`\``;
  const codeDoc = doc(body, "src/a.ts", "code", { project: "oneplatform/x" });

  it("extracts the fenced block", () => {
    const f = extractFencedCode(body)!;
    expect(f.language).toBe("typescript");
    expect(f.lines[0]).toBe("import { x } from './x';");
    expect(f.lines.at(-1)).toBe("}");
  });

  it("cuts at declaration boundaries, keeps fences, records line ranges and symbols", () => {
    const chunks = chunkCode(codeDoc, { targetTokens: 90, maxTokens: 160 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.startsWith("```typescript\n")).toBe(true);
      expect(c.content.endsWith("\n```")).toBe(true);
      expect(c.lineStart).toBeGreaterThan(0);
      expect(c.lineEnd).toBeGreaterThanOrEqual(c.lineStart as number);
      expect(c.headingPath.startsWith("oneplatform/x > src/a.ts")).toBe(true);
      // Every chunk (after the first) starts at a top-level declaration.
      if (c.ordinal > 0) expect(/^```typescript\n(export|import)/.test(c.content)).toBe(true);
    }
    expect(chunks[0]?.lineStart).toBe(1);
    expect(chunks.at(-1)?.lineEnd).toBe(source.split("\n").length);
    expect(chunks.some((c) => c.headingPath.includes("alpha"))).toBe(true);
    expect(chunks.some((c) => c.headingPath.includes("Gamma"))).toBe(true);
    // Chunks are contiguous and cover the file.
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.lineStart).toBeGreaterThan(chunks[i - 1]!.lineEnd as number);
    expect(chunkDocument(codeDoc, { ...opts, code: { targetTokens: 90, maxTokens: 160 } })).toEqual(chunks);
  });

  it("returns a single chunk for a small file and none for an empty one", () => {
    expect(chunkCode(doc("# x.py\n\n```python\nprint(1)\n```", "x.py", "code"), { targetTokens: 400, maxTokens: 700 })).toHaveLength(1);
    expect(chunkCode(doc("# x.py\n\n```python\n\n```", "x.py", "code"), { targetTokens: 400, maxTokens: 700 })).toEqual([]);
  });

  it("composes the embedding text from breadcrumb, context and content", () => {
    expect(composeChunkText("A > B", "", "body")).toBe("A > B\n\nbody");
    expect(composeChunkText("A > B", "ctx", "body")).toBe("A > B\n\nctx\n\nbody");
  });
});

describe("giant single lines", () => {
  it("are hard-wrapped in prose code blocks and in source files", () => {
    const giant = "{" + Array.from({ length: 3000 }, (_, i) => `"k${i}":${i}`).join(",") + "}";
    const prose = chunkDocument(doc(`# T\n\n\`\`\`json\n${giant}\n\`\`\``, "T"), opts);
    expect(prose.length).toBeGreaterThan(3);
    for (const c of prose) expect(estimateTokens(c.content)).toBeLessThanOrEqual(opts.maxTokens + 10);
    const code = chunkCode(doc(`# a.json\n\n\`\`\`json\nx\n${giant}\ny\n\`\`\``, "a.json", "code"), { targetTokens: 120, maxTokens: 200 });
    expect(code.length).toBeGreaterThan(3);
    for (const c of code) expect(c.tokenEstimate).toBeLessThanOrEqual(220);
    expect(code[0]?.lineStart).toBe(1);
    expect(code.at(-1)?.lineEnd).toBe(3);
  });
});
