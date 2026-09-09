// Is decode actually batched on Metal? Tiny prompt, long generation -> pure decode.
import { pool, fmt } from "./lib.js";
const host = process.env["OLLAMA_HOST"] ?? "http://127.0.0.1:11435";
const model = process.env["BENCH_MODEL"] ?? "qwen3:8b";
const gen = Number(process.env["BENCH_GEN"] ?? 200);
const promptTok = Number(process.env["BENCH_PROMPT"] ?? 20);

const filler = "alpha beta gamma delta ".repeat(Math.ceil(promptTok / 4));
const call = (i: number) => async () => {
  const t = Date.now();
  const r = await fetch(`${host}/api/chat`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream: false, think: false, keep_alive: "30m",
      // distinct prefix per request => no cross-slot prefix cache sharing
      messages: [{ role: "user", content: `Request ${i}. ${filler}\nWrite a long paragraph about distributed systems.` }],
      options: { temperature: 0.7, seed: i, num_ctx: 8192, num_predict: gen } }) });
  const j = await r.json() as any;
  return { ms: Date.now() - t, gen: j.eval_count ?? 0, prompt: j.prompt_eval_count ?? 0 };
};

console.log(`model=${model} num_predict=${gen} prompt~${promptTok}tok`);
for (const c of [1, 2, 4, 8, 16]) {
  const tasks = Array.from({ length: c * 3 }, (_, i) => call(i + c * 1000));
  const { ms, results } = await pool(tasks, c);
  const g = results.reduce((a, r) => a + r.gen, 0);
  console.log(`conc=${String(c).padStart(2)}  wall ${fmt(ms / 1000)}s  aggregate ${fmt(g / (ms / 1000), 1)} gen-tok/s  per-request ${fmt(g / results.length / (results.reduce((a, r) => a + r.ms, 0) / results.length / 1000), 1)} tok/s`);
}
