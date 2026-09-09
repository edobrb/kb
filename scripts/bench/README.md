# Ingest benchmarks

The measurement tools behind the ingest tuning in [§10 of the README](../../README.md#10-tuning-guide).
They read the real `kb/` and the real `.env`, so re-run them after changing a model or a `CONTEXT_*` dial
instead of trusting the numbers below — they were taken on one Apple M5 Pro / 24 GB with Ollama 0.33.

Nothing here is part of the pipeline; `npm run ingest` does not import any of it.

| Script | Answers |
|---|---|
| `decode.ts` | Does generation get faster with more requests in flight? (On Metal: no — aggregate throughput is a constant per model.) |
| `embed.ts` | Chunks/second per embedding model and batch size, extrapolated to the whole KB. |
| `costmodel.ts` | Runs the real `Contextualizer` over a KB sample and splits the cost per document kind into prefill, decode, retries. |
| `gen-questions.ts` + `score-retrieval.ts` | Retrieval A/B without hand-labelling: ask the chat model for a question each chunk answers, then check whether that chunk comes back. Ground truth is the chunk id. |

```bash
# Which model to embed with, and what it costs
npx tsx scripts/bench/embed.ts                       # BENCH_EMB_MODEL=...

# Where the contextualizer's time goes (BENCH_EVERY = sample 1 file in N)
BENCH_EVERY=110 npx tsx scripts/bench/costmodel.ts   # BENCH_MODEL=..., or any CONTEXT_* env var

# Does a change to chunking / contexts / the embedder help or hurt retrieval?
#   Build two indexes over the same KB_DIR into different DATA_DIRs, then:
KB_DIR=… BENCH_N=300 npx tsx scripts/bench/gen-questions.ts questions.json
KB_DIR=… DATA_DIR=…  npx tsx scripts/bench/score-retrieval.ts questions.json
```

`score-retrieval.ts` measures hit@k of the *chunk the question was written from*, which rewards lexical
overlap with the chunk body. Read it as a regression guard on a change, not as an absolute quality score,
and keep `n` large enough for the difference you care about (n=300 gives roughly ±1.5 pp).
