// Synthetic retrieval benchmark: ask the chat model for a question answerable only from a given chunk,
// then check whether that chunk comes back. Ground truth is the chunk id, so no hand-labelling.
import { writeFile } from "node:fs/promises";
import { config } from "../../src/config.js";
import { listMarkdownFiles, loadDocument } from "../../src/ingest/loader.js";
import { chunkDocument } from "../../src/ingest/chunker.js";
import { chatOnce } from "./lib.js";

const out = process.argv[2] ?? "questions.json";
const want = Number(process.env["BENCH_N"] ?? 80);
const model = process.env["BENCH_JUDGE"] ?? "qwen3:8b";

const files = await listMarkdownFiles(config.kbDir);
const pool: { id: string; kind: string; relPath: string; heading: string; content: string }[] = [];
for (const rel of files) {
  const doc = await loadDocument(config.kbDir, rel);
  if (doc.meta.kind === "project") continue;
  for (const c of chunkDocument(doc, config.chunking)) {
    if (c.content.length > 400) pool.push({ id: c.id, kind: doc.meta.kind, relPath: doc.meta.relPath, heading: c.headingPath, content: c.content });
  }
}
// Deterministic spread over the pool rather than a random sample, so reruns compare like with like.
const stride = Math.max(1, Math.floor(pool.length / want));
const picked = pool.filter((_, i) => i % stride === 0).slice(0, want);
console.log(`${pool.length} candidate chunks -> ${picked.length} questions with ${model}`);

const qs: { chunkId: string; kind: string; question: string; relPath: string }[] = [];
for (const [i, c] of picked.entries()) {
  const { text } = await chatOnce(
    [
      { role: "system", content: "You write realistic questions an engineer would type into an internal documentation search. Answer with the question only — one line, no preamble, no quotes." },
      { role: "user", content: `<passage source="${c.relPath}" section="${c.heading}">\n${c.content.slice(0, 2500)}\n</passage>\n\nWrite ONE specific question that this passage answers and that a colleague could plausibly ask without having read it. Name the concrete system, endpoint, file or concept involved so the question stands on its own. Do not mention "the passage" or "the document".` },
    ],
    { model, numCtx: 8192, maxTokens: 80 },
  );
  const q = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^["'\s]+|["'\s]+$/g, "").split("\n").filter(Boolean)[0] ?? "";
  if (q.length > 15) qs.push({ chunkId: c.id, kind: c.kind, question: q, relPath: c.relPath });
  if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${picked.length}`);
}
await writeFile(out, JSON.stringify(qs, null, 2));
console.log(`wrote ${qs.length} questions to ${out}`);
