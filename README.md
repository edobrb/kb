# ai-wiki RAG

A fully local **Retrieval-Augmented Generation** system over the TeamSystem OnePlatform knowledge base in `kb/`:
the Developer Portal documentation and the GitLab repositories — their docs **and their source code**.
Ask a question in Italian or English, get an answer generated **only** from the documents and code, with numbered
citations linking back to the portal page, ADR or repository file (down to the line range) the answer came from.
Every chunk is indexed with a short model-written context that says where it belongs
([contextual retrieval](https://www.anthropic.com/engineering/contextual-retrieval)), so "what does this do"
questions about code land on the right file.

Everything runs on one Mac (24 GB unified memory is plenty): **Node.js/TypeScript** for the pipeline,
**Ollama** for the models (`Qwen3-Embedding-0.6B` for embeddings, `qwen3:1.7b` for the ingest-time
chunk contexts, `qwen3:8b` for answers),
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
 │ Document (kind: doc | code | project | api)  │   │ search query                                  │
 │   │  heading-aware chunking (~450 tok) or    │   │   ├──► embed query (Qwen3-Embedding)          │
 │   ▼  declaration-aware code chunking         │   │   │      └► LanceDB cosine search  ─┐         │
 │ Chunks + "Title > H2" / "repo > file > fn"   │   │   └──► BM25 keyword search  ────────┤         │
 │   │  contextual retrieval: chat model writes │   │                                     ▼         │
 │   │  1-3 sentences per chunk (doc + project  │   │        Reciprocal Rank Fusion + authority     │
 │   │  card in the prompt), cached in data/    │   │                                               │
 │   │  embed (Ollama /api/embed, batched)      │   │                                               │
 │   ▼                                          │   │                                               │
 │ LanceDB table  data/lancedb/  (vectors+text) │   │        boost + per-document cap → top-k       │
 │ BM25 index     data/bm25.json.gz             │   │                                     │         │
 │ Manifest       data/manifest.json (hashes)   │   │   prompt = rules + numbered context + history  │
 └──────────────────────────────────────────────┘   │        └► Ollama /api/chat (qwen3:8b, stream)  │
                                                    │ answer with [n] citations + sources           │
                                                    └───────────────────────────────────────────────┘
```

A fuller picture of the knowledge base — sources, document kinds, what triggers re-work, the storage schema
and where each stage lives — is in [ARCHITECTURE.md](ARCHITECTURE.md).

Three pipelines share one codebase:

* **Sync** (offline, incremental): gathers the sources — the **Developer Portal** (Backstage/TechDocs, the
  source of truth for documentation) and the **GitLab** repositories of the `oneplatform` group (markdown docs,
  every source file, and one *project card* per repository enriched with the portal's catalog and the
  Confluence pages that mention the project) — into `kb/` as markdown with frontmatter.
  Confluence itself is no longer indexed. See [7.0 Gathering](#70-gathering-the-sources-srcsync-npm-run-sync).
* **Ingest** (offline, idempotent, incremental): reads `kb/`, chunks (prose and code differently), writes a
  context for every chunk with the chat model, embeds, writes the index.
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
ollama pull qwen3-embedding:0.6b   # embedder: sets the floor on ingest time (see §10)
ollama pull qwen3:1.7b             # writes the chunk contexts at ingest time
ollama pull qwen3:8b               # answers questions

npm run doctor                # checks Ollama, models, kb/ folder, index state
```

### Gather the knowledge base

```bash
# .env: DEVPORTAL_TOKEN, GITLAB_TOKEN, CONFLUENCE_EMAIL + CONFLUENCE_API_TOKEN (see .env.example)
npm run doctor                # "Sync sources" block: each source must be ✓ (Confluence is "enrichment")
npm run sync -- --dry-run     # what would be fetched, nothing written
npm run sync                  # writes kb/devportal, kb/gitlab (+ data/sync/*.json state)
```

Scope (GitLab groups, file globs, Confluence spaces used for enrichment, authority rules) lives in
[`sources.yaml`](sources.yaml). The first run downloads everything the tokens can see in the configured groups
(oneplatform: 348 repositories, ~45 000 files, 20–30 minutes); later runs only touch repositories whose head
commit moved and files whose blob changed, and delete what disappeared at the source. `kb/manually-curated/` is
hand-written and never touched by sync.

### Index the knowledge base

```bash
npm run ingest                # or: npm run sync -- --ingest
```

The first run writes a context for every chunk with the chat model (the slow part, see
[7.3](#73-contextual-retrieval-srcingestcontextualizets)) and then embeds it — budget roughly **8 hours** for
the full oneplatform KB on an M-series Mac with the default models, and see [§10](#10-tuning-guide) before
changing either of them. A live status line reports the phase, progress and a moving ETA:

```
  contextualizing ·  37% · 42,150/113,910 chunks · 11,402/36,441 docs · 2.4 chunk/s · elapsed 4h 52m · ETA 8h 15m
```

The rate is measured over the last minute, so the ETA settles after the first minute and reacts if the
machine speeds up or slows down. In a terminal the line is rewritten in place; when the output is piped to
a file it is appended every 15 s instead, so logs stay readable. `--quiet` prints phase messages only.

Subsequent runs only touch files whose bytes changed. The run is resumable: the manifest is flushed every few
seconds and every generated context is cached in `data/contexts/`, so an interrupted ingest (or a change of
embedding model) never asks the chat model for the same chunk twice. Project cards and prose are indexed
before source code, so the documentation is searchable while the code is still being processed.

### Ask

```bash
npm run ask -- "How must platform APIs represent HTTP errors according to ADR0016?"
npm run ask -- "Come funziona il social login in TSID?"
npm run serve                 # then open http://127.0.0.1:8787
```

## 4. Commands

| Command | What it does |
|---|---|
| `npm run sync` | Gather the sources into `KB_DIR` (Dev Portal → GitLab; Confluence is only queried for the project cards). Flags: `--source devportal,gitlab`, `--full` (ignore state), `--dry-run`, `--only <substring>` (entity / project path), `--prune-foreign` (delete files in `kb/<source>/` that sync did not produce, e.g. old imports), `--ingest` (run ingest afterwards) |
| `npm run ingest` | Incremental index of `KB_DIR`. Shows a live progress line (percentage, chunks/s, elapsed, ETA); `--quiet` disables it. Flags: `--reset` (rebuild all), `--dry-run` (chunk stats + samples, no embedding), `--only <substring>` (subset of files), `--kb <dir>` |
| `npm run ask -- "question"` | Full pipeline, streams the answer to the terminal, prints cited sources and timings. Flags: `--k 8`, `--source-type adr,gitlab`, `--kind code,doc` (code = source files, project = repository cards, api = OpenAPI definitions), `--authority binding`, `--lang en`, `--json` |
| `npm run search -- "query"` | **Retrieval only** (no LLM): shows fused rank, vector rank, BM25 rank and text of each chunk. The main debugging tool — most RAG problems are retrieval problems. |
| `npm run serve` | Starts the HTTP API + web UI on `HOST:PORT` (default `127.0.0.1:8787`) |
| `npm run map` | Projects every chunk vector to 2-D with UMAP, groups the chunks into semantic clusters, and writes `data/kb-map.json.gz`, rendered by the web UI at `/map.html`. Re-run after `ingest`. Flags: `--clusters 8`, `--neighbors 15`, `--min-dist 0.1`, `--epochs 400`, `--project 256`, `--seed 42`, `--out <file>`, `--relabel` (recompute names only, ~1 s) |
| `npm run eval` | Retrieval metrics (hit@k, MRR) over `evals/questions.jsonl`; `--answers` also grades answers by expected keywords |
| `npm run doctor` | Environment check: Ollama reachable, models pulled, kb/ present, index consistency, facets, sync sources reachable with the configured tokens |
| `npm test` / `npm run typecheck` | Unit tests (vitest) / `tsc --noEmit` |

## 5. HTTP API

All endpoints accept/return JSON. Filters are optional everywhere:
`{ "filters": { "sourceTypes": ["adr"], "kinds": ["code"], "authorities": ["binding"], "langs": ["en"] } }`.
Citations carry `kind`, the model-written `context`, and for code chunks `lineStart`/`lineEnd` plus a `sourceUrl`
with a `#L<start>-<end>` anchor.

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

### `GET /api/map`

The 2-D projection built by `npm run map`, served gzipped straight from disk. 404 with a hint when it has not
been built yet. Consumed by `/map.html` (see [6.1](#61-knowledge-base-map-maphtml)). Shape:

```jsonc
{
  "version": 2, "chunks": 60633, "docs": 7101, "generatedAt": "…", "params": { … },
  "dict":      { "groups": ["confluence/EC", …], "sourceTypes": […], "langs": […], "authorities": […] },
  "documents": [{ "id": "<sourceId>", "title": "…", "url": "…", "path": "…", "g": 0, "s": 0, "l": 1, "a": 2 }],
  "clusters":  [{ "id": 0, "name": "TSC OpenTelemetry Legacy", "n": 1007, "x": 1.2, "y": -3.4 }],
  "points":    { "x": [], "y": [], "doc": [], "ord": [], "cl": [], "head": [] },
  "labels":    [{ "x": 1.2, "y": -3.4, "text": "…", "n": 1007, "level": 0 }]
}
```

Document metadata is stored once and referenced by index from `points.doc`, repeated strings live in `dict`,
and per-chunk data sits in parallel arrays. Chunk ids are not shipped: a chunk id is `` `${documents[doc].id}::${ord}` ``.

### `POST /api/chunk`

`{"id":"<chunkId>"}` or `{"ids":[…]}` (max 50) → `{ chunks: RetrievedChunk[] }`. Chunk text is deliberately
absent from the map payload, so the map UI loads a passage only when you select its dot.

## 6. Web UI

`npm run serve` and open <http://127.0.0.1:8787>. Single static file (`src/server/public/index.html`, no build
step, no framework): answers streamed token by token, a **Reasoning** button that streams the model's
thinking into a collapsible panel above the answer, clickable `[n]` citations that jump to the source,
source cards with title → original URL, source-type and authority badges, expandable passage, source-type
filter chips, multi-turn conversation, and a **Re-index** button. Auto-scroll follows the stream but stops
as soon as you scroll up to read.

### 6.1 Knowledge base map (`/map.html`)

A second static page draws the **whole vector index as a 2-D map**: every chunk (or every document, as the
centroid of its chunks) is a dot, and dots that are close in embedding space are close on screen. It is the
quickest way to *see* the shape of the knowledge base — which spaces overlap, where the hand-written glossary
sits relative to the technical docs, isolated clusters that only add noise to retrieval, near-duplicate pages,
and documents whose chunks scatter instead of forming a tight group.

```bash
npm run ingest         # as usual
npm run map            # ~25 s for 10k chunks; writes data/kb-map.json.gz
npm run serve          # → http://127.0.0.1:8787/map.html
```

Cluster names are recomputed in about a second with `npm run map -- --relabel`, which rewrites the names and
labels on the existing projection instead of redoing it — worth knowing, because naming is the part you will
want to iterate on.

**Colours mean meaning, not provenance.** Before UMAP runs, the vectors are grouped with spherical k-means
(`--clusters`, 8 by default) and each cluster is named after the words that are frequent inside it and rare
elsewhere (TF-IDF over titles and heading paths, counting each term once per document so one verbose page cannot name a
whole cluster, and discarding terms that appear in every cluster, which is what stops corpus boilerplate such
as "Analisi Funzionale" from becoming every label). So a colour is a *topic* — "TSC OpenTelemetry Legacy",
"Analisi Funzionale Finanza" — and the same names are drawn on the map as labels. The clustering runs on the
embedding vectors, not on the 2-D coordinates, so it is not distorted by the projection. Colour by space,
source type, language or authority is still one dropdown away.

**Reading a source.** Hovering a dot shows its title, heading path, cluster and space. Clicking it fills the
**Selected** panel at the top of the sidebar, which loads the chunk's full text from `POST /api/chunk` and
offers an **Open source ↗** button. Double-clicking a dot opens its Confluence page or repository file
straight away, and cmd/ctrl-click does the same.

**Retrieval probe.** Type a question and the page calls `POST /api/search`, then rings the chunks the real
hybrid retriever returned, numbered by rank. One tight ringed group means the query landed in a coherent
region; rings scattered across unrelated clusters mean the query needs rewriting or the BM25 weight is too
high. Clicking a result zooms to its dot.

#### Built to grow

The index went from 9.5k to 60k chunks in a day, so the map is built for a knowledge base several times
larger again:

| Concern | How it is handled |
|---|---|
| **Payload size** | Document metadata is stored once and referenced by index, repeated strings are interned in `dict`, per-chunk data is held in parallel arrays, chunk ids are derived rather than shipped, and chunk text is fetched on demand. The file is gzipped on disk and passed through with `content-encoding: gzip`. 9,541 chunks went from 7 MB of JSON to **0.2 MB over the wire**. |
| **Build memory** | Vectors are random-projected row by row as they stream out of LanceDB, so the full-width copy is never held. 100k chunks is 1.6 GB at 4096 dims and 400 MB at 1024; at the projected 256 dims it is ~100 MB. The projection is skipped when `EMBEDDING_DIMENSIONS` is already ≤ 256. |
| **Hover and drawing** | Points are bucketed into a uniform grid (counting sort, typed arrays). Hit-testing touches only the cells under the cursor and drawing only the cells in the viewport, instead of scanning every point on every mouse move. |
| **Overdraw** | Above ~25k points in view, or with **density** ticked, points are blended straight into a pixel buffer in one pass rather than stroked as arcs. Overlapping points darken, so structure stays readable where dots would pile into a solid blob. Zooming in returns to crisp dots automatically. |
| **Legibility** | Cluster names are drawn on the map, coarse ones when zoomed out and finer per-region labels once zoomed in, each skipped if it would collide with a label already placed. |

Caveats: UMAP distances are only meaningful *locally* — cluster membership and neighbourhoods are reliable,
distances between far-apart clusters are not. The map is a snapshot: after `npm run ingest` the probe will
report chunks that are "not on the map" until you run `npm run map` again.

## 7. How each stage works

### 7.0 Gathering the sources (`src/sync/`, `npm run sync`)

```
 Developer Portal (Backstage)              GitLab (biosphere)                       Confluence Cloud (enrichment only)
 /api/catalog/entities  ─┐                 /api/v4/groups/*/projects                /wiki/rest/api/search?cql=
 /api/techdocs/metadata  │ etag            /repository/branches/{default} (head)      title ~ "<project>" OR text ~ …
 /api/techdocs/static/…  │ HTML            /repository/tree (blob sha)                        │ title, link, snippet
          │              ▼                 /repository/files/…/raw   /languages               │
          │  coveredRepos + repoEntities ──────────► owner/system per repo, skip docs/**       │
          ▼                                         ▼                                          ▼
   html → markdown (cheerio + turndown)   *.md as-is  ·  source files → fenced block  ·  project card ◄─┘
          └────────────────────────────► rules (sources.yaml) → kb/<source>/… + data/sync/<source>.json
```

| Source | What is indexed | Id / file | Incremental key |
|---|---|---|---|
| **devportal** | every TechDocs page of every catalog entity with `backstage.io/techdocs-ref`, plus the OpenAPI/AsyncAPI definition of `API` entities | `devportal:<ns>/<kind>/<name>/<page/>` → `kb/devportal/<kind>/<name>/<page>.md` | TechDocs `etag` (whole entity skipped when unchanged) |
| **gitlab** — docs (`kind: doc`) | `gitlab.docs.include` globs (`*.md`, `*.mdx`…) in every project of `gitlab.groups` (recursive) and `gitlab.projects`, minus `exclude_projects` (the old KB export, `*/archived/*`, `*/deprecated/*`) and `docs.exclude`; for repositories the portal renders, `docs/**` is skipped (`skip_techdocs_if_in_devportal`) but READMEs and the rest are kept | `gitlab:<group/project>:<path>` → `kb/gitlab/<group>/<project>/<path>` | default-branch head commit (whole project skipped when unchanged), then blob sha per file |
| **gitlab** — code (`kind: code`) | every source file matching `gitlab.code.include` (TS/JS, Python, Kotlin/Java, Go, C#, Rust, SQL, shell, Terraform, YAML/TOML, Dockerfiles, build files, `package.json`, OpenAPI/JSON schemas…) minus `code.exclude` (node_modules, dist/build, lockfiles, minified, `*.d.ts`, fixtures, generated) and test files (`skip_tests`); binary, generated (`@generated`), minified (avg line > 300 chars) or > 4 000-line files are skipped | same id → `kb/gitlab/<group>/<project>/<path>.md`, body = one fenced block with the language tag, frontmatter `language`, `lines`, `blob_sha` | blob sha |
| **gitlab** — project card (`kind: project`) | one per repository: GitLab description/topics/languages, the Dev Portal entity (owner, system, lifecycle, description — via the portal's `repoEntities`), a README excerpt, top-level folders, and the Confluence pages found by searching the project name | `gitlab:<group/project>:__project` → `kb/gitlab/<group>/<project>/__project.md` | sha of the rendered card |
| ~~confluence~~ | **not indexed** since 2026-09-09. The connector is now a lookup: for each repository, `/wiki/rest/api/search?cql=` with `title ~ "<name>"` first and `text ~ "<name>"` second, scoped to `confluence.spaces.include`, personal spaces dropped, top `max_pages_per_project` hits with their search snippets go on the card. Cached per project for `refresh_days`. | — | — |

Scale seen on 2026-09-09 with one user's tokens: 266 portal entities with TechDocs plus 131 API entities;
the `oneplatform` group has 348 non-empty repositories (156 in `islands`, 81 in `onefront`, 34 in `practice-ai`…),
mostly TypeScript/JavaScript, then Python, Kotlin, HCL, SQL; sampling 50 of them extrapolates to ~40 000 source
files (~12 % tests, excluded by default) and ~5 000 markdown files. Repository archives are refused by this GitLab
(HTTP 406), so files are downloaded one by one with `SYNC_CONCURRENCY` parallel requests. Later runs are fast:
an unchanged repository costs one branch request.

Why the portal first: it is populated from GitLab by CI, so it renders documentation from repositories you
have no access to, and its TechDocs HTML is already the "published" view. It also knows who owns what, which the
GitLab connector copies onto the project cards. Both keep a `source_url` pointing where people actually read the
document (for code, the blob URL with a line anchor), so citations stay clickable.

Every document gets the frontmatter the ingest expects (`source_id`, `source_type`, `kind`, `title`, `source_url`,
`authority`, `lang`, `last_modified`, `fetched_at`) plus source-specific fields (`entity`, `owner`, `system`,
`project`, `file_path`, `language`, `lines`, `blob_sha`, `confluence_pages`…). `authority` and `source_type` are decided by the **rules** in
`sources.yaml` (first match wins; e.g. `gitlab:oneplatform/adrs:*` → `source_type: adr, authority: binding`);
`lang` is detected from function words (it/en/und, the embedding model is multilingual so nothing is translated).
Markdown identifiers are **not** escaped (`subject_token` stays one BM25 token) and images become `[image: alt]`.

Safety rails: a source that aborts (network, expired token) never deletes anything; `--only` never deletes;
files in `kb/<source>/` that sync does not know about are reported but only removed with `--prune-foreign`;
files are rewritten only when their content changed, so `npm run ingest` stays incremental.

**Credentials** (all read-only, all in `.env`):

* `DEVPORTAL_TOKEN` — Backstage identity token. Log in to the portal, open DevTools → Network, click any
  `/api/…` request and copy the `Authorization: Bearer …` value. User tokens expire after about an hour, enough
  for a full run; for unattended runs ask the portal team for a static token (`backend.auth.externalAccess`).
* `GITLAB_TOKEN` — personal access token with the `read_api` scope (GitLab → Preferences → Access Tokens).
* `CONFLUENCE_EMAIL` + `CONFLUENCE_API_TOKEN` — Atlassian API token from
  <https://id.atlassian.com/manage-profile/security/api-tokens>, used only for the project-card lookups. Scoped
  tokens (the default kind since 2025) are rejected by the site URL and only work through
  `api.atlassian.com/ex/confluence/<cloudId>`; the connector detects this and switches automatically
  (`CONFLUENCE_CLOUD_ID` forces it). Without it, sync still works — cards simply have no "Related Confluence pages".

### 7.1 Loading & metadata (`src/ingest/loader.ts`)

Every file in `kb/` carries a YAML frontmatter produced by the upstream normalisation workflow. We use:

| Frontmatter | Used for |
|---|---|
| `source_id` | Stable chunk ids (`<source_id>::<n>`), incremental delete/replace |
| `source_type` (`devportal`, `gitlab`, `adr`, `manually-curated`) | Filtering (`--source-type`, UI chips) |
| `kind` (`doc`, `code`, `project`, `api`) | Chunking strategy, contextualization, filtering (`--kind`, UI chips) |
| `title`, `source_url` | Breadcrumb in every chunk, citation links |
| `authority` (`binding` / `normative` / `descriptive`) | Retrieval boost (+15 % / +12 %) and a prompt rule to prefer binding docs on conflict |
| `lang` | Filtering |
| `last_modified` / `fetched_at` | Shown in metadata |

Files without frontmatter still work (title from the first `#` heading, source type from the folder name,
kind `doc`). For prose, HTML comments are stripped and `\_` escapes undone (so `subject_token` is one BM25 token
in tables too); source files are left untouched. Change detection uses the **sha256 of the file bytes**, so a
manual edit is always picked up.

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

Source files (`kind: code`) use `chunkCode` instead: the file is cut at **top-level declarations**
(`function`/`class`/`def`/`fun`/`func`/`CREATE TABLE`/`resource "…"`… — anything that starts at column 0 and is
not a closing bracket or an import) once a chunk reaches `CODE_CHUNK_TARGET_TOKENS` (600), at blank lines when
no declaration is near, and hard-cuts only past `CODE_CHUNK_MAX_TOKENS` (900). Every chunk keeps the fence and
language tag, records its 1-based line range (→ `#L10-45` citation links) and gets a
`repo > path/to/file.ts > symbolA, symbolB` breadcrumb from the symbols it declares.

`npm run ingest -- --dry-run` prints size statistics, sample chunks and how many chunks would go to the
contextualizer, so you can see the effect of the `CHUNK_*` settings before spending model time.

### 7.3 Contextual retrieval (`src/ingest/contextualize.ts`)

A chunk embedded on its own loses what it belongs to: "retries: 3" or "returns the tenant" means nothing without
the file and the project. Following Anthropic's
[contextual retrieval](https://www.anthropic.com/engineering/contextual-retrieval) (−49 % retrieval failures
on their benchmarks, −67 % with a reranker), every chunk is prefixed — for **both** the embedding and the
BM25 index — with 1–2 sentences written by a chat model that saw:

1. a **background**: for repository files the *project card* (name, description, Dev Portal owner/system,
   languages, README excerpt, related Confluence pages — the essentials come first so truncation to
   `CONTEXT_MAX_BACKGROUND_CHARS` keeps them); for portal pages the catalog entity; a one-liner otherwise;
2. the **document, rendered once, split into its own chunks** inside `<chunk id="N">` markers;
3. the instruction to write one line per id situating that chunk — mentioning identifiers verbatim.

**One call situates a whole group of chunks**, not one call per chunk. That shape follows from how the
hardware actually behaves: generation is the entire cost of this stage and it does *not* parallelise —
Ollama on Metal time-slices concurrent requests rather than batch-decoding them, so aggregate throughput is
a constant per model (measured on an M5 Pro: ~49 tok/s for an 8B, ~156 tok/s for `qwen3:1.7b`, flat from 1
to 16 requests in flight). Wall-clock is therefore just *generated tokens ÷ model throughput*, and the only
levers are a smaller model, fewer generated tokens, and fewer prompt tokens re-read per context. Sending
each chunk separately re-reads the document every time (~3 900 prompt tokens per chunk); rendering the
document once with markers costs ~400. Groups are cut at `CONTEXT_GROUP_CHARS` so the prompt still fits
`CONTEXT_NUM_CTX`; `CONTEXT_GROUP_CHARS_API` halves that for API reference pages, whose dense
schema-after-schema text made the model skip 17 % of ids.

The other half of the saving is in the *length* of what is generated, and a word count does not buy it:
asked for "at most 30 words", `qwen3:1.7b` wrote ~59 tokens per context, and asking for 20 or 14 changed
nothing. Two example lines in the system prompt, shown purely for their length, cut that to ~29 and removed
the skipped ids that a long answer causes — a 1.8× speed-up on its own. The cost is that a small model
handed a two-chunk document sometimes copies an example instead of reading the chunk (~4 % of chunks in
short documents; *telling* it not to copy made that worse), so the parser drops any line that is one of the
examples verbatim and re-asks that id on its own.

An id the model skips or truncates is re-asked **on its own**, with the original single-chunk prompt, so a
malformed batch costs a little time and never quality; only a failure of that retry falls back to the
deterministic sentence. Chunk text becomes `breadcrumb ⏎⏎ context ⏎⏎ content`, and the context is stored in
its own column, shown under each citation in the UI and given to the answering model as `about: …`.

> A model whose Ollama architecture is `qwen35` (e.g. `ornith-1.5:9b`) is pinned to a single slot — Ollama
> logs `model architecture does not currently support parallel requests` — and is also a 9B. It is a poor
> choice for `CONTEXT_MODEL`; the `qwen3` family is roughly 4× faster here.

What is *not* sent to the model, because there is nothing to situate: documents with fewer than
`CONTEXT_MIN_CHUNKS` chunks (`CONTEXT_MIN_CHUNKS_CODE` for source files, whose indexed text already carries
`repo > file > symbol`), project cards, and kinds outside `CONTEXT_KINDS` — they get a deterministic context
such as `Source file src/x.ts (typescript) of the core-registry repository (oneplatform/…) — <description>`.
Every generated context is cached in `data/contexts/<shard>/<hash>.json` keyed by document id and
chunk-content hash: re-ingests, embedding-model changes and crashes never redo a chunk, and an edited file
only re-contextualizes the chunks whose text changed. Documents are processed in batches of
`INGEST_BATCH_CHUNKS`: contextualize the batch, then embed it, so the two models are not swapped in and out per
document. `CONTEXTUALIZE=false` turns the whole stage off (and rebuilds the index, since every text changes);
`CONTEXT_MODEL` picks a smaller/faster model than the answering one.

### 7.4 Embeddings (`src/llm/embeddings.ts`)

[Qwen3-Embedding](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) via Ollama, multilingual (Italian +
English in the same space), 32k context. The default is the **0.6b** (1024 dimensions): embedding touches
every chunk and is prompt-bound, which makes the model size a hard floor on ingest time — 2.9 chunks/s for
the 8b against 24 chunks/s for the 0.6b on an M5 Pro, i.e. 11 h versus 1.3 h over 114k chunks. `:8b`
(4096 dims) is the quality ceiling if you can spend the hours. Two model-specific details:

* It is **instruction-aware**: queries are embedded as `Instruct: <task>\nQuery: <question>`; documents are
  embedded as-is. Getting this asymmetry right is worth several points of recall.
* It is **Matryoshka-trained**: the first N dimensions are themselves a good embedding, so
  `EMBEDDING_DIMENSIONS` may be set below what the model emits (1024 for the 0.6b/4b, 4096 for the 8b) to
  shrink the vector index — we truncate + renormalise client-side. It may never exceed the model's width.

Chunks are embedded in batches (`EMBED_BATCH_SIZE`) through `/api/embed`; the manifest is written after each
document, so an interrupted ingest resumes where it stopped.

### 7.5 Storage (`src/store/`)

* **LanceDB** (`data/lancedb/`): embedded, file-based, Apache Arrow columns, native Apple-Silicon binary.
  One table `chunks` with the vector plus all metadata columns, so filters are plain SQL-like predicates
  (`source_type IN ('adr')`, `kind IN ('code')`). No ANN index is created: with tens of thousands of vectors a
  brute-force cosine scan is a few milliseconds and exact.
* **BM25** (`data/bm25.json.gz`): a ~150-line Okapi BM25 implementation. Tokeniser lower-cases, folds accents
  (`perché` → `perche`), drops Italian/English stopwords and splits alphanumeric codes so `ADR0010`, `ADR 0010`
  and `adr-0010` all match. It is rebuilt from the LanceDB table after every ingest, so the two can never drift.

### 7.6 Hybrid retrieval (`src/retrieval/retriever.ts`)

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

### 7.7 Generation (`src/generation/`)

The system prompt (`prompt.ts`) contains the rules — answer only from context, say when the context does not
cover the question, cite `[n]` after each claim, prefer binding sources, name repository + file and quote the
lines when answering from code, reply in the user's language — followed by the numbered context blocks (each
with its heading path, line range, source type, kind, authority, URL and the chunk's `about:` context). Previous turns
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
| `EMBEDDING_MODEL` | `qwen3-embedding:0.6b` | Any Ollama embedding model; sets the floor on ingest time (§10); changing it triggers a full rebuild |
| `EMBEDDING_DIMENSIONS` | `1024` | Matryoshka truncation, ≤ model output (1024 for the 0.6b/4b, 4096 for the 8b) |
| `CHAT_MODEL` | `qwen3:8b` | Any Ollama chat model (e.g. `ornith-1.5:9b`, `gemma3:12b`, `qwen3:14b`) |
| `CHAT_THINK` | `false` | Default reasoning mode; per request, override with `"think": true` or the UI's **Reasoning** button |
| `CHAT_NUM_CTX` | `16384` | Context window requested from Ollama; 6 chunks × 450 tok + prompt + history fits easily |
| `CHUNK_TARGET_TOKENS` / `CHUNK_MAX_TOKENS` / `CHUNK_OVERLAP_TOKENS` | `450` / `700` / `60` | Prose chunking; changing them triggers a full rebuild |
| `CODE_CHUNK_TARGET_TOKENS` / `CODE_CHUNK_MAX_TOKENS` | `600` / `900` | Source-file chunking (cut at declarations); full rebuild on change |
| `CONTEXTUALIZE` | `true` | Contextual retrieval on/off (toggling rebuilds the index) |
| `CONTEXT_MODEL` | `CHAT_MODEL` | Model that writes the chunk contexts; `qwen3:1.7b` generates ~3× faster than `qwen3:8b`. Avoid `qwen35`-architecture models (§7.3) |
| `CONTEXT_GROUP_CHARS` / `CONTEXT_GROUP_CHARS_API` | `16000` / `8000` | Chunk characters per batched call — larger groups mean fewer prefills, but must fit `CONTEXT_NUM_CTX`; dense API pages need less |
| `CONTEXT_MAX_WORDS` | `30` | Words per context. Generation is the whole cost of the stage, so this is the main time/quality dial |
| `CONTEXT_MIN_CHUNKS` / `CONTEXT_MIN_CHUNKS_CODE` | `2` / `4` | Documents below this get a deterministic context |
| `CONTEXT_NUM_CTX` / `CONTEXT_MAX_DOC_CHARS` / `CONTEXT_MAX_BACKGROUND_CHARS` / `CONTEXT_MAX_TOKENS` | `8192` / `16000` / `1800` / `120` | Prompt budget; the last two apply to the single-chunk retry |
| `CONTEXT_KINDS` | `doc,code,api` | Kinds sent to the model (project cards never are) |
| `INGEST_BATCH_CHUNKS` | `256` | Contextualize this many chunks, then embed them |
| `RETRIEVAL_CANDIDATES` / `RETRIEVAL_TOP_K` | `24` / `6` | Candidates per retriever before fusion / chunks sent to the LLM |
| `RETRIEVAL_VECTOR_WEIGHT` / `RETRIEVAL_BM25_WEIGHT` | `1.0` / `1.0` | RRF weights |
| `RETRIEVAL_MAX_CHUNKS_PER_DOC` | `3` | Diversity cap |
| `RERANK` | `none` | `llm` for the LLM rerank stage |
| `QUERY_REWRITE` | `true` | Rewrite follow-ups into standalone queries |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Set `HOST=0.0.0.0` to reach the UI from other machines on the LAN |
| `EMBEDDING_PROVIDER` / `CHAT_PROVIDER` | `ollama` | `mock` runs the whole pipeline without Ollama (tests/CI) |
| `SOURCES_FILE` | `./sources.yaml` | Scope and rules for `npm run sync` |
| `DEVPORTAL_BASE_URL` / `DEVPORTAL_TOKEN` | `https://development.teamsystem.com` / — | Backstage bearer token (see 7.0) |
| `GITLAB_BASE_URL` / `GITLAB_TOKEN` | `https://biosphere.teamsystem.com` / — | PAT with `read_api` |
| `CONFLUENCE_BASE_URL` / `CONFLUENCE_EMAIL` / `CONFLUENCE_API_TOKEN` | `https://teamsystem.atlassian.net` / — / — | Atlassian API token (classic or scoped), used only to enrich project cards |
| `CONFLUENCE_CLOUD_ID` | auto | Forces the `api.atlassian.com` gateway used by scoped tokens |
| `SYNC_CONCURRENCY` | `4` | Parallel requests per source (8 recommended for the per-file GitLab downloads) |

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

**Ingest is slow.** Both stages are model-bound, and neither gets faster by issuing more requests: Ollama on
Metal time-slices concurrent work instead of batching it, so aggregate throughput is a constant per model.
Budget the run as *tokens ÷ throughput* and pick model sizes accordingly. Measured on an M5 Pro over the
oneplatform KB (36 441 documents → 113 910 chunks, 80 472 of them contextualized):

| Stage | Cost driver | With the old defaults | With the current defaults |
|---|---|---|---|
| Contexts | generated tokens | `ornith-1.5:9b`, one call per chunk — ~2.9 s/chunk → **~73 h** | `qwen3:1.7b`, one call per group — ~0.35 s/chunk → **~7 h** |
| Embeddings | prompt tokens | `qwen3-embedding:8b`, 2.9 chunks/s → **~11 h** | `qwen3-embedding:0.6b`, 24 chunks/s → **~1.3 h** |

Levers, in order of impact: **`CONTEXT_MODEL`** (`qwen3:1.7b` generates ~156 tok/s against ~49 for an 8B, and
`qwen35`-architecture models such as `ornith-1.5:9b` are pinned to one slot by Ollama — see §7.3);
**`EMBEDDING_MODEL`** (`qwen3-embedding:0.6b` is ~8× the 8b's throughput); **`CONTEXT_MAX_WORDS`** (the stage
costs exactly what it generates); `CONTEXT_MIN_CHUNKS_CODE` and `CONTEXT_KINDS=doc,api` to send less code to
the model; narrower `gitlab.groups` / `exclude_projects` in `sources.yaml`; larger `CODE_CHUNK_TARGET_TOKENS`.
The run is resumable and the contexts are cached per chunk hash, so it is fine to stop it and pick it up later
— and swapping the embedding model rebuilds the index while reusing every context.

**What the speed costs in quality.** `evals/questions.jsonl` still refers to source ids from an older export,
so it cannot arbitrate this yet (§9). The numbers below come from `scripts/bench/` instead: the chat model
writes one question per chunk, and we measure how often that chunk comes back in the top 6. Three indexes
over the same 621-chunk sample of `kb/`, the same 300 questions, and — for the first two rows — literally the
same generated contexts:

| Index | hit@6 | MRR | Ingest cost |
|---|---|---|---|
| `qwen3-embedding:0.6b` @1024d, contexts on | 90.0 % | 0.791 | ~8 h |
| `qwen3-embedding:8b` @4096d, contexts on | 92.3 % | 0.796 | ~18 h |
| `qwen3-embedding:0.6b` @1024d, **contexts off** | 91.7 % | 0.821 | ~1.5 h |

At n=300 one point of hit@6 is about ±1.6, so read row 2 as *the 8b buys perhaps 2 points for 8.5× the
embedding time* — the reason the 0.6b is the default. Row 3 is the uncomfortable one: **contextual retrieval
did not measurably help on this knowledge base**, and it is ~7 of the ~8 hours. Two caveats before acting on
it: the questions are written *from* each chunk's own text, which flatters a bare chunk and under-rewards a
context prefix; and this KB already puts the heading path (`repo > file > symbol`) into the indexed text,
which is much of what a context would have said. If you want the hours back, `CONTEXTUALIZE=false` is the
single biggest lever there is — but settle it against a repaired `evals/questions.jsonl` first.

**Memory.** The two default models (~1.5 GB and ~2 GB resident) stay loaded together comfortably, which is what
the batched ingest relies on (contexts, then embeddings, per batch). The 8b pair (`qwen3-embedding:8b` ~9 GB,
`qwen3:8b` ~6 GB) plus an 8k context still fits in 24 GB, but see the table above before choosing it. Ollama
unloads idle models after 5 minutes; the first request after idling pays a few seconds of load time. If you move
to a 14B chat model, keep `CHAT_NUM_CTX` at 16k or lower and expect the contextualizer to swap models per batch.

**Answers miss things that are in the docs.** Run `npm run search -- "<question>"` and look at the `vec=` /
`bm25=` ranks. If the right chunk is found by only one retriever, adjust the weights. If it is not found at all,
the chunk is probably too big/mixed — lower `CHUNK_TARGET_TOKENS` — or the question uses vocabulary the docs do
not (add a glossary page to `kb/manually-curated`, which is exactly what those files are for).

**Answers hallucinate.** Lower `CHAT_TEMPERATURE` (0–0.2), reduce `RETRIEVAL_TOP_K` so irrelevant chunks do not
dilute the context, or enable `RERANK=llm`.

**Follow-ups retrieve the wrong thing.** Check the `Search query:` status line printed by `ask`; if the rewrite
is poor, disable `QUERY_REWRITE` or improve the prompt in `src/generation/ask.ts`.

**Code questions land on docs (or vice versa).** Use the `kind` filter: `--kind code` / the `</> code` chip in the
UI restricts retrieval to source files, `--kind project` to the repository cards ("who owns X", "what is X").

**Access control.** `RetrievalFilters` already filters at query time; to enforce permissions, map the caller's
identity to allowed `sourceTypes` / `kinds` (or add a column, e.g. GitLab group) in the API layer before calling
`retriever.retrieve()`.

## 11. Project layout

```
ai-wiki/
├── kb/                          the knowledge base (markdown + frontmatter): kb/{devportal,gitlab} are written
│                                by `npm run sync` (gitlab holds docs, source files and __project.md cards), kb/manually-curated/ by hand
├── ARCHITECTURE.md              the knowledge base end to end: sources, kinds, incremental keys, storage
├── sources.yaml                 what sync gathers (groups, doc/code globs, Confluence enrichment) and authority/source_type rules
├── data/                        generated index (LanceDB, BM25, manifest, kb-map.json.gz), data/contexts/ (cached chunk
│                                contexts) and data/sync/ state — git-ignored
├── evals/questions.jsonl        evaluation set
├── scripts/setup-ollama.sh      pulls the two models
├── src/
│   ├── config.ts                env → typed config
│   ├── types.ts                 shared types (Chunk, RetrievedChunk, Citation, AskEvent…)
│   ├── llm/
│   │   ├── ollama.ts            /api/embed + streaming /api/chat client (no SDK)
│   │   ├── embeddings.ts        Qwen3 query instruction, Matryoshka truncation, mock embedder
│   │   └── chat.ts              chat provider (Ollama | mock)
│   ├── sync/
│   │   ├── index.ts             orchestrator: run connectors, write kb/, prune, persist state
│   │   ├── devportal.ts         Backstage catalog + TechDocs connector (emits coveredRepos, repoEntities)
│   │   ├── gitlab.ts            GitLab connector: docs, source files, project cards (head-commit incremental)
│   │   ├── code.ts              language map, junk detection, fenced rendering, declaration/symbol regexes
│   │   ├── project-card.ts      the per-repository card (GitLab + Dev Portal + README + Confluence hits)
│   │   ├── confluence.ts        Confluence CQL lookup used to enrich the cards (pages are not indexed)
│   │   ├── html.ts              cheerio + turndown HTML → markdown (code panels, tables, admonitions)
│   │   ├── sources-config.ts    sources.yaml parsing, globs, rules
│   │   ├── kb-writer.ts         frontmatter rendering, slugs
│   │   ├── http.ts              fetch with retries/backoff, concurrency limiter
│   │   └── lang.ts, state.ts, types.ts
│   ├── ingest/
│   │   ├── loader.ts            file walk, frontmatter parsing, metadata (kind), cleaning
│   │   ├── chunker.ts           markdown block parser + heading-aware packing; declaration-aware code chunking
│   │   ├── contextualize.ts     contextual retrieval: background, prompt, sanitising, per-document cache
│   │   ├── manifest.ts          incremental-ingest bookkeeping
│   │   └── pipeline.ts          orchestrates load → chunk → contextualize → embed → store → BM25 rebuild, in batches
│   ├── store/
│   │   ├── vector-store.ts      LanceDB table (schema, add/delete/search/filters)
│   │   └── bm25.ts              tokenizer + Okapi BM25 + gzip persistence
│   ├── retrieval/retriever.ts   hybrid search, RRF, boosts, diversity cap, LLM rerank
│   ├── viz/map.ts               random projection, k-means clusters, UMAP → 2-D map (npm run map)
│   ├── generation/
│   │   ├── prompt.ts            system prompt, context formatting, citation extraction
│   │   └── ask.ts               the streaming RAG loop shared by CLI and API
│   ├── cli/                     sync · ingest · ask · search · eval · doctor · map
│   └── server/
│       ├── index.ts             Fastify: /api/ask (SSE), /api/ask/sync, /api/search, /api/map, /api/ingest, …
│       ├── public/index.html    chat UI
│       └── public/map.html      2-D map: clusters, labels, density LOD (canvas, no build step)
└── tests/                       vitest unit tests (chunkers, contextualizer, loader, BM25, prompt, sync connectors with fake fetch)
```

Design choices worth knowing: no LangChain/LlamaIndex (the whole pipeline is ~1 500 lines you can read in an
hour and every stage is swappable); no Ollama SDK (two `fetch` calls); a mock provider so the full pipeline —
ingest, storage, retrieval, API, UI — runs in tests and CI without models.

## 12. Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot reach Ollama at http://127.0.0.1:11434` | Start Ollama (`ollama serve` or the app). `npm run doctor` |
| `model "qwen3-embedding:0.6b" not found` | `ollama pull qwen3-embedding:0.6b` (same for the chat and context models) |
| `The index is empty. Run npm run ingest first.` | Exactly that |
| `Existing index is incompatible (...) rebuilding` | Expected after changing embedding model/dims or chunk sizes |
| `[devportal] ... HTTP 401 ... Missing credentials` | `DEVPORTAL_TOKEN` missing or expired (user tokens last ~1 h): copy a fresh one from the browser, or use a static token |
| `confluence (enrichment): HTTP 401 ...` | Scoped API token; the connector falls back to the `api.atlassian.com` gateway by itself. If the gateway also fails, check `CONFLUENCE_EMAIL` and the token's Confluence read/search scopes — or set `confluence.enrich_projects: false`; sync works without it |
| `sources.yaml: "gitlab.include" is no longer supported` | The 2026-09-09 layout moved the globs to `gitlab.docs` / `gitlab.code`; the error names the new key |
| `[gitlab] ... repository/archive... HTTP 406` | Expected on this instance (archives disabled); files are downloaded one by one |
| Ingest ETA is days | Check `CONTEXT_MODEL` and `EMBEDDING_MODEL` first — see the table in §10. It is safe to stop and resume |
| `contexts generated` ≫ `calls`, or many `retried singly` | Normal: one call situates a group. A high retry count means the model is not honouring the numbered format — lower `CONTEXT_GROUP_CHARS` or raise `CONTEXT_MAX_WORDS` |
| `[gitlab] group X: HTTP 404` | The token cannot see that group; remove it from `sources.yaml` or list the projects you can see under `gitlab.projects` |
| `N file(s) in gitlab/ were not produced by sync` | Old imports in `kb/<source>/`; check them, then `npm run sync -- --prune-foreign` |
| Ingest interrupted (Ctrl-C, sleep) | Just run `npm run ingest` again; it resumes from the manifest |
| Answers in the wrong language | The prompt mirrors the question's language; ask in the language you want |
| `vector and keyword index sizes differ` in doctor | `npm run ingest` (rebuilds BM25 from the table) |
| Slow first answer after idle | Ollama reloading the model into memory; raise `keep_alive` in `src/llm/ollama.ts` if it bothers you |

## 13. Roadmap / ideas

* **More sources**: the loader only needs markdown + frontmatter, so anything the upstream normaliser exports
  (Jira, tickets, PDFs converted with Docling/MarkItDown) plugs in unchanged.
* **Cross-encoder reranker** (e.g. `bge-reranker-v2-m3` through a small Python sidecar or ONNX) instead of the
  LLM rerank — better precision at lower latency; Anthropic's numbers say it compounds with contextual retrieval.
* **Widen the GitLab scope** (`tsdigital`, `paas`, `madbit`) once the oneplatform throughput is known; and
  **regenerate `evals/questions.jsonl`**, whose ids still point at the old Confluence-based export.
* **Per-user permissions** at the API layer, mapping identity → allowed source types / spaces.
* **Feedback loop**: thumbs up/down in the UI appended to `evals/questions.jsonl`.
* **Light LoRA on the chat model** for house style, trained on logged Q&A pairs with their retrieved context
  ("RAFT"-style) — the one place fine-tuning does add value on top of RAG.
