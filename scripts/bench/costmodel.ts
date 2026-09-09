// Runs the REAL Contextualizer over a sample and reports the cost model per kind:
// prefill tokens, generated tokens, and the seconds each contributes.
import { config } from "../../src/config.js";
import { listMarkdownFiles, loadDocument } from "../../src/ingest/loader.js";
import { chunkDocument } from "../../src/ingest/chunker.js";
import { buildBackground, Contextualizer, ProjectCards, type CompleteFn } from "../../src/ingest/contextualize.js";
import { fmt } from "./lib.js";

const host = process.env["OLLAMA_HOST"] ?? "http://127.0.0.1:11434";
const model = process.env["BENCH_MODEL"] ?? "qwen3:1.7b";
const every = Number(process.env["BENCH_EVERY"] ?? 120);
const kinds = (process.env["BENCH_KINDS"] ?? "doc,code,api").split(",");

let promptTok = 0, genTok = 0, promptMs = 0, genMs = 0, calls = 0;
const complete: CompleteFn = async (messages, o) => {
  const r = await fetch(`${host}/api/chat`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false, think: false, keep_alive: "30m",
      options: { temperature: 0, num_ctx: o.numCtx, num_predict: o.maxTokens } }) });
  const j = await r.json() as any;
  promptTok += j.prompt_eval_count ?? 0; genTok += j.eval_count ?? 0;
  promptMs += (j.prompt_eval_duration ?? 0) / 1e6; genMs += (j.eval_duration ?? 0) / 1e6; calls++;
  return j.message?.content ?? "";
};

const opts = { model, numCtx: config.context.numCtx, maxDocChars: config.context.maxDocChars,
  maxBackgroundChars: config.context.maxBackgroundChars, maxTokens: config.context.maxTokens,
  kinds: config.context.kinds, groupChars: config.context.groupChars, maxWords: config.context.maxWords,
  minChunks: config.context.minChunks, minChunksByKind: config.context.minChunksByKind };
const ctx = new Contextualizer(complete, null, opts);

const files = await listMarkdownFiles(config.kbDir);
const cards = new ProjectCards(config.kbDir);
const per: Record<string, { docs: number; chunks: number; ms: number; prompt: number; gen: number; retries: number; fails: number }> = {};
const t0 = Date.now();
for (let i = 0; i < files.length; i += every) {
  const doc = await loadDocument(config.kbDir, files[i]!);
  if (!kinds.includes(doc.meta.kind)) continue;
  const chunks = chunkDocument(doc, config.chunking);
  if (!ctx.usesModel(doc, chunks.length)) continue;
  const project = typeof doc.frontmatter["project"] === "string" ? (doc.frontmatter["project"] as string) : null;
  const bg = buildBackground(doc, project ? await cards.bodyFor(project) : null, config.context.maxBackgroundChars);
  const p0 = promptTok, g0 = genTok, t = Date.now();
  const r = await ctx.contextualize(doc, chunks, bg);
  const k = per[doc.meta.kind] ??= { docs: 0, chunks: 0, ms: 0, prompt: 0, gen: 0, retries: 0, fails: 0 };
  k.docs++; k.chunks += chunks.length; k.ms += Date.now() - t; k.prompt += promptTok - p0; k.gen += genTok - g0;
  k.retries += r.retries; k.fails += r.failures;
}
console.log(`model=${model} groupChars=${config.context.groupChars} maxWords=${config.context.maxWords} minChunks=${config.context.minChunks}/code=${config.context.minChunksByKind["code"]}`);
console.log("kind   docs chunks   s/chunk  prompt tok/chunk  gen tok/chunk  retries  fallbacks");
let C = 0, S = 0;
for (const [k, v] of Object.entries(per)) {
  C += v.chunks; S += v.ms;
  console.log(`${k.padEnd(5)} ${String(v.docs).padStart(5)} ${String(v.chunks).padStart(6)}  ${fmt(v.ms / v.chunks / 1000).padStart(8)}  ${String(Math.round(v.prompt / v.chunks)).padStart(16)}  ${String(Math.round(v.gen / v.chunks)).padStart(13)}  ${String(v.retries).padStart(7)}  ${String(v.fails).padStart(9)}`);
}
console.log(`ALL   ${String(C).padStart(12)}  ${fmt(S / C / 1000).padStart(8)}`);
console.log(`prefill ${fmt(promptTok / (promptMs / 1000), 0)} tok/s over ${promptTok} tok (${fmt(promptMs / 1000)}s) | decode ${fmt(genTok / (genMs / 1000), 0)} tok/s over ${genTok} tok (${fmt(genMs / 1000)}s) | ${calls} calls | wall ${fmt((Date.now() - t0) / 1000)}s`);
