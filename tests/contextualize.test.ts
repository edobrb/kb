import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { chunkDocument } from "../src/ingest/chunker.js";
import {
  buildBackground,
  buildBatchContextMessages,
  buildContextMessages,
  ContextCache,
  Contextualizer,
  deterministicContext,
  documentWindow,
  groupChunks,
  parseBatchContexts,
  sanitizeContext,
  type CompleteFn,
} from "../src/ingest/contextualize.js";
import type { Document } from "../src/types.js";

const opts = {
  model: "test-model",
  numCtx: 8192,
  maxDocChars: 400,
  maxBackgroundChars: 300,
  maxTokens: 100,
  kinds: ["doc", "code", "api"],
  groupChars: 16_000,
  groupCharsByKind: { api: 8_000 },
  maxWords: 30,
  minChunks: 2,
  minChunksByKind: { code: 4 },
};

/** Answers a batch prompt the way the real model is asked to: one "<id>: <context>" line per chunk. */
const batchComplete = (label = "Situates"): CompleteFn => async (messages) => {
  const user = messages.at(-1)!.content;
  const single = /<chunk>\n([\s\S]*?)\n<\/chunk>/.exec(user);
  if (single) return `${label}: ${single[1]!.slice(0, 12)}`;
  return [...user.matchAll(/<chunk id="(\d+)"[^>]*>\n([\s\S]*?)\n<\/chunk>/g)]
    .map((m) => `${m[1]}: ${label}: ${m[2]!.slice(0, 12)}`)
    .join("\n");
};

function doc(body: string, kind: Document["meta"]["kind"] = "doc", frontmatter: Record<string, unknown> = {}, sourceType = "gitlab"): Document {
  return {
    body,
    frontmatter,
    meta: { sourceId: `t:${kind}`, sourceType, kind, title: kind === "code" ? "src/a.ts" : "Guide", sourceUrl: null, authority: "descriptive", lang: "en", lastModified: null, contentHash: "h", relPath: "gitlab/x/a.md" },
  };
}

const card = "# Registry (oneplatform/islands/registry)\n\nRepository `oneplatform/islands/registry` on GitLab (https://g/x), default branch `main`.\n\nThe registry service stores tenants.\n\n## Summary\n\n- Group `oneplatform`\n";

describe("background + deterministic contexts", () => {
  it("uses the project card for repository files and the entity for portal pages", () => {
    const code = doc("```ts\nx\n```", "code", { project: "oneplatform/islands/registry", file_path: "src/a.ts", language: "typescript" });
    expect(buildBackground(code, card, 1000)).toBe(card);
    expect(buildBackground(code, null, 1000)).toContain("oneplatform/islands/registry");
    const portal = doc("hello", "doc", { entity: "default/component/hermes", entity_title: "Hermes", owner: "group:platform", site_name: "Hermes docs" }, "devportal");
    const bg = buildBackground(portal, null, 1000);
    expect(bg).toContain("Hermes");
    expect(bg).toContain("Owner: group:platform");
    expect(buildBackground(portal, null, 20).length).toBeLessThanOrEqual(20);
  });

  it("writes a sensible one-liner per kind", () => {
    const code = doc("```ts\nx\n```", "code", { project: "oneplatform/islands/registry", file_path: "src/a.ts", language: "typescript" });
    expect(deterministicContext(code, card)).toBe("Source file src/a.ts (typescript) of the registry repository (oneplatform/islands/registry) — The registry service stores tenants.");
    expect(deterministicContext(doc("x", "project", { project: "oneplatform/islands/registry" }), card)).toContain("Project card of the registry repository");
    expect(deterministicContext(doc("x", "doc", { entity: "default/component/hermes", site_name: "Hermes" }, "devportal"), "")).toContain('Page "Guide" of the Hermes documentation');
    expect(deterministicContext(doc("x", "api", { entity_title: "Workspace API", owner: "team-a" }, "devportal"), "")).toContain("API definition of Workspace API");
  });
});

describe("documentWindow + sanitizeContext", () => {
  it("returns the whole document when it fits, else head + a window around the chunk", () => {
    const paras = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} talks about topic number ${i} in some detail.`);
    const body = paras.join("\n\n");
    const d = doc(body);
    const chunks = chunkDocument(d, { targetTokens: 60, maxTokens: 100, overlapTokens: 0 });
    const late = chunks.at(-1)!;
    expect(documentWindow(body, late, body.length + 10)).toBe(body);
    const w = documentWindow(body, late, 600);
    expect(w.length).toBeLessThan(900);
    expect(w.startsWith("Paragraph 0")).toBe(true);
    expect(w).toContain("omitted");
    expect(w).toContain(late.content.slice(0, 40));
  });

  it("strips thinking tags, labels, quotes and markdown", () => {
    expect(sanitizeContext('<think>hmm</think>\nContext: "This chunk **defines** the `run` method."')).toBe("This chunk defines the `run` method.");
    expect(sanitizeContext("Defines subject_token in Platform/ADR0019_otel.md, ## heading")).toBe("Defines subject_token in Platform/ADR0019_otel.md, heading");
    expect(sanitizeContext("ok")).toBe("");
    expect(sanitizeContext("x".repeat(900)).length).toBeLessThanOrEqual(700);
  });
});

describe("batch prompt, parser and grouping", () => {
  const d = doc("Body.", "doc", { project: "oneplatform/islands/registry", file_path: "docs/guide.md" });
  const mk = (id: string, content: string, headingPath = "") =>
    ({ id, sourceId: "s", ordinal: 0, headingPath, content, context: "", text: "", tokenEstimate: content.length / 4, lineStart: null, lineEnd: null });

  it("renders every chunk once, in place, with its section", () => {
    const group = [mk("a", "First part", "Guide > Intro"), mk("b", "Second part", "Guide > Setup")];
    const user = buildBatchContextMessages(d, group, "background text", "", 30)[1]!.content;
    expect(user).toContain('<chunk id="1" section="Guide > Intro">\nFirst part\n</chunk>');
    expect(user).toContain('<chunk id="2" section="Guide > Setup">\nSecond part\n</chunk>');
    expect(user).not.toContain("<document_start");
    expect(user).toContain("each of the 2 chunk ids");
    expect(buildBatchContextMessages(d, group, "bg", "the opening", 30)[1]!.content).toContain("<document_start");
    expect(buildBatchContextMessages(d, group, "bg", "", 25)[0]!.content).toContain("at most 25 words");
  });

  it("drops a line copied verbatim from the length examples, so it is retried instead of indexed", () => {
    const copied = "Retry and timeout settings for the /v1/dispatch endpoint of the notification-router service.";
    // The examples live in the system prompt, so a copy is proof the model did not read the chunk.
    expect(buildBatchContextMessages(d, [mk("a", "x")], "bg", "", 30)[0]!.content).toContain(copied);
    expect(parseBatchContexts(`1: ${copied}\n2: A genuine context about this chunk.`, 2)).toEqual([null, "A genuine context about this chunk."]);
    // Case and trailing punctuation must not smuggle it through.
    expect(parseBatchContexts(`1: ${copied.toUpperCase()}`, 1)).toEqual([null]);
  });

  it("parses numbered lines, tolerates decoration, and reports the ids the model dropped", () => {
    const parsed = parseBatchContexts("1: The first chunk explains the setup.\n**2.** The second chunk lists the endpoints.\n[4] The fourth chunk is about tests.", 4);
    expect(parsed[0]).toBe("The first chunk explains the setup.");
    expect(parsed[1]).toBe("The second chunk lists the endpoints.");
    expect(parsed[2]).toBeNull();
    expect(parsed[3]).toBe("The fourth chunk is about tests.");
    // Preamble, thinking and out-of-range ids are ignored; a truncated last line is dropped as too short.
    expect(parseBatchContexts("<think>plan</think>\nHere you go:\n1: A real context sentence here.\n9: out of range\n2: sh", 2)).toEqual([
      "A real context sentence here.",
      null,
    ]);
  });

  it("groups chunks up to the character budget, never splitting one", () => {
    const cs = [mk("a", "x".repeat(90)), mk("b", "y".repeat(90)), mk("c", "z".repeat(90))];
    expect(groupChunks(cs, 200).map((g) => g.length)).toEqual([2, 1]);
    expect(groupChunks(cs, 10_000)).toHaveLength(1);
    expect(groupChunks([mk("a", "x".repeat(500))], 100)).toHaveLength(1);
    expect(groupChunks([], 100)).toEqual([]);
  });
});

describe("Contextualizer", () => {
  const tmp = mkdtemp(path.join(os.tmpdir(), "ctx-"));
  afterAll(async () => rm(await tmp, { recursive: true, force: true }));

  const paras = Array.from({ length: 12 }, (_, i) => `Section ${i}: the quick brown fox jumps over the lazy dog number ${i}, repeatedly and at length.`);
  const d = doc(paras.join("\n\n"), "doc", { project: "oneplatform/islands/registry", file_path: "docs/guide.md" });
  const chunks = chunkDocument(d, { targetTokens: 60, maxTokens: 100, overlapTokens: 0 });

  it("situates a whole document in one call and then serves from cache", async () => {
    const calls: string[] = [];
    const complete: CompleteFn = async (messages) => {
      calls.push(messages.at(-1)!.content);
      return batchComplete()(messages, { model: "m", numCtx: 0, maxTokens: 0 });
    };
    const cache = new ContextCache(await tmp);
    const c = new Contextualizer(complete, cache, { ...opts, maxDocChars: 5000 });
    expect(chunks.length).toBeGreaterThan(2);
    const r1 = await c.contextualize(d, chunks, card);
    // One call for the whole document, not one per chunk: that is the entire point of the batch prompt.
    expect(r1.llmCalls).toBe(1);
    expect(r1.retries).toBe(0);
    expect(r1.failures).toBe(0);
    expect(r1.contexts).toHaveLength(chunks.length);
    expect(r1.contexts[0]).toMatch(/^Situates: Section 0/);
    expect(r1.contexts.at(-1)).toMatch(/^Situates: Section/);
    const first = calls[0]!;
    expect(first.indexOf("<background>")).toBeLessThan(first.indexOf("<document"));
    expect(first).toContain('path="docs/guide.md"');
    // Every chunk appears exactly once, in order, inside the single rendered document.
    expect([...first.matchAll(/<chunk id="\d+"/g)]).toHaveLength(chunks.length);

    const r2 = await new Contextualizer(complete, cache, { ...opts, maxDocChars: 5000 }).contextualize(d, chunks, card);
    expect(r2.llmCalls).toBe(0);
    expect(r2.cacheHits).toBe(chunks.length);
    expect(r2.contexts).toEqual(r1.contexts);
  });

  it("re-asks one by one for the ids the batch skipped", async () => {
    const seen: string[] = [];
    // Answers every id but the second, which must come back through a single-chunk retry.
    const flaky: CompleteFn = async (messages) => {
      const user = messages.at(-1)!.content;
      seen.push(user);
      if (/<chunk>/.test(user)) return "Retried context for the missing chunk";
      return [...user.matchAll(/<chunk id="(\d+)"[^>]*>\n([\s\S]*?)\n<\/chunk>/g)]
        .filter((m) => m[1] !== "2")
        .map((m) => `${m[1]}: Situates: ${m[2]!.slice(0, 12)}`)
        .join("\n");
    };
    // A cache of its own: the test above already stored this document's contexts under `tmp`.
    const cache = new ContextCache(path.join(await tmp, "retry"));
    const r = await new Contextualizer(flaky, cache, { ...opts, maxDocChars: 5000 }).contextualize(d, chunks, card);
    expect(r.retries).toBe(1);
    expect(r.llmCalls).toBe(2); // the batch + one retry
    expect(r.failures).toBe(0);
    expect(r.contexts[1]).toBe("Retried context for the missing chunk");
    expect(seen[1]).toContain("<chunk>"); // the retry uses the single-chunk prompt
  });

  it("uses the per-kind group budget for dense kinds", async () => {
    const calls: number[] = [];
    const complete: CompleteFn = async (m) => {
      calls.push([...m.at(-1)!.content.matchAll(/<chunk id="\d+"/g)].length);
      return batchComplete()(m, { model: "m", numCtx: 0, maxTokens: 0 });
    };
    const spec = doc(paras.join("\n\n"), "api", { entity: "default/api/x" }, "devportal");
    const o = { ...opts, groupChars: 10_000, groupCharsByKind: { api: 200 } };
    await new Contextualizer(complete, null, o).contextualize(spec, chunks, card);
    expect(calls.length).toBeGreaterThan(1); // the api budget applied, not the 10 000 default
    calls.length = 0;
    await new Contextualizer(complete, null, o).contextualize(d, chunks, card);
    expect(calls).toHaveLength(1); // a "doc" still gets the default budget
  });

  it("splits a document into groups that fit the prompt", async () => {
    let calls = 0;
    const complete: CompleteFn = async (m) => (calls++, batchComplete()(m, { model: "m", numCtx: 0, maxTokens: 0 }));
    const big = doc(paras.join("\n\n"), "doc", { project: "oneplatform/islands/registry" });
    const r = await new Contextualizer(complete, null, { ...opts, groupChars: 200 }).contextualize(big, chunks, card);
    expect(calls).toBeGreaterThan(1);
    expect(r.failures).toBe(0);
    expect(r.contexts.every((x) => x.startsWith("Situates:"))).toBe(true);
  });

  it("falls back to the deterministic context on model failure and for single-chunk / non-LLM kinds", async () => {
    const failing: CompleteFn = async () => {
      throw new Error("ollama down");
    };
    const c = new Contextualizer(failing, null, opts);
    const r = await c.contextualize(d, chunks, card);
    expect(r.failures).toBe(chunks.length);
    expect(r.retries).toBe(chunks.length);
    expect(r.contexts.every((x) => x.startsWith('Document "Guide" (docs/guide.md) of the registry repository'))).toBe(true);

    const single = chunkDocument(doc("Short text that fits in one chunk."), { targetTokens: 400, maxTokens: 700, overlapTokens: 0 });
    let called = 0;
    const counting: CompleteFn = async () => (called++, "1: ctx");
    const r2 = await new Contextualizer(counting, null, opts).contextualize(d, single, card);
    expect(called).toBe(0);
    expect(r2.contexts).toHaveLength(1);
    const cardDoc = doc(card, "project", { project: "oneplatform/islands/registry" });
    await new Contextualizer(counting, null, opts).contextualize(cardDoc, chunkDocument(cardDoc, { targetTokens: 30, maxTokens: 60, overlapTokens: 0 }), card);
    expect(called).toBe(0);
  });

  it("builds a prompt whose document window respects maxDocChars", () => {
    const msgs = buildContextMessages(d, chunks.at(-1)!, card, 300);
    const user = msgs[1]!.content;
    const docPart = user.slice(user.indexOf("<document"), user.indexOf("</document>"));
    expect(docPart.length).toBeLessThan(300 + 200);
  });
});
