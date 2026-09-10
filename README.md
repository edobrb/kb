# ai-wiki RAG

A fully local **Retrieval-Augmented Generation** system that answers **technical questions about TeamSystem
OnePlatform** from the knowledge base in `kb/`: the Developer Portal documentation, the documentation and API
contracts kept in the GitLab repositories, and a curated selection of Confluence spaces. Ask a question in
Italian or English, get an answer generated **only** from those documents, with numbered citations linking back
to the portal page, ADR, repository file or wiki page the answer came from.

Everything runs on one Mac (24 GB unified memory is plenty): **Node.js/TypeScript** for the pipeline,
**Ollama** for the models (`Qwen3-Embedding-0.6B` for embeddings, `qwen3:8b` for answers), **LanceDB** as an
embedded vector database, and an in-process **BM25** index for keyword search. No cloud services, no Docker,
no database server — the index is just a folder (`data/`).

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
                OFFLINE (npm run sync → npm run ingest)                ONLINE (npm run ask / serve)
 ┌──────────────────────────────────────────────┐   ┌───────────────────────────────────────────────┐
 │ Dev Portal · GitLab docs · Confluence spaces │   │ question (+ chat history)                     │
 │   │  sync: fetch, html → md, filter noise,   │   │   │  optional: rewrite follow-up into a       │
 │   ▼  write kb/**/*.md with frontmatter       │   │   ▼  standalone query (chat model)            │
 │ Document (kind: doc | api | project [| code])│   │ search query                                  │
 │   │  heading-aware chunking (~450 tok)       │   │   ├──► embed query (Qwen3-Embedding)          │
 │   ▼  "Breadcrumb > Title > H2" prefix        │   │   │      └► LanceDB cosine search  ─┐         │
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

A fuller picture of the knowledge base — sources, what each one filters out, document kinds, what triggers
re-work, the storage schema and where each stage lives — is in [ARCHITECTURE.md](ARCHITECTURE.md).

Three pipelines share one codebase:

* **Sync** (offline, incremental): gathers the sources into `kb/` as markdown with frontmatter — the
  **Developer Portal** (Backstage/TechDocs, the source of truth for documentation, minus its generated API
  reference), the **GitLab** repositories (markdown documentation, OpenAPI/AsyncAPI contracts and one
  *project card* per repository; no source code), and the technical **Confluence** spaces (whole spaces minus
  meeting notes, ceremonies, drafts and archives). See [7.0 Gathering](#70-gathering-the-sources-srcsync-npm-run-sync).
* **Ingest** (offline, idempotent, incremental): reads `kb/`, chunks by headings, embeds, writes the index.
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

# Pull the models (once). Or run: ./scripts/setup-ollama.sh
ollama pull qwen3-embedding:0.6b   # embedder: sets the floor on ingest time (see §10)
ollama pull qwen3:8b               # answers questions

npm run doctor                # checks Ollama, models, kb/ folder, index state, source credentials
```

### Gather the knowledge base

```bash
# .env: DEVPORTAL_TOKEN, GITLAB_TOKEN, CONFLUENCE_EMAIL + CONFLUENCE_API_TOKEN (see .env.example)
./refresh-dev-portal-token.sh # prints a fresh portal token (user tokens last ~1 h); paste it into .env
npm run doctor                # "Sync sources" block: devportal, gitlab and confluence must be ✓
npm run sync -- --dry-run     # what would be fetched, nothing written
npm run sync                  # writes kb/devportal, kb/gitlab, kb/confluence (+ data/sync/*.json state)
```

Scope — portal page excludes, GitLab groups and file globs, Confluence spaces and tree filters, authority
rules — lives in [`sources.yaml`](sources.yaml). The first run takes a few minutes for the portal, ~15 minutes for
GitLab and a few minutes for Confluence; later runs only touch entities whose TechDocs build moved, repositories
whose head commit moved, pages whose version changed, and delete what disappeared at the source. Every run logs
why documents were skipped and writes the full list to `data/sync/<source>.skipped.jsonl`, so the noise
filters can be audited. `kb/manually-curated/` is hand-written and never touched by sync.

### Index the knowledge base

```bash
npm run ingest                # or: npm run sync -- --ingest
```

The first run embeds every chunk — budget roughly **28 minutes** for the whole KB on an M-series Mac
with the default embedder (~40 406 chunks at ~24 chunks/s); see [§10](#10-tuning-guide) before changing it.
A live status line reports the phase, progress and a moving ETA:

```
  embedding ·  37% · 12,150/40 406 chunks · 2,402/6,441 docs · 23.8 chunk/s · elapsed 8m 30s · ETA 14m 12s
```

In a terminal the line is rewritten in place; when the output is piped to a file it is appended every 15 s
instead, so logs stay readable. `--quiet` prints phase messages only. Subsequent runs only touch files whose
bytes changed. The run is resumable: the manifest is flushed after every batch, so an interrupted ingest picks
up where it stopped. Project cards and prose are indexed first, so the documentation is searchable early.

### Ask

```bash
npm run ask -- "How must platform APIs represent HTTP errors according to ADR0016?"
npm run ask -- "Come funziona il social login in TSID?"
npm run serve                 # then open http://127.0.0.1:8787
```

## 4. Commands

| Command | What it does |
|---|---|
| `npm run sync` | Gather the sources into `KB_DIR` (Dev Portal → GitLab → Confluence; GitLab uses the portal's catalog, Confluence is also queried for the project cards). Flags: `--source devportal,gitlab,confluence`, `--full` (ignore state), `--dry-run`, `--only <substring>` (entity / project path / page title), `--prune-foreign` (delete files in `kb/<source>/` that sync did not produce, e.g. old imports), `--ingest` (run ingest afterwards) |
| `npm run ingest` | Incremental index of `KB_DIR`. Shows a live progress line (percentage, chunks/s, elapsed, ETA); `--quiet` disables it. Flags: `--reset` (rebuild all), `--dry-run` (chunk stats + samples, no embedding), `--only <substring>` (subset of files), `--kb <dir>` |
| `npm run ask -- "question"` | Full pipeline, streams the answer to the terminal, prints cited sources and timings. Flags: `--k 8`, `--source-type adr,confluence`, `--kind doc,api` (api = OpenAPI/AsyncAPI definitions, project = repository cards), `--authority binding`, `--lang en`, `--json` |
| `npm run search -- "query"` | **Retrieval only** (no LLM): shows fused rank, vector rank, BM25 rank and text of each chunk. The main debugging tool — most RAG problems are retrieval problems. |
| `npm run serve` | Starts the HTTP API + web UI on `HOST:PORT` (default `127.0.0.1:8787`) |
| `npm run map` | Projects every chunk vector to 2-D with UMAP, groups the chunks into semantic clusters, places every document on the City Map (Dev Portal catalog + `taxonomy.yaml`) and writes `data/kb-map.json.gz`, rendered by the web UI at `/map.html`. Re-run after `ingest`. Flags: `--clusters 8`, `--neighbors 15`, `--min-dist 0.1`, `--epochs 400`, `--project 256`, `--seed 42`, `--out <file>`, `--relabel` (recompute names and City Map placements only, ~1 s) |
| `npm run eval` | Retrieval metrics (hit@k, MRR) over `evals/questions.jsonl`; `--answers` also grades answers by expected keywords |
| `npm run doctor` | Environment check: Ollama reachable, models pulled, kb/ present, index consistency, facets, sync sources reachable with the configured tokens |
| `npm test` / `npm run typecheck` | Unit tests (vitest) / `tsc --noEmit` |

## 5. HTTP API

All endpoints accept/return JSON. Filters are optional everywhere:
`{ "filters": { "sourceTypes": ["adr", "confluence"], "kinds": ["api"], "authorities": ["binding"], "langs": ["en"] } }`.
Citations carry `kind`, and for code chunks `lineStart`/`lineEnd` plus a `sourceUrl` with a `#L<start>-<end>` anchor.

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
been built yet. Consumed by `/map.html` (see [6.2](#62-knowledge-base-map-maphtml)). Shape:

```jsonc
{
  "version": 3, "chunks": 60633, "docs": 7101, "generatedAt": "…", "params": { … },
  "dict":      { "groups": ["confluence/TeamCore", …], "sourceTypes": […], "langs": […], "authorities": […],
                 "areas": ["Platform", …], "subareas": ["Core Services - Foundation", …], "modules": ["Workspace", …] },
  "documents": [{ "id": "<sourceId>", "title": "…", "url": "…", "path": "…", "g": 0, "s": 0, "l": 1, "a": 2, "ar": 0, "sa": 3, "mo": 12 }],
  "clusters":  [{ "id": 0, "name": "TSC OpenTelemetry Legacy", "n": 1007, "x": 1.2, "y": -3.4 }],
  "points":    { "x": [], "y": [], "doc": [], "ord": [], "cl": [], "head": [] },
  "labels":    [{ "x": 1.2, "y": -3.4, "text": "…", "n": 1007, "level": 0 }]
}
```

Document metadata is stored once and referenced by index from `points.doc`, repeated strings live in `dict`,
and per-chunk data sits in parallel arrays. `ar` / `sa` / `mo` are the document's City Map area, sub-area and
module (see [6.2](#62-knowledge-base-map-maphtml)); a document nobody can place points at the "Not in City Map" entry. Chunk ids are not shipped: a chunk id is `` `${documents[doc].id}::${ord}` ``.

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

### 6.1 Architecture page (`/architecture.html`)

A third static page explains the system itself, for onboarding and for checking that the running index matches
the description: an **animated pipeline diagram** (offline lane: sources → sync → `kb/` → loader → chunker →
embedder → LanceDB / BM25 / manifest; online lane: question → rewrite → both searches → RRF → boost/cap → prompt →
model → cited answer) whose stages open a detail panel with the keys, knobs and code paths; **live composition
bars** of the chunk table by source type, kind, authority and language (`/api/facets`); the header and stat
tiles from `/api/health`; a **retrieval probe** that runs `POST /api/search` and splits every result's RRF score
into its vector and BM25 terms; and a client-side copy of the BM25 tokenizer to try inputs against. Particles
are disabled under `prefers-reduced-motion`.

### 6.2 Knowledge base map (`/map.html`)

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

Cluster names and City Map placements are recomputed in about a second with `npm run map -- --relabel`, which
rewrites them on the existing projection instead of redoing it — worth knowing, because those are the parts you
will want to iterate on.

**Colours are the City Map.** Every document is placed on TeamSystem's City Map — `area › sub-area › module`,
the taxonomy the Dev Portal catalog maintains as `kind: area / module / component` entities — and the map is
coloured by sub-area by default ("Core Services - Foundation", "Integration", "Tax", …), with the area and the
module levels one dropdown away; the module level is the product level (*Cassa in Cloud*, *Workspace*, *IAM (TS
ID)*). Placement is automatic for everything the catalog describes (`src/citymap.ts`): a Dev Portal page belongs
to its entity's module, a repository to the module of the component whose `catalog-info` points at it, and a
document whose owning team keeps all its modules in one sub-area inherits that sub-area. `taxonomy.yaml` covers
the rest — Confluence spaces and GitLab groups without a catalog entry — with a few dozen rules that name the City
Map node they belong to (`match` on source, path glob, space, ancestor title or owner → `module` / `subarea` /
`area`). The catalog copy is saved by `npm run sync` in `data/sync/devportal.json`; without it the rules alone
still run, and a map with no placements falls back to colouring by semantic cluster. Documents nobody can place
are an explicit *Not in City Map* legend entry, never silently mixed in; `npm run map` prints how many were
placed and by which route (catalog entity, repository, rule, owner).

**Semantic clusters are still computed and drawn as labels.** Before UMAP runs, the vectors are grouped with
spherical k-means (`--clusters`, 8 by default) and each cluster is named after the words that are frequent
inside it and rare elsewhere (TF-IDF over titles and heading paths, counting each term once per document so one
verbose page cannot name a whole cluster, and discarding terms that appear in every cluster, which is what stops
corpus boilerplate such as "Analisi Funzionale" from becoming every label). A cluster name is a *topic* — "TSC
OpenTelemetry Legacy", "Analisi Funzionale Finanza" — drawn on the map at the cluster's centre, and **colour:
meaning** colours by it, which is the way to see where the embedding disagrees with the City Map. The
clustering runs on the embedding vectors, not on the 2-D coordinates, so it is not distorted by the projection.
Colour by space, source type, language or authority is also available.

**Reading a source.** Hovering a dot shows its title, heading path, module, cluster and space. Clicking it fills the
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
 Developer Portal (Backstage)          GitLab (biosphere)                          Confluence Cloud (v2 API)
 /api/catalog/entities  ─┐             /api/v4/groups/*/projects  + the repos       /wiki/api/v2/spaces?keys=…
 /api/techdocs/metadata  │ etag        the portal points at (/projects/:path)       /spaces/{id}/pages (cursor)
 /api/techdocs/static/…  │ HTML        /repository/branches/{default} (head)         /folders/{id} (ancestry)
          │              ▼             /repository/tree (blob sha) → files/…/raw     /pages/{id}?body-format=export_view
          │  coveredRepos + repoEntities ───► owner/system per repo, skip docs/**             │
          ▼                                        ▼                                          ▼
   exclude_pages globs, generated-page    *.md → doc · openapi*/asyncapi* → api       exclude_trees / exclude_titles,
   and stub heuristics; html → md         README+langs+entity+wiki hits → card         stubs; html → md, ancestors → breadcrumb
          └────────────────────────────► rules (sources.yaml) → duplicate-body skip → kb/<source>/… + data/sync/<source>.json
```

| Source | What is indexed | Id / file | Incremental key |
|---|---|---|---|
| **devportal** | every TechDocs page of every catalog entity with `backstage.io/techdocs-ref`, plus the OpenAPI/AsyncAPI definition of `API` entities (`kind: api`) — minus `devportal.exclude_pages` (the generated Swagger/Sphinx reference trees, ~6 000 pages), pages that look generated and pages without prose | `devportal:<ns>/<kind>/<name>/<page/>` → `kb/devportal/<kind>/<name>/<page>.md` | TechDocs `etag` + a hash of the page filters (whole entity skipped when unchanged) |
| **gitlab** — docs (`kind: doc`) | `gitlab.docs.include` globs (`*.md`, `*.mdx`…) in every project of `gitlab.groups` (recursive), `gitlab.projects` and — with `include_devportal_repos` — every repository the portal catalog points at, minus `exclude_projects` (training, demos, playgrounds, PoCs, the old KB export…), `docs.exclude` (licences, changelogs, `CLAUDE.md`/`AGENTS.md`, templates, tests…), generator READMEs and pages without prose; for repositories the portal renders, `docs/**` is skipped but READMEs and the rest are kept | `gitlab:<group/project>:<path>` → `kb/gitlab/<group>/<project>/<path>` | default-branch head commit + a hash of the file settings (whole project skipped when unchanged), then blob sha per file |
| **gitlab** — API contracts (`kind: api`) | `openapi*`, `swagger*`, `asyncapi*` YAML/JSON files (`gitlab.api_specs`) whose body really is an OpenAPI/AsyncAPI document: the `info.title`/`description` and a fenced copy of the spec | `gitlab:<group/project>:<path>` → `kb/gitlab/<group>/<project>/<path>.md` | blob sha |
| **gitlab** — project card (`kind: project`) | one per repository: GitLab description/topics/languages, the Dev Portal entity (owner, system, lifecycle, description — via the portal's `repoEntities`), a README excerpt, top-level folders, the number of source files, and the Confluence pages found by searching the project name | `gitlab:<group/project>:__project` → `kb/gitlab/<group>/<project>/__project.md` | sha of the rendered card |
| **gitlab** — code (`kind: code`, **off**) | `gitlab.code.enabled: true` indexes every source file as one fenced block, chunked at declaration boundaries with `#L<start>-<end>` deep links. Off by default: it was ~90 % of the files and noise for a technical Q&A corpus | same id → `kb/gitlab/<group>/<project>/<path>.md` | blob sha |
| **confluence** | every current page of the spaces in `confluence.spaces.include`, minus pages that sit under an excluded tree (`exclude_trees`: page/folder ids or title wildcards matched against the page and every ancestor — sprint ceremonies, meetings, drafts, archives, org material, the CTO copies of the ADRs), minus `exclude_titles`, minus pages without prose; optional `roots` per space and `modified_since`. Bodies come from `export_view` (macros rendered), TOC/page-tree macros are stripped, and the space + ancestor titles become the page's `breadcrumb` | `confluence:<SPACE>:<pageId>` → `kb/confluence/<SPACE>/<pageId>-<slug>.md` | page version number + a hash of the quality thresholds |

Scale on 2026-09-09 with one user's tokens: 267 portal entities with TechDocs plus 131 API entities → **2 319**
pages kept (6 360 skipped, of which ~6 150 generated reference); 462 GitLab repositories (351 in
`oneplatform`, the rest portal-referenced) → **2 208** documents; 7 Confluence spaces → **599**
pages of 1 311 listed. Repository archives are refused by this GitLab (HTTP 406), so files are
downloaded one by one with `SYNC_CONCURRENCY` parallel requests. Later runs are fast: an unchanged repository
costs one branch request, an unchanged entity one metadata request, an unchanged space one paginated listing.

Why the portal first: it is populated from GitLab by CI, so it renders documentation from repositories you
have no access to, and its TechDocs HTML is already the "published" view. It also knows who owns what, which the
GitLab connector copies onto the project cards. Why GitLab too: READMEs, ADRs and in-repo docs that are not
published as TechDocs, plus the API contracts and the cards. Why Confluence, selectively: functional and
technical analyses of the core services (TS ID, Policy Manager, Hermes, Metering, Registry, One Back Office)
exist only there, buried in spaces that are mostly meeting notes — hence whole spaces with hard tree filters
rather than a curated page list that would go stale.

Every document gets the frontmatter the ingest expects (`source_id`, `source_type`, `kind`, `title`, `source_url`,
`authority`, `lang`, `last_modified`, `fetched_at`, `fingerprint`, `breadcrumb`) plus source-specific fields
(`entity`, `owner`, `system`, `project`, `file_path`, `api_type`, `space`, `ancestors`, `labels`,
`confluence_pages`…). `authority` and `source_type` are decided by the **rules** in `sources.yaml` (first match
wins; e.g. `gitlab:oneplatform/adrs:*` → `source_type: adr, authority: binding`); rules can also `skip` documents
by id, URL or title (licences, AI-assistant files, generator READMEs). `lang` is detected from function words
(it/en/und, the embedding model is multilingual so nothing is translated). Markdown identifiers are **not**
escaped (`subject_token` stays one BM25 token) and images become `[image: alt]`.

The content heuristics live in `src/sync/quality.ts`: `proseStats` counts words outside code fences, tables,
headings and link-only lines; `isStub` skips pages with too few of them and no real table or code;
`looksGenerated` recognises Swagger/Sphinx/JavaDoc output by title and body markers; `isBoilerplateReadme`
recognises project-generator READMEs. The orchestrator additionally drops a document whose normalised body is
identical to one already written in the same run (the same README in ten repositories, a page copied into two
spaces), and every skip — with its reason — is counted in the log and listed in `data/sync/<source>.skipped.jsonl`.

Safety rails: a source that aborts (network, expired token) never deletes anything; `--only` never deletes;
files in `kb/<source>/` that sync does not know about are reported but only removed with `--prune-foreign`;
files are rewritten only when their content changed, so `npm run ingest` stays incremental.

**Credentials** (all read-only, all in `.env`):

* `DEVPORTAL_TOKEN` — Backstage identity token. `./refresh-dev-portal-token.sh` prints a fresh one using the
  browser's Microsoft refresh-token cookie (or: log in to the portal, DevTools → Network, copy the
  `Authorization: Bearer …` value of any `/api/…` request). User tokens expire after about an hour, enough for a
  full run; for unattended runs ask the portal team for a static token (`backend.auth.externalAccess`).
* `GITLAB_TOKEN` — personal access token with the `read_api` scope (GitLab → Preferences → Access Tokens).
* `CONFLUENCE_EMAIL` + `CONFLUENCE_API_TOKEN` — Atlassian API token from
  <https://id.atlassian.com/manage-profile/security/api-tokens>, used both to index the configured spaces and for
  the project-card lookups. Scoped tokens (the default kind since 2025) are rejected by the site URL and only work
  through `api.atlassian.com/ex/confluence/<cloudId>`; the connector detects this and switches automatically
  (`CONFLUENCE_CLOUD_ID` forces it).

### 7.1 Loading & metadata (`src/ingest/loader.ts`)

Every file in `kb/` carries a YAML frontmatter written by sync (or by hand in `kb/manually-curated/`). We use:

| Frontmatter | Used for |
|---|---|
| `source_id` | Stable chunk ids (`<source_id>::<n>`), incremental delete/replace |
| `source_type` (`devportal`, `gitlab`, `adr`, `confluence`, `manually-curated`) | Filtering (`--source-type`, UI chips) |
| `kind` (`doc`, `api`, `project`, `code`) | Chunking strategy, filtering (`--kind`, UI chips) |
| `title`, `source_url` | Breadcrumb root in every chunk, citation links |
| `breadcrumb` | Where the document lives (`Confluence › TeamCore › TS ID - Feature`, `GitLab › oneplatform/adrs`, `Dev Portal › Hermes`); prepended to every chunk's heading path |
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
* Each chunk's embedding text is prefixed with a heading path `Breadcrumb > Title > H2 > H3` so it is
  self-describing when read out of context ("Decision" alone means nothing; `GitLab › oneplatform/adrs > ADR0010
  Client Credentials > Summary > Decision` does). The breadcrumb comes from the frontmatter written by sync and
  names the system and the tree the document lives in — the cheap, deterministic stand-in for the LLM-written
  chunk contexts this project used to generate (see 7.3).
* Heading-only pages produce no chunks (they are logged and skipped).

Source files (`kind: code`, only when `gitlab.code.enabled`) use `chunkCode` instead: the file is cut at
**top-level declarations** once a chunk reaches `CODE_CHUNK_TARGET_TOKENS` (600), at blank lines when no
declaration is near, and hard-cuts only past `CODE_CHUNK_MAX_TOKENS` (900). Every chunk keeps the fence and
language tag, records its 1-based line range (→ `#L10-45` citation links) and gets a
`repo > path/to/file.ts > symbolA, symbolB` breadcrumb from the symbols it declares.

`npm run ingest -- --dry-run` prints size statistics and sample chunks, so you can see the effect of the
`CHUNK_*` settings before spending model time.

### 7.3 Why there is no contextual retrieval stage

Until 2026-09-09 every chunk was prefixed with 1–2 sentences written by a small chat model that had seen the
whole document ([contextual retrieval](https://www.anthropic.com/engineering/contextual-retrieval)). It was
~7 of the ~8 hours a full ingest took, and on this knowledge base it did not measurably help: a synthetic
retrieval benchmark on the same chunks scored contexts **off** at 94 % hit@6 / MRR 0.853 against contexts **on**
at 92 % / 0.833 (n=100, a tie within the error bar). The reason is that the indexed text already carried what a
context would say — the heading path names the document, the section and (now) the system and tree it lives in.
The stage, its cache, its model and its dozen `CONTEXT_*` knobs were therefore removed; the `breadcrumb`
frontmatter and the heading-path prefix (7.2) are what remains of the idea.

### 7.4 Embeddings (`src/llm/embeddings.ts`)

[Qwen3-Embedding](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) via Ollama, multilingual (Italian +
English in the same space), 32k context. The default is the **0.6b** (1024 dimensions): embedding touches
every chunk and is prompt-bound, which makes the model size a hard floor on ingest time — 2.9 chunks/s for
the 8b against 24 chunks/s for the 0.6b on an M5 Pro. `:8b` (4096 dims) is the quality ceiling if you can spend
the hours (about 2 points of hit@6 in our benchmark for 8× the time). Two model-specific details:

* It is **instruction-aware**: queries are embedded as `Instruct: <task>\nQuery: <question>`; documents are
  embedded as-is. Getting this asymmetry right is worth several points of recall.
* It is **Matryoshka-trained**: the first N dimensions are themselves a good embedding, so
  `EMBEDDING_DIMENSIONS` may be set below what the model emits (1024 for the 0.6b/4b, 4096 for the 8b) to
  shrink the vector index — we truncate + renormalise client-side. It may never exceed the model's width.

Documents are embedded in batches of about `INGEST_BATCH_CHUNKS` chunks (`EMBED_BATCH_SIZE` texts per
`/api/embed` call); the manifest is written after each batch, so an interrupted ingest resumes where it stopped.

### 7.5 Storage (`src/store/`)

* **LanceDB** (`data/lancedb/`): embedded, file-based, Apache Arrow columns, native Apple-Silicon binary.
  One table `chunks` with the vector plus all metadata columns, so filters are plain SQL-like predicates
  (`source_type IN ('adr')`, `kind IN ('api')`). No ANN index is created: with tens of thousands of vectors a
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
cover the question, cite `[n]` after each claim, prefer binding sources, name repository + file when answering
from a repository document, reply in the user's language — followed by the numbered context blocks (each with
its heading path, source type, kind, authority and URL). Previous turns (last 6) are appended so follow-ups
work; the new question comes last.

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
| `EMBED_BATCH_SIZE` | `16` | Texts per `/api/embed` call |
| `INGEST_BATCH_CHUNKS` | `256` | Documents are embedded in batches of about this many chunks; the manifest is flushed after each batch |
| `CHAT_MODEL` | `qwen3:8b` | Any Ollama chat model (e.g. `ornith-1.5:9b`, `gemma3:12b`, `qwen3:14b`) |
| `CHAT_THINK` | `false` | Default reasoning mode; per request, override with `"think": true` or the UI's **Reasoning** button |
| `CHAT_NUM_CTX` | `16384` | Context window requested from Ollama; 6 chunks × 450 tok + prompt + history fits easily |
| `CHUNK_TARGET_TOKENS` / `CHUNK_MAX_TOKENS` / `CHUNK_OVERLAP_TOKENS` | `450` / `700` / `60` | Prose chunking; changing them triggers a full rebuild |
| `CODE_CHUNK_TARGET_TOKENS` / `CODE_CHUNK_MAX_TOKENS` | `600` / `900` | Source-file chunking (cut at declarations); only used with `gitlab.code.enabled: true` |
| `RETRIEVAL_CANDIDATES` / `RETRIEVAL_TOP_K` | `24` / `6` | Candidates per retriever before fusion / chunks sent to the LLM |
| `RETRIEVAL_VECTOR_WEIGHT` / `RETRIEVAL_BM25_WEIGHT` | `1.0` / `1.0` | RRF weights |
| `RETRIEVAL_MAX_CHUNKS_PER_DOC` | `3` | Diversity cap |
| `RERANK` | `none` | `llm` for the LLM rerank stage |
| `QUERY_REWRITE` | `true` | Rewrite follow-ups into standalone queries |
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Set `HOST=0.0.0.0` to reach the UI from other machines on the LAN |
| `EMBEDDING_PROVIDER` / `CHAT_PROVIDER` | `ollama` | `mock` runs the whole pipeline without Ollama (tests/CI) |
| `SOURCES_FILE` | `./sources.yaml` | Scope, filters and rules for `npm run sync` |
| `TAXONOMY_FILE` | `./taxonomy.yaml` | City Map placements for sources the Dev Portal catalog does not describe (Confluence spaces, uncatalogued GitLab groups); used by `npm run map` |
| `DEVPORTAL_BASE_URL` / `DEVPORTAL_TOKEN` | `https://development.teamsystem.com` / — | Backstage bearer token (see 7.0; `./refresh-dev-portal-token.sh`) |
| `GITLAB_BASE_URL` / `GITLAB_TOKEN` | `https://biosphere.teamsystem.com` / — | PAT with `read_api` |
| `CONFLUENCE_BASE_URL` / `CONFLUENCE_EMAIL` / `CONFLUENCE_API_TOKEN` | `https://teamsystem.atlassian.net` / — / — | Atlassian API token (classic or scoped): indexes the configured spaces and enriches the project cards |
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

**Ingest is slow.** It is embedding-bound, and it does not get faster by issuing more requests: Ollama on
Metal time-slices concurrent work instead of batching it, so aggregate throughput is a constant per model.
Budget the run as *chunks ÷ chunks-per-second* and pick the model accordingly. Measured on an M5 Pro:

| Embedder | Throughput | Whole KB (40 406 chunks) |
|---|---|---|
| `qwen3-embedding:0.6b` @1024d (default) | ~24 chunks/s | **~28 min** |
| `qwen3-embedding:8b` @4096d | ~2.9 chunks/s | ~3.9 h |

In a synthetic retrieval benchmark (`scripts/bench/`: the chat model writes one question per chunk, we measure
how often that chunk comes back in the top 6) the 8b bought about 2 points of hit@6 over the 0.6b for 8× the
time — the reason the 0.6b is the default. Levers if it is still too slow: `EMBEDDING_MODEL`, a narrower
`sources.yaml` (more `exclude_projects`, fewer Confluence spaces, `roots` per space), larger
`CHUNK_TARGET_TOKENS`. The run is resumable, so it is fine to stop it and pick it up later.

**Memory.** `qwen3-embedding:0.6b` (~1.5 GB) and `qwen3:8b` (~6 GB) stay loaded together comfortably. Ollama
unloads idle models after 5 minutes; the first request after idling pays a few seconds of load time. If you move
to a 14B chat model, keep `CHAT_NUM_CTX` at 16k or lower.

**Answers miss things that are in the docs.** Run `npm run search -- "<question>"` and look at the `vec=` /
`bm25=` ranks. If the right chunk is found by only one retriever, adjust the weights. If it is not found at all,
the chunk is probably too big/mixed — lower `CHUNK_TARGET_TOKENS` — or the question uses vocabulary the docs do
not (add a glossary page to `kb/manually-curated`, which is exactly what those files are for). If the document
is simply not in `kb/`, check `data/sync/<source>.skipped.jsonl`: a filter in `sources.yaml` may have dropped it.

**Answers are polluted by noise.** The filters in `sources.yaml` are the lever: `devportal.exclude_pages`,
`gitlab.exclude_projects` / `docs.exclude`, `confluence.exclude_trees` / `exclude_titles`, and the
`min_prose_words` thresholds. Skipped documents are listed with their reason next to the sync state.

**Answers hallucinate.** Lower `CHAT_TEMPERATURE` (0–0.2), reduce `RETRIEVAL_TOP_K` so irrelevant chunks do not
dilute the context, or enable `RERANK=llm`.

**Follow-ups retrieve the wrong thing.** Check the `Search query:` status line printed by `ask`; if the rewrite
is poor, disable `QUERY_REWRITE` or improve the prompt in `src/generation/ask.ts`.

**Endpoint questions land on prose (or vice versa).** Use the `kind` filter: `--kind api` / the UI chip
restricts retrieval to OpenAPI/AsyncAPI definitions, `--kind project` to the repository cards ("who owns X",
"what is X"), `--source-type confluence` to the wiki analyses.

**Access control.** `RetrievalFilters` already filters at query time; to enforce permissions, map the caller's
identity to allowed `sourceTypes` / `kinds` (or add a column, e.g. Confluence space) in the API layer before
calling `retriever.retrieve()`.

## 11. Project layout

```
ai-wiki/
├── kb/                          the knowledge base (markdown + frontmatter): kb/{devportal,gitlab,confluence} are written
│                                by `npm run sync` (gitlab holds docs, API specs and __project.md cards), kb/manually-curated/ by hand
├── ARCHITECTURE.md              the knowledge base end to end: sources, filters, kinds, incremental keys, storage
├── sources.yaml                 what sync gathers (portal excludes, GitLab groups/globs, Confluence spaces + tree filters) and rules
├── taxonomy.yaml                City Map placements for what the catalog does not describe (Confluence spaces, uncatalogued GitLab groups)
├── refresh-dev-portal-token.sh  prints a fresh Dev Portal bearer token (user tokens last ~1 h)
├── data/                        generated index (LanceDB, BM25, manifest, kb-map.json.gz) and data/sync/ state + skipped lists — git-ignored
├── evals/questions.jsonl        evaluation set
├── scripts/setup-ollama.sh      pulls the two models · scripts/bench/ retrieval and embedding benchmarks
├── src/
│   ├── config.ts                env → typed config
│   ├── citymap.ts               the City Map (catalog areas › modules › components) + taxonomy.yaml rules → where a document sits
│   ├── types.ts                 shared types (Chunk, RetrievedChunk, Citation, AskEvent…)
│   ├── llm/
│   │   ├── ollama.ts            /api/embed + streaming /api/chat client (no SDK)
│   │   ├── embeddings.ts        Qwen3 query instruction, Matryoshka truncation, mock embedder
│   │   └── chat.ts              chat provider (Ollama | mock)
│   ├── sync/
│   │   ├── index.ts             orchestrator: run connectors, apply rules, skip duplicates, write kb/, prune, persist state
│   │   ├── devportal.ts         Backstage catalog + TechDocs connector (page excludes, generated/stub gates; emits coveredRepos, repoEntities, citymap)
│   │   ├── gitlab.ts            GitLab connector: docs, API specs, project cards, optional code (head-commit incremental)
│   │   ├── confluence.ts        Confluence v2 source connector (spaces, ancestry, tree filters) + the CQL lookup for the cards
│   │   ├── quality.ts           prose statistics, stub / generated-page / boilerplate-README / duplicate heuristics
│   │   ├── project-card.ts      the per-repository card (GitLab + Dev Portal + README + Confluence hits)
│   │   ├── code.ts              language map, junk detection, fenced rendering, declaration/symbol regexes (code kind)
│   │   ├── html.ts              cheerio + turndown HTML → markdown (code panels, tables, admonitions)
│   │   ├── sources-config.ts    sources.yaml parsing, globs, rules
│   │   ├── kb-writer.ts         frontmatter rendering, slugs
│   │   ├── http.ts              fetch with retries/backoff, concurrency limiter
│   │   └── lang.ts, state.ts, types.ts
│   ├── ingest/
│   │   ├── loader.ts            file walk, frontmatter parsing, metadata (kind), cleaning
│   │   ├── chunker.ts           markdown block parser + heading-aware packing (breadcrumb prefix); declaration-aware code chunking
│   │   ├── manifest.ts          incremental-ingest bookkeeping
│   │   └── pipeline.ts          orchestrates load → chunk → embed → store → BM25 rebuild, in batches
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
│       ├── public/map.html      2-D map: City Map colours, cluster labels, density LOD (canvas, no build step)
│       └── public/architecture.html  interactive architecture page: animated pipeline, live facets, RRF probe
└── tests/                       vitest unit tests (chunkers, loader, BM25, prompt, sync connectors with fake fetch)
```

Design choices worth knowing: no LangChain/LlamaIndex (the whole pipeline is a few thousand lines you can read
in an afternoon and every stage is swappable); no Ollama SDK (two `fetch` calls); a mock provider so the full
pipeline — ingest, storage, retrieval, API, UI — runs in tests and CI without models.

## 12. Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot reach Ollama at http://127.0.0.1:11434` | Start Ollama (`ollama serve` or the app). `npm run doctor` |
| `model "qwen3-embedding:0.6b" not found` | `ollama pull qwen3-embedding:0.6b` (same for the chat model) |
| `The index is empty. Run npm run ingest first.` | Exactly that |
| `Existing index is incompatible (...) rebuilding` | Expected after changing embedding model/dims or chunk sizes |
| `[devportal] ... HTTP 401 ... Missing credentials` | `DEVPORTAL_TOKEN` missing or expired (user tokens last ~1 h): `./refresh-dev-portal-token.sh`, or use a static token |
| `[confluence] ... HTTP 401 ...` | Scoped API token; the connector falls back to the `api.atlassian.com` gateway by itself. If the gateway also fails, check `CONFLUENCE_EMAIL` and the token's Confluence read/search scopes |
| `confluence.spaces.include is empty` | List the space keys to index in `sources.yaml` (or set `confluence.enabled: false`) |
| `ancestor page <id> is not readable; its children are treated as roots` | The token cannot see a parent page/folder; tree filters on *that* ancestor cannot apply. Exclude the children by id or title if needed |
| A page you expected is missing from `kb/` | `grep <title-or-id> data/sync/<source>.skipped.jsonl` shows the filter that dropped it; adjust `sources.yaml` and re-run sync |
| `sources.yaml: "gitlab.include" is no longer supported` | The 2026-09-09 layout moved the globs to `gitlab.docs` / `gitlab.code`; the error names the new key |
| `[gitlab] ... repository/archive... HTTP 406` | Expected on this instance (archives disabled); files are downloaded one by one |
| `N of M Dev Portal repositories outside the configured groups are readable` | Normal: `include_devportal_repos` asks for every repository the portal knows; the token cannot read them all |
| `[gitlab] group X: HTTP 404` | The token cannot see that group; remove it from `sources.yaml` or list the projects you can see under `gitlab.projects` |
| `N file(s) in gitlab/ were not produced by sync` | Old imports in `kb/<source>/`; check them, then `npm run sync -- --prune-foreign` |
| Ingest interrupted (Ctrl-C, sleep) | Just run `npm run ingest` again; it resumes from the manifest |
| Answers in the wrong language | The prompt mirrors the question's language; ask in the language you want |
| `vector and keyword index sizes differ` in doctor | `npm run ingest` (rebuilds BM25 from the table) |
| Slow first answer after idle | Ollama reloading the model into memory; raise `keep_alive` in `src/llm/ollama.ts` if it bothers you |

## 13. Roadmap / ideas

* **Regenerate `evals/questions.jsonl`**: most of its ids still point at the pre-2026-09 export (Confluence page
  ids and ADR file names have been remapped where the mapping was mechanical; the `git-md:` cases have not).
* **Cross-encoder reranker** (e.g. `bge-reranker-v2-m3` through a small Python sidecar or ONNX) instead of the
  LLM rerank — better precision at lower latency.
* **More sources**: the loader only needs markdown + frontmatter, so anything exported as such (Jira, tickets,
  PDFs converted with Docling/MarkItDown) plugs in unchanged. Legacy Confluence spaces (TPAAS, TSDIGITAL) are one
  `spaces.include` entry away if their PaaS-era content turns out to be needed.
* **Per-user permissions** at the API layer, mapping identity → allowed source types / spaces.
* **Feedback loop**: thumbs up/down in the UI appended to `evals/questions.jsonl`.
