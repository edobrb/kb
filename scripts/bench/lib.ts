import { config } from "../../src/config.js";
import { listMarkdownFiles, loadDocument } from "../../src/ingest/loader.js";
import { chunkDocument } from "../../src/ingest/chunker.js";
import { buildBackground, ProjectCards } from "../../src/ingest/contextualize.js";
import type { ChatMessage, Document, Chunk } from "../../src/types.js";

export interface Sample { doc: Document; chunks: Chunk[]; background: string }

/** N multi-chunk documents of the given kind, spread across the kb (deterministic pseudo-random pick). */
export async function sample(kind: string, n: number, kbDir = config.kbDir): Promise<Sample[]> {
  const files = await listMarkdownFiles(kbDir);
  const cards = new ProjectCards(kbDir);
  const out: Sample[] = [];
  // Deterministic stride so we touch many different repos rather than one folder.
  const stride = Math.max(1, Math.floor(files.length / (n * 40)));
  for (let i = 0; i < files.length && out.length < n; i += stride) {
    const doc = await loadDocument(kbDir, files[i]!);
    if (doc.meta.kind !== kind) continue;
    const chunks = chunkDocument(doc, config.chunking);
    if (chunks.length < 2) continue;
    const project = typeof doc.frontmatter["project"] === "string" ? (doc.frontmatter["project"] as string) : null;
    const background = buildBackground(doc, project ? await cards.bodyFor(project) : null, config.context.maxBackgroundChars);
    out.push({ doc, chunks, background });
  }
  return out;
}

export interface CallStats { ms: number; promptTokens: number; genTokens: number; text: string }

/** Non-streaming /api/chat, returns timings + token counts from the Ollama response. */
export async function chatOnce(messages: ChatMessage[], o: { model: string; numCtx: number; maxTokens: number }): Promise<CallStats> {
  const t = Date.now();
  const res = await fetch(`${config.ollama.host}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: o.model, messages, stream: false, think: false, keep_alive: "30m",
      options: { temperature: 0, num_ctx: o.numCtx, num_predict: o.maxTokens },
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const j = await res.json() as any;
  return { ms: Date.now() - t, promptTokens: j.prompt_eval_count ?? 0, genTokens: j.eval_count ?? 0, text: j.message?.content ?? "" };
}

/** Run `tasks` with at most `n` in flight; returns wall-clock ms and the results. */
export async function pool<T>(tasks: (() => Promise<T>)[], n: number): Promise<{ ms: number; results: T[] }> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const t = Date.now();
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]!();
    }
  }));
  return { ms: Date.now() - t, results };
}

export const fmt = (n: number, d = 2) => n.toFixed(d);
