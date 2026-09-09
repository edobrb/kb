import { sample, pool, fmt } from "./lib.js";
import { composeChunkText } from "../../src/ingest/chunker.js";
const host = process.env["OLLAMA_HOST"] ?? "http://127.0.0.1:11435";
const model = process.env["BENCH_EMB_MODEL"] ?? "qwen3-embedding:8b";

const docs = [...await sample("doc", 12), ...await sample("code", 12)];
const texts = docs.flatMap((s) => s.chunks.map((c) => composeChunkText(c.headingPath, "A short generated context sentence that situates this chunk inside its document and project.", c.content))).slice(0, 256);
const chars = texts.reduce((a, t) => a + t.length, 0) / texts.length;
console.log(`model=${model}  ${texts.length} chunks, avg ${Math.round(chars)} chars (~${Math.round(chars / 4)} tok)`);

const embed = (batch: string[]) => async () => {
  const r = await fetch(`${host}/api/embed`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: batch, truncate: true, keep_alive: "30m" }) });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const j = await r.json() as any;
  return j.embeddings.length as number;
};
await embed(texts.slice(0, 4))();  // warm / load

for (const [bs, conc] of [[8, 1], [16, 1], [32, 1], [64, 1], [16, 2], [16, 4], [32, 2]] as [number, number][]) {
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += bs) batches.push(texts.slice(i, i + bs));
  const { ms } = await pool(batches.map(embed), conc);
  console.log(`batch=${String(bs).padStart(2)} conc=${conc}  wall ${fmt(ms / 1000)}s  ${fmt(texts.length / (ms / 1000), 1)} chunks/s  -> 113910 chunks in ${fmt(113910 / (texts.length / (ms / 1000)) / 3600)} h`);
}
