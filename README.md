# ai-wiki RAG

A fully local **Retrieval-Augmented Generation** system over the TeamSystem knowledge base in `kb/`.
Ask a question in Italian or English, get an answer generated **only** from the documents, with numbered
citations linking back to the Confluence page, ADR or repository file the answer came from.

Everything runs on one Mac (24 GB unified memory is plenty): **Node.js/TypeScript** for the pipeline,
**Ollama** for the models (`Qwen3-Embedding-8B` for embeddings, `qwen3:8b` for answers),
**LanceDB** as an embedded vector database, and an in-process **BM25** index for keyword search.
No cloud services, no Docker, no database server — the index is just a folder (`data/`).

---

## Table of contents

1. [Why RAG instead of fine-tuning](#1-why-rag-instead-of-fine-tuning)
2. [Architecture](#2-architecture)
3. [Quick start](#3-quick-start)
4. [Commands](#4-commands)
5. [HTTP API](#5-http-api)
6. [Web UI](#6-web-ui)
7. [How each stage works](#7-how-each-stage-works)
8. [Configuration](#8-configuration)
9. [Evaluation](#9-evaluation)
10. [Tuning guide](#10-tuning-guide)
11. [Project layout](#11-project-layout)
12. [Troubleshooting](#12-troubleshooting)
13. [Roadmap / ideas](#13-roadmap--ideas)

---

## 1. Why RAG instead of fine-tuning

The original question was: *can we fine-tune an open-source LLM on company data so it "knows" everything
in its weights?* Technically yes, practically no:

| | Fine-tuning | RAG (this project) |
|---|---|---|
| What it teaches the model | *How to behave* (tone, format, jargon) | Nothing — the model **reads** the real text at answer time |
| Facts | Stored fuzzily; the model confidently fills gaps with wrong dates/names/values | Quoted from the source chunk; verifiable |
| Updating a document | Retrain (hours, GPU) | `npm run ingest` (seconds for the changed files) |
| "Where did this answer come from?" | Impossible | Every sentence cites `[n]` → URL |
| Access control | None | Filter what a user may retrieve (metadata filters are built in) |
| Cost | GPU time + synthetic data generation | CPU/GPU inference only |

So the model stays generic and the **knowledge lives in the index**. If we ever want the model to sound more
"TeamSystem" (terminology, answer format), a light LoRA on a few hundred Q&A examples can be added later
on top of this — the two approaches compose.

## 2. Architecture

```
                OFFLINE (npm run ingest)                          ONLINE (npm run ask / serve)
 ┌──────────────────────────────────────────────┐   ┌───────────────────────────────────────────────┐
 │ kb/**/*.md                                   │   │ question (+ chat history)                     │
 │   │  parse YAML frontmatter                  │   │   │  optional: rewrite follow-up into a       │
 │   ▼  (source_id, title, url, authority…)     │   │   ▼  standalone query (chat model)            │
 │ Document                                     │   │ search query                                  │
 │   │  heading-aware chunking (~450 tok)       │   │   ├──► embed query (Qwen3-Embedding-8B)       │
 │   ▼  + "Title > H2 > H3" breadcrumb          │   │   │      └► LanceDB cosine search  ─┐         │
 │ Chunks                                       │   │   └──► BM25 keyword search  ────────┤         │
 │   │  embed (Ollama /api/embed, batched)      │   │                                     ▼         │
 │   ▼                                          │   │        Reciprocal Rank Fusion + authority     │
 │ LanceDB table  data/lancedb/  (vectors+text) │   │        boost + per-document cap → top-k       │
 │ BM25 index     data/bm25.json.gz             │   │                                     │         │
 │ Manifest       data/manifest.json (hashes)   │   │   prompt = rules + numbered context + history  │
 └──────────────────────────────────────────────┘   │        └► Ollama /api/chat (qwen3:8b, stream)  │
                                                    │ answer with [n] citations + sources           │
                                                    └───────────────────────────────────────────────┘
```

Two pipelines share one codebase:

* **Ingest** (offline, idempotent, incremental): reads `kb/`, chunks, embeds, writes the index.
* **Ask** (online): retrieves the best chunks with *hybrid* search and streams an answer.
  It is exposed three ways — CLI, HTTP/SSE API, and a small web chat UI — all using the same
  `ask()` generator in `src/generation/ask.ts`.

## 3. Quick start

### Prerequisites

* macOS on Apple Silicon (tested target: 24 GB unified memory), **Node.js ≥ 22** (`nvm install 22`)
* [Ollama](https://ollama.com) installed and running (`ollama serve`, or the menu-bar app)

### Install

```bash
cd ~/Desktop/ai-wiki          # this folder: contains kb/ and this project
npm install
cp .env.example .env          # defaults are fine for a first run

# Pull the models (≈ 5 GB each, once). Or run: ./scripts/setup-ollama.sh
ollama pull qwen3-embedding:8b
ollama pull qwen3:8b

npm run doctor                # checks Ollama, models, kb/ folder, index state
```

### Index the knowledge base

```bash
npm run ingest
```

The first run embeds every chunk (~15 000 chunks for the current `kb/`; expect **15–30 minutes** on an
M-series Mac with the 8B embedding model — see [Tuning](#10-tuning-guide) for a faster model while
iterating). Subsequent runs only touch files whose bytes changed and take seconds.

### Ask

```bash
npm run ask -- "How must platform APIs represent HTTP errors according to ADR0016?"
npm run ask -- "Come funziona il social login in TSID?"
npm run serve                 # then open http://127.0.0.1:8787
```

## 4. Commands

| Command | What it does |
|---|---|
| `npm run ingest` | Incremental index of `KB_DIR`. Flags: `--reset` (rebuild all), `--dry-run` (chunk stats + samples, no embedding), `--only <substring>` (subset of files), `--kb <dir>` |
| `npm run ask -- "question"` | Full pipeline, streams the answer to the terminal, prints cited sources and timings. Flags: `--k 8`, `--source-type adr,confluence`, `--authority binding`, `--lang en`, `--json` |
| `npm run search -- "query"` | **Retrieval only** (no LLM): shows fused rank, vector rank, BM25 rank and text of each chunk. The main debugging tool — most RAG problems are retrieval problems. |
| `npm run serve` | Starts the HTTP API + web UI on `HOST:PORT` (default `127.0.0.1:8787`) |
| `npm run eval` | Retrieval metrics (hit@k, MRR) over `evals/questions.jsonl`; `--answers` also grades answers by expected keywords |
| `npm run doctor` | Environment check: Ollama reachable, models pulled, kb/ present, index consistency, facets |
| `npm test` / `npm run typecheck` | Unit tests (vitest) / `tsc --noEmit` |

## 5. HTTP API

All endpoints accept/return JSON. Filters are optional everywhere:
`{ "filters": { "sourceTypes": ["adr"], "authorities": ["binding"], "langs": ["en"] } }`.

### `POST /api/ask` — streaming (Server-Sent Events)

```bash
curl -N -X POST http://127.0.0.1:8787/api/ask \
  -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"What are the data store tiers?"}],"topK":6}'
```

Events, in order: `status` (progress text) → `sources` (numbered citations, sent **before** generation so
the UI can show them immediately) → `thinking` (many, only when reasoning is on) → `token` (many) →
`done` (`answer`, `thinking`, `usedCitations`, `timings`) or `error`. Comment frames (`: ping`) are sent
every 15 s to keep the connection alive; ignore them. Send the whole conversation in `messages` for
follow-up questions; the server rewrites the last question into a standalone search query using the history.

Add `"think": true` to stream the model's reasoning as `thinking` events (works with reasoning models such
as Qwen3); omit it to use the `CHAT_THINK` default. Generation is aborted only when the client actually
disconnects, so a closed tab stops the model.

### `POST /api/ask/sync` — same, non-streaming

```bash
curl -s -X POST http://127.0.0.1:8787/api/ask/sync -H 'content-type: application/json' \
  -d '{"question":"What are the data store tiers?"}'
# → { "answer": "...[1]...", "thinking": "", "citations": [...], "usedCitations": [1], "timings": {...} }
```

### `POST /api/search` — retrieval only

`{"query":"client credentials M2M","topK":10,"filters":{...}}` → `{ results: RetrievedChunk[] }`.
Use this from other tools (or another LLM) when you just want the relevant passages.

### `POST /api/ingest` — re-index

`{"reset": false}` runs an incremental ingest and hot-swaps the index. Returns the ingest report. 409 if
an ingest is already running.

### `GET /api/health`, `GET /api/facets`

Index size, models in use; distinct `source_type` / `authority` / `lang` values with counts.

## 6. Web UI

`npm run serve` and open <http://127.0.0.1:8787>. Single static file (`src/server/public/index.html`, no build
step, no framework): answers streamed token by token, a **Reasoning** button that streams the model's
thinking into a collapsible panel above the answer, clickable `[n]` citations that jump to the source,
source cards with title → original URL, source-type and authority badges, expandable passage, source-type
filter chips, multi-turn conversation, and a **Re-index** button. Auto-scroll follows the stream but stops
as soon as you scroll up to read.

## 7. How each stage works

### 7.1 Loading & metadata (`src/ingest/loader.ts`)

Every file in `kb/` carries a YAML frontmatter produced by the upstream normalisation workflow. We use:

| Frontmatter | Used for |
|---|---|
| `source_id` | Stable chunk ids (`<source_id>::<n>`), incremental delete/replace |
| `source_type` (`confluence`, `git-md`, `adr`, `manually-curated`) | Filtering (`--source-type`, UI chips) |
| `title`, `source_url` | Breadcrumb in every chunk, citation links |
| `authority` (`binding` / `normative` / `descriptive`) | Retrieval boost (+15 % / +12 %) and a prompt rule to prefer binding docs on conflict |
| `lang` | Filtering |
| `last_modified` / `fetched_at` | Shown in metadata |

Files without frontmatter still work (title from the first `#` heading, source type from the folder name).
HTML comments (`<!-- confluence-page-id -->`) are stripped. Change detection uses the **sha256 of the file
bytes**, so a manual edit is always picked up even if `body_hash` in the frontmatter was not updated.

### 7.2 Chunking (`src/ingest/chunker.ts`)

Chunk quality decides answer quality, so the chunker is markdown-aware rather than "every 1000 characters":

* The body is parsed into blocks — headings, fenced code, tables, paragraphs/lists — while tracking the
  heading stack.
* Blocks are packed into chunks of about **450 tokens** (max 700), preferring to break at headings; a break
  mid-section carries the last small block over as overlap.
* Oversized tables are split **with the header row repeated**; oversized code keeps its fences.
* Each chunk's embedding text is prefixed with a breadcrumb `Title > H2 > H3` so it is self-describing when
  read out of context ("Decision" alone means nothing; "ADR0010 Client Credentials > Summary > Decision" does).
* Heading-only pages produce no chunks (they are logged and skipped).

`npm run ingest -- --dry-run` prints size statistics and sample chunks so you can see the effect of the
`CHUNK_*` settings before spending embedding time.

### 7.3 Embeddings (`src/llm/embeddings.ts`)

[Qwen3-Embedding-8B](https://huggingface.co/Qwen/Qwen3-Embedding-8B) via Ollama (`qwen3-embedding:8b`),
4096 dimensions, multilingual (Italian + English in the same space), 32k context. Two model-specific details:

* It is **instruction-aware**: queries are embedded as `Instruct: <task>\nQuery: <question>`; documents are
  embedded as-is. Getting this asymmetry right is worth several points of recall.
* It is **Matryoshka-trained**: the first N dimensions are themselves a good embedding. `EMBEDDING_DIMENSIONS=1024`
  cuts the vector index to a quarter with a small quality loss (we truncate + renormalise client-side).

Chunks are embedded in batches (`EMBED_BATCH_SIZE`) through `/api/embed`; the manifest is written after each
document, so an interrupted ingest resumes where it stopped.

### 7.4 Storage (`src/store/`)

* **LanceDB** (`data/lancedb/`): embedded, file-based, Apache Arrow columns, native Apple-Silicon binary.
  One table `chunks` with the vector plus all metadata columns, so filters are plain SQL-like predicates
  (`source_type IN ('adr')`). No ANN index is created: with tens of thousands of vectors a brute-force cosine
  scan is a few milliseconds and exact.
* **BM25** (`data/bm25.json.gz`): a ~150-line Okapi BM25 implementation. Tokeniser lower-cases, folds accents
  (`perché` → `perche`), drops Italian/English stopwords and splits alphanumeric codes so `ADR0010`, `ADR 0010`
  and `adr-0010` all match. It is rebuilt from the LanceDB table after every ingest, so the two can never drift.

### 7.5 Hybrid retrieval (`src/retrieval/retriever.ts`)

1. Vector search and BM25 each return `RETRIEVAL_CANDIDATES` (24) chunks.
2. **Reciprocal Rank Fusion** merges the two lists: `score = Σ weight / (60 + rank)`. RRF needs no score
   calibration between the two systems and is robust in practice.
3. Multiply by the authority boost; cap at `RETRIEVAL_MAX_CHUNKS_PER_DOC` (3) chunks per document so one long
   page cannot fill the whole context.
4. Keep `RETRIEVAL_TOP_K` (6).
5. Optional (`RERANK=llm`): ask the chat model to score each of the top 3·k candidates 0–10 and re-sort.
   Slower (one short generation per candidate) but noticeably more precise on ambiguous questions.

Why hybrid: embeddings understand paraphrase ("come si ottiene un token machine-to-machine" ≈ "M2M client
credentials flow") but are weak on exact identifiers; BM25 nails `ADR0016`, `TSPAY`, `X-Correlation-Id` but
knows no synonyms. Together they cover each other's blind spots.

### 7.6 Generation (`src/generation/`)

The system prompt (`prompt.ts`) contains the rules — answer only from context, say when the context does not
cover the question, cite `[n]` after each claim, prefer binding sources, reply in the user's language — followed
by the numbered context blocks (each with its heading path, source type, authority and URL). Previous turns
(last 6) are appended so follow-ups work; the new question comes last.

Generation streams from Ollama `/api/chat`, which returns two kinds of delta: `thinking` (reasoning) and
`content` (the visible answer). Both are forwarded as separate stream events, so the UI can show the
reasoning live in a collapsible panel and the answer token by token underneath. Qwen3 "thinks" before
answering by default; `CHAT_THINK=false` disables it for speed, and the per-request `think` flag (the
**Reasoning** button in the UI) overrides it. After the stream ends we extract which `[n]` the model
actually cited so the UI can dim unused sources.

## 8. Configuration

Everything is an environment variable (`.env`, see `.env.example` for the full annotated list).

| Variable | Default | Notes |
|---|---|---|
| `KB_DIR` / `DATA_DIR` | `./kb` / `./data` | Where the markdown lives / where the index lives |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | |
| `EMBEDDING_MODEL` | `qwen3-embedding:8b` | Any Ollama embedding model; changing it triggers a full rebuild |
| `EMBEDDING_DIMENSIONS` | `4096` | Matryoshka truncation, ≤ model output |
| `CHAT_MODEL` | `qwen3:8b` | Any Ollama chat model (e.g. `ornith-1.5:9b`, `gemma3:12b`, `qwen3:14b`) |
| `CHAT_THINK` | `false` | Default reasoning mode; per request, override with `"think": true` or the UI's **Reasoning** button |
| `CHAT_NUM_CTX` | `16384` | Context window requested from Ollama; 6 chunks × 450 tok + prompt + history fits easily |
| `CHUNK_TARGET_TOKENS` / `CHUNK_MAX_TOKENS` / `CHUNK_OVERLAP_TOKENS` | `450` / `700` / `60` | Changing them triggers a full rebuild |
| `RETRIEVAL_CANDIDATES` / `RETRIEVAL_TOP_K` | `24` / `6` | Candidates per retriever before fusion / chunks sent to the LLM |
| `RETRIEVAL_VECTOR_WEIGHT` / `RETRIEVAL_BM25_WEIGHT` | `1.0` / `1.0` | RRF weights |
| `RETRIEVAL_MAX_CHUNKS_PER_DOC` | `3` | Diversity cap |
| `RERANK` | `none` | `llm` for the LLM rerank stage |
| `QUERY_REWRITE` | `true` | Rewrite follow-ups into standalone queries |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Set `HOST=0.0.0.0` to reach the UI from other machines on the LAN |
| `EMBEDDING_PROVIDER` / `CHAT_PROVIDER` | `ollama` | `mock` runs the whole pipeline without Ollama (tests/CI) |

## 9. Evaluation

The benchmark lives in `evals/questions.jsonl`: **324 questions** written from the actual documents in `kb/`
(304 answerable + 20 that the KB does *not* cover), spread across every source folder, in English and
Italian, from one-line facts to multi-hop questions over two documents. It measures the three things that can go
wrong in a RAG system **separately**, because they need different fixes:

| Layer | Question it answers | Metrics | Fix lives in |
|---|---|---|---|
| **Retrieval** | Is the right document in the top-k chunks? | hit@k, MRR, recall@k (multi-doc), per source type / language / category | chunking, embedding model, BM25/vector weights, authority boost, rerank |
| **Answer** | Given the right context, is the answer correct and does it cite it? | keyword pass, citation hit, LLM-judge correctness (vs. gold answer) and groundedness | system prompt, chat model, context formatting, top-k |
| **Abstention** | Does it say "not covered" when the KB really does not cover it, and *only* then? | abstain pass on negatives, false-abstention rate on answerable questions | system prompt, retrieval score threshold |

Plus latency (p50 retrieve / end-to-end) so a quality gain that doubles response time is visible.

### Dataset format

One JSON object per line; `#` lines are comments. Legacy lines with only `question` + `expected_source_ids` still work.

```json
{"id": "adr-012", "question": "Quale header sostituisce X-Request-Id per la correlazione?", "lang": "it",
 "category": "factual", "difficulty": "medium", "source_type": "adr",
 "expected_source_ids": ["adr:repo-oneplatform-adrs-platform-adr0017-trace-context"],
 "expected_keywords": ["traceparent", "W3C Trace Context"],
 "expected_answer": "L'header traceparent dello standard W3C Trace Context …", "should_abstain": false}
```

* `expected_source_ids` — frontmatter `source_id` of the document(s) that answer it (two for `multi-hop`).
* `expected_keywords` — 1–3 discriminating tokens (codes, names, header/field names, numbers) that a correct answer must
  contain; checked verbatim in the document by the validator, so a renamed page cannot silently break a case.
* `expected_answer` — short gold answer used by the LLM judge.
* `should_abstain: true` — negative case: the KB has no coverage; the correct answer is "the knowledge base does not
  cover this". Half of them are *near-misses* (e.g. "Does Hermes support RabbitMQ?" when only Kafka is documented) to
  catch a model that fills gaps with plausible inventions.
* `category` ∈ factual · definition · procedural · numeric · comparison · yes-no · multi-hop · list · negative;
  `difficulty` ∈ easy · medium · hard; `lang` ∈ en · it.

Ids are prefixed by the slice they came from (`adr-`, `mc-` manually-curated, `cfl-a/b/c-` Confluence, `git-m3-`,
`git-ai-`, `git-data-`, `git-core-` repository docs, `neg-` negatives, `seed-` the original hand-written set), so
`--filter id=cfl-` runs only Confluence questions. `evals/KB-NOTES.md` lists the contradictions, duplicated pages and
stubs found in `kb/` while writing the questions — the usual suspects when a case fails for a "wrong" reason.

### Commands

```bash
npm run eval:validate                 # static check of the dataset against kb/ (no models): ids, source_ids, keywords
npm run eval                          # retrieval only — seconds per question, run after EVERY retrieval change
npm run eval -- --answers             # + generate answers: keyword pass, citation hit, abstention (minutes)
npm run eval -- --judge               # + LLM-as-judge: correctness vs gold answer, groundedness (slow; JUDGE_MODEL)
npm run eval -- --filter lang=it,source_type=confluence --limit 20     # slice; fields: id (prefix), lang, category, difficulty, source_type, should_abstain
npm run eval -- --report              # save evals/reports/<timestamp>.json  (or --report path.json)
npm run eval -- --compare evals/reports/eval-2026-09-08.json           # deltas + per-question regressions vs a saved run
npm run eval -- --k 10 --quiet        # different cut-off, summary table only
```

Output: one line per case (`HIT @2 pass`, `MISS FAIL` with what came back instead, `NEG` for negatives), then a summary
table overall and by source type, language, category and difficulty:

```
group                     n  hit@6     MRR  recall  keywd   cite  abstn   pass
ALL                     ___   ___%   0.___    ___%   ___%   ___%   ___%   ___%
— by source_type
  adr                    ..
```

**What "pass" means** — retrieval-only runs: expected doc in top-k. With `--answers`: keywords present, not abstained
and (with `--judge`) correctness ≥ 1/2; negatives pass when the model abstains. Judge scores: correctness 0–2 against
the gold answer, groundedness 0–2 against the retrieved excerpts (a 2/0 case is a *correct but hallucinated* answer —
the model knew it from pre-training, which is exactly what the system prompt forbids).

### How to use it

1. **Baseline first**: after the first ingest run `npm run eval -- --answers --report` once and keep the JSON.
2. **Retrieval before generation**: a MISS cannot be fixed by prompting. Look at the `got:` line — a near-duplicate page
   ranking above the expected one is a data problem (see `evals/KB-NOTES.md`), a totally unrelated page is a
   chunking/embedding problem, an Italian question missing an English page is a language-gap problem
   (compare the `— by lang` rows).
3. **Change one thing** (chunk size, weights, `RERANK=llm`, model…), re-ingest if needed, run with `--compare` against
   the baseline. The comparison prints deltas in points and the ids that regressed, so a +2 pts average that
   breaks 6 previously-good questions is visible.
4. **Judge sparingly**: `--judge` costs one extra generation per question. Run it on a filter (`--filter difficulty=hard`)
   or on the full set only before a release. Set `JUDGE_MODEL` to a bigger model than the one being evaluated
   whenever possible — a model grading itself is lenient.
5. **Keep the dataset alive**: add real questions from colleagues (a thumbs-down in the UI is a future test case),
   run `npm run eval:validate` whenever `kb/` is re-exported, and mark facts that changed.

Reasonable targets for this KB size: hit@6 ≥ 90 % and MRR ≥ 0.80 on answerable questions, abstain pass ≥ 90 % on
negatives with false abstention ≤ 5 %, judge correctness ≥ 85 %. Below that, tune; above, add harder questions.

## 10. Tuning guide

**Ingest is slow.** The 8B embedding model is the best quality/size trade-off, but while iterating on chunking
use `EMBEDDING_MODEL=qwen3-embedding:0.6b EMBEDDING_DIMENSIONS=1024` (~10× faster), then switch back. Any model
change is detected and rebuilds automatically.

**Memory.** `qwen3-embedding:8b` (~5 GB) and `qwen3:8b` (~5 GB) plus a 16k context fit comfortably in 24 GB.
Ollama unloads idle models after 5 minutes; the first request after idling pays a few seconds of load time.
If you move to a 14B chat model, keep `CHAT_NUM_CTX` at 16k or lower.

**Answers miss things that are in the docs.** Run `npm run search -- "<question>"` and look at the `vec=` /
`bm25=` ranks. If the right chunk is found by only one retriever, adjust the weights. If it is not found at all,
the chunk is probably too big/mixed — lower `CHUNK_TARGET_TOKENS` — or the question uses vocabulary the docs do
not (add a glossary page to `kb/manually-curated`, which is exactly what those files are for).

**Answers hallucinate.** Lower `CHAT_TEMPERATURE` (0–0.2), reduce `RETRIEVAL_TOP_K` so irrelevant chunks do not
dilute the context, or enable `RERANK=llm`.

**Follow-ups retrieve the wrong thing.** Check the `Search query:` status line printed by `ask`; if the rewrite
is poor, disable `QUERY_REWRITE` or improve the prompt in `src/generation/ask.ts`.

**Access control.** `RetrievalFilters` already filters at query time; to enforce permissions, map the caller's
identity to allowed `sourceTypes` (or add a column, e.g. Confluence space) in the API layer before calling
`retriever.retrieve()`.

## 11. Project layout

```
ai-wiki/
├── kb/                          the knowledge base (markdown + frontmatter) — input, never modified
├── data/                        generated index (LanceDB, BM25, manifest) — safe to delete, git-ignored
├── evals/questions.jsonl        evaluation set
├── scripts/setup-ollama.sh      pulls the two models
├── src/
│   ├── config.ts                env → typed config
│   ├── types.ts                 shared types (Chunk, RetrievedChunk, Citation, AskEvent…)
│   ├── llm/
│   │   ├── ollama.ts            /api/embed + streaming /api/chat client (no SDK)
│   │   ├── embeddings.ts        Qwen3 query instruction, Matryoshka truncation, mock embedder
│   │   └── chat.ts              chat provider (Ollama | mock)
│   ├── ingest/
│   │   ├── loader.ts            file walk, frontmatter parsing, metadata, cleaning
│   │   ├── chunker.ts           markdown block parser + heading-aware packing
│   │   ├── manifest.ts          incremental-ingest bookkeeping
│   │   └── pipeline.ts          orchestrates load → chunk → embed → store → BM25 rebuild
│   ├── store/
│   │   ├── vector-store.ts      LanceDB table (schema, add/delete/search/filters)
│   │   └── bm25.ts              tokenizer + Okapi BM25 + gzip persistence
│   ├── retrieval/retriever.ts   hybrid search, RRF, boosts, diversity cap, LLM rerank
│   ├── generation/
│   │   ├── prompt.ts            system prompt, context formatting, citation extraction
│   │   └── ask.ts               the streaming RAG loop shared by CLI and API
│   ├── cli/                     ingest · ask · search · eval · doctor
│   └── server/
│       ├── index.ts             Fastify: /api/ask (SSE), /api/ask/sync, /api/search, /api/ingest, …
│       └── public/index.html    chat UI
└── tests/                       vitest unit tests (chunker, loader, BM25, prompt)
```

Design choices worth knowing: no LangChain/LlamaIndex (the whole pipeline is ~1 500 lines you can read in an
hour and every stage is swappable); no Ollama SDK (two `fetch` calls); a mock provider so the full pipeline —
ingest, storage, retrieval, API, UI — runs in tests and CI without models.

## 12. Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot reach Ollama at http://127.0.0.1:11434` | Start Ollama (`ollama serve` or the app). `npm run doctor` |
| `model "qwen3-embedding:8b" not found` | `ollama pull qwen3-embedding:8b` (same for the chat model) |
| `The index is empty. Run npm run ingest first.` | Exactly that |
| `Existing index is incompatible (...) rebuilding` | Expected after changing embedding model/dims or chunk sizes |
| Ingest interrupted (Ctrl-C, sleep) | Just run `npm run ingest` again; it resumes from the manifest |
| Answers in the wrong language | The prompt mirrors the question's language; ask in the language you want |
| `vector and keyword index sizes differ` in doctor | `npm run ingest` (rebuilds BM25 from the table) |
| Slow first answer after idle | Ollama reloading the model into memory; raise `keep_alive` in `src/llm/ollama.ts` if it bothers you |

## 13. Roadmap / ideas

* **More sources**: the loader only needs markdown + frontmatter, so anything the upstream normaliser exports
  (Jira, tickets, PDFs converted with Docling/MarkItDown) plugs in unchanged.
* **Cross-encoder reranker** (e.g. `bge-reranker-v2-m3` through a small Python sidecar or ONNX) instead of the
  LLM rerank — better precision at lower latency.
* **Per-user permissions** at the API layer, mapping identity → allowed source types / spaces.
* **Feedback loop**: thumbs up/down in the UI appended to `evals/questions.jsonl`.
* **Light LoRA on the chat model** for house style, trained on logged Q&A pairs with their retrieved context
  ("RAFT"-style) — the one place fine-tuning does add value on top of RAG.
