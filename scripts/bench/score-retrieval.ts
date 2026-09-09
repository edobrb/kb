import { readFile } from "node:fs/promises";
import { Retriever } from "../../src/retrieval/retriever.js";
import { config } from "../../src/config.js";
import { fmt } from "./lib.js";

const qs = JSON.parse(await readFile(process.argv[2] ?? "questions.json", "utf8")) as { chunkId: string; kind: string; question: string }[];
const r = await Retriever.open();
const stats = await r.stats();
const K = Number(process.env["BENCH_K"] ?? 6);
let hit = 0, mrr = 0;
const byKind: Record<string, { n: number; hit: number }> = {};
for (const q of qs) {
  const res = await r.retrieve(q.question, { topK: K, candidates: 24 });
  const rank = res.findIndex((x) => x.id === q.chunkId);
  const k = (byKind[q.kind] ??= { n: 0, hit: 0 });
  k.n++;
  if (rank >= 0) { hit++; mrr += 1 / (rank + 1); k.hit++; }
}
console.log(
  `${config.embedding.model} @${stats.dimensions}d over ${stats.chunks} chunks: ` +
  `hit@${K} ${fmt((100 * hit) / qs.length, 1)}%  MRR ${fmt(mrr / qs.length, 3)}  (n=${qs.length})  ` +
  Object.entries(byKind).map(([k, v]) => `${k} ${fmt((100 * v.hit) / v.n, 0)}%`).join(" "),
);
