import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { FETCH_DOCUMENT_TOOL, runToolCall } from "../src/generation/tools.js";
import { DocumentStore } from "../src/retrieval/documents.js";
import type { Citation, ToolCall } from "../src/types.js";

const PAGE = `---
source_id: "adr:client-credentials"
source_type: adr
title: ADR0010 Client Credentials
authority: binding
source_url: "https://example.com/adr0010"
lang: en
last_modified: "2026-02-01"
---

# ADR0010 Client Credentials

## Decision

Use client credentials for service-to-service calls.

## Consequences

The old M2M token is deprecated. Existing integrations keep working until the deadline, new ones
must use client credentials, and the platform team tracks the migration per service. This section
is padded so the whole page is comfortably longer than the 500-character floor that a fetch always
returns, which is what makes the truncation branch observable in a test. A couple more lines of
padding keep the page over that floor even after the frontmatter is stripped and blank lines are
collapsed by the loader, so the budget branch is the one under test rather than the floor.
`;

const citation = (n: number, sourceId: string): Citation => ({
  n,
  chunkId: `${sourceId}#0`,
  sourceId,
  title: "T",
  sourceUrl: null,
  sourceType: "adr",
  kind: "doc",
  authority: "binding",
  headingPath: "T > H",
  relPath: "adr/x.md",
  excerpt: "…",
  lineStart: null,
  lineEnd: null,
  score: 1,
});

const call = (args: Record<string, unknown>, name = "fetch_document"): ToolCall => ({ function: { name, arguments: args } });

let store: DocumentStore;

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ai-wiki-tools-"));
  const kbDir = path.join(root, "kb");
  await mkdir(path.join(kbDir, "adr"), { recursive: true });
  await writeFile(path.join(kbDir, "adr", "adr0010.md"), PAGE, "utf8");
  const manifestFile = path.join(root, "manifest.json");
  await writeFile(
    manifestFile,
    JSON.stringify({
      version: 1,
      embeddingModel: "mock",
      embeddingDimensions: 8,
      chunking: { targetTokens: 450, maxTokens: 700, overlapTokens: 60 },
      docs: {
        "adr:client-credentials": {
          sourceId: "adr:client-credentials",
          relPath: "adr/adr0010.md",
          contentHash: "sha256:x",
          chunkCount: 1,
          indexedAt: "2026-09-10T00:00:00.000Z",
        },
      },
    }),
    "utf8",
  );
  store = await DocumentStore.open(manifestFile, kbDir);
});

describe("fetch_document tool", () => {
  it("declares a schema Ollama accepts", () => {
    expect(FETCH_DOCUMENT_TOOL.type).toBe("function");
    expect(FETCH_DOCUMENT_TOOL.function.parameters.required).toEqual(["source_id"]);
    expect(Object.keys(FETCH_DOCUMENT_TOOL.function.parameters.properties)).toEqual(["source_id", "section"]);
  });

  it("returns the document as a new numbered block", async () => {
    const citations = [citation(1, "devportal:other")];
    const out = await runToolCall(call({ source_id: "adr:client-credentials" }), { store, citations });
    expect(out.ok).toBe(true);
    expect(out.citationNumber).toBe(2);
    expect(out.newCitation?.sourceId).toBe("adr:client-credentials");
    expect(out.message.role).toBe("tool");
    expect(out.message.tool_name).toBe("fetch_document");
    expect(out.message.content).toMatch(/^\[2\] ADR0010 Client Credentials — adr:client-credentials/);
    expect(out.message.content).toContain("authority=binding");
    expect(out.message.content).toContain("last_modified=2026-02-01");
    expect(out.message.content).toContain("outline: Decision · Consequences");
    expect(out.message.content).toContain("The old M2M token is deprecated.");
  });

  it("accepts a citation number instead of a source_id, and keeps that number", async () => {
    const citations = [citation(1, "devportal:other"), citation(2, "adr:client-credentials")];
    const out = await runToolCall(call({ source_id: "[2]" }), { store, citations });
    expect(out.ok).toBe(true);
    expect(out.citationNumber).toBe(2);
    expect(out.newCitation).toBeUndefined(); // already a citation: no duplicate source
    expect(out.message.content).toMatch(/^\[2\] /);
  });

  it("returns a single section when asked", async () => {
    const out = await runToolCall(call({ source_id: "adr:client-credentials", section: "Consequences" }), {
      store,
      citations: [],
    });
    expect(out.message.content).toContain('section "Consequences"');
    expect(out.message.content).toContain("The old M2M token is deprecated.");
    expect(out.message.content).not.toContain("Use client credentials for service-to-service calls.");
  });

  it("honours the character budget and tells the model the result was cut", async () => {
    const out = await runToolCall(call({ source_id: "adr:client-credentials" }), {
      store,
      citations: [],
      maxChars: 60,
    });
    expect(out.message.content).toContain("TRUNCATED");
    expect(out.message.content).toContain("outline: Decision · Consequences");
  });

  it("turns a wrong source_id into an error the model can recover from", async () => {
    const citations = [citation(1, "devportal:other")];
    const out = await runToolCall(call({ source_id: "adr:made-up" }), { store, citations });
    expect(out.ok).toBe(false);
    expect(out.newCitation).toBeUndefined();
    expect(out.message.content).toContain("Error:");
    expect(out.message.content).toContain("devportal:other"); // the ids it may actually ask for
  });

  it("rejects a missing argument and an unknown tool", async () => {
    const noArg = await runToolCall(call({}), { store, citations: [] });
    expect(noArg.ok).toBe(false);
    expect(noArg.message.content).toContain("needs a source_id");

    const unknown = await runToolCall(call({ query: "x" }, "search_the_web"), { store, citations: [] });
    expect(unknown.ok).toBe(false);
    expect(unknown.message.content).toContain("no tool called");
  });
});

describe("repeat fetches", () => {
  it("answers a second request for the same document with a pointer, not a second copy", async () => {
    const fetched = new Map<string, number>();
    const citations = [citation(1, "adr:client-credentials")];
    const first = await runToolCall(call({ source_id: "adr:client-credentials" }), { store, citations, fetched });
    expect(first.message.content).toContain("Use client credentials");

    // The model often asks again using the number the first result was given.
    const second = await runToolCall(call({ source_id: "1" }), { store, citations, fetched });
    expect(second.ok).toBe(true);
    expect(second.citationNumber).toBe(1);
    expect(second.message.content).toContain("already in the context as block [1]");
    expect(second.message.content).not.toContain("Use client credentials");

    // A different section of the same page is still a real read.
    const third = await runToolCall(call({ source_id: "adr:client-credentials", section: "Decision" }), {
      store,
      citations,
      fetched,
    });
    expect(third.message.content).toContain("Use client credentials");
  });
});
