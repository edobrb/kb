# Knowledge base architecture

How a page in the Developer Portal or a file in a GitLab repository becomes a citable answer. This is the
map of the system; the [README](README.md) has the operating instructions (commands, configuration, tuning),
and §7 there explains each stage in prose.

Two systems are indexed — the **Developer Portal** (Backstage/TechDocs) and the **GitLab `oneplatform`
group**, including its **source code** — and one is only consulted: **Confluence**, which enriches the
per-repository project cards but whose pages are not documents in the index. Every chunk is stored with a
short model-written context that says where it belongs
([contextual retrieval](https://www.anthropic.com/engineering/contextual-retrieval)).

## The pipeline

```
                         SYNC  (npm run sync, incremental, → kb/*.md with frontmatter)
 ┌─────────────────────────────┐   ┌────────────────────────────────────────────┐   ┌──────────────────────────────┐
 │ Developer Portal (Backstage)│   │ GitLab  biosphere / group oneplatform      │   │ Confluence Cloud (lookup only)│
 │ catalog entities + TechDocs │   │ per repo: head commit → tree → raw files   │   │ /rest/api/search?cql=title~  │
 │ html → markdown             │   │  *.md  ──────────► kind: doc               │   │ then text~ (R&D spaces)      │
 │ OpenAPI defs → kind: api    │   │  source files ───► kind: code (fenced)     │   │ top 3: title, link, snippet  │
 │ coveredRepos, repoEntities ─┼──►│  README+langs+entity+wiki hits ► card      │◄──┤                              │
 └──────────────┬──────────────┘   │                    (kind: project)         │   └──────────────────────────────┘
                │                  └──────────────────────┬─────────────────────┘
                ▼                                         ▼
   kb/devportal/<kind>/<name>/*.md          kb/gitlab/<group>/<project>/{**/*.md, **/*.ext.md, __project.md}
                            + kb/manually-curated/*.md (hand-written, never touched)
                                             │
                         INGEST (npm run ingest, batches of 256 chunks, resumable)
                                             ▼
   doc/api/project ──► heading-aware chunker ("Title > H2")      code ──► declaration-aware chunker
                                             │                             ("repo > file > symbols", L<start>-<end>)
                                             ▼
   contextual retrieval: chat model sees  [project card | entity]  +  the document as <chunk id=N> markers
                         → one call per group, 1 line per chunk  (cache: data/contexts/<shard>/<docHash>.json)
                         single-chunk docs & cards → deterministic sentence, no LLM
                                             │  text = breadcrumb ⏎ context ⏎ content
                                             ▼
   qwen3-embedding:0.6b ──► LanceDB data/lancedb (vector + kind, context, line_start/end, …)
                          BM25   data/bm25.json.gz (rebuilt from the table)   manifest data/manifest.json
                                             │
                         ASK  (CLI · /api/ask SSE · web UI)
                                             ▼
   query rewrite → embed query + BM25 → RRF fusion → authority boost → per-doc cap → filters (source_type, kind, lang)
   → prompt with numbered blocks (heading, lines, kind, url, "about: <context>", content) → chat model → [n] citations
```

## Sources

| Source | What it contributes | Credentials |
|---|---|---|
| **Developer Portal** `development.teamsystem.com` | Every TechDocs page of every catalog entity with `backstage.io/techdocs-ref`, plus the OpenAPI/AsyncAPI definition of `API` entities. Also exports `coveredRepos` and `repoEntities` (owner, system, lifecycle, description per repository) for the GitLab connector. It is populated from GitLab by CI, so it covers repositories the token cannot read. | `DEVPORTAL_TOKEN` (Backstage bearer, user tokens last ~1 h) |
| **GitLab** `biosphere.teamsystem.com` | Everything in the `oneplatform` group: markdown docs, source files, and one project card per repository. Archives are refused by this instance (HTTP 406), so files are downloaded individually with `SYNC_CONCURRENCY` parallel requests. | `GITLAB_TOKEN` (`read_api`) |
| **Confluence** `teamsystem.atlassian.net` | **Not indexed.** Searched per repository (`title ~` first, then `text ~`, scoped to `confluence.spaces.include`, personal spaces dropped) for pages that mention the project; the top hits land on the card. Optional: without it, cards simply have no "Related Confluence pages". | `CONFLUENCE_EMAIL` + `CONFLUENCE_API_TOKEN` (scoped tokens routed through `api.atlassian.com` automatically) |
| **`kb/manually-curated/`** | Hand-written glossary, manifesto, design principles, product catalog. Never written or deleted by sync. | — |

Scope, file globs and authority rules live in [`sources.yaml`](sources.yaml).

## Document kinds

`kind` is frontmatter, decides the chunking strategy and whether the chunk goes to the contextualizer, and is
a retrieval filter end to end (`--kind`, `filters.kinds`, UI chips).

| kind | Body | Id → file | Chunked by |
|---|---|---|---|
| `doc` | Prose markdown: TechDocs page, README, ADR, in-repo documentation | `gitlab:<project>:<path>` → `kb/gitlab/<project>/<path>`; `devportal:<ns>/<kind>/<name>/<page/>` → `kb/devportal/…` | headings, ~450 tokens |
| `code` | One fenced block with the language tag, the file verbatim | `gitlab:<project>:<path>` → `kb/gitlab/<project>/<path>.md` | top-level declarations, ~600 tokens |
| `project` | The repository card: description, Dev Portal entity (owner/system/lifecycle), languages, top-level folders, README excerpt, related Confluence pages | `gitlab:<project>:__project` → `kb/gitlab/<project>/__project.md` | headings (never contextualized) |
| `api` | OpenAPI/AsyncAPI definition in a fenced block | `devportal:<ns>/api/<name>#definition` → `kb/devportal/api/<name>/__definition.md` | headings |

Frontmatter every document carries: `source_id`, `source_type`, `kind`, `title`, `source_url`, `authority`,
`lang`, `last_modified`, `fetched_at`, `fingerprint`, plus source-specific fields (`project`, `file_path`,
`language`, `lines`, `blob_sha`, `entity`, `owner`, `system`, `confluence_pages`…). A file without
frontmatter still works: title from the first `#`, source type from the folder, kind `doc`.

## What triggers re-work

Everything is incremental, and each stage has its own key. Nothing is redone unless its key changed.

| Stage | Key | Effect when it changes |
|---|---|---|
| Portal entity | TechDocs `etag` | The entity's pages are re-downloaded; otherwise one metadata request per entity |
| GitLab repository | default-branch head commit + hash of (portal coverage, portal entity, `gitlab.docs`, `gitlab.code` settings) | The tree is listed again; otherwise one branch request per repository |
| GitLab file | blob sha | That file is downloaded again |
| Project card | sha256 of the rendered card | The card document is rewritten |
| Confluence enrichment | `confluence.refresh_days` per project | The wiki is searched again for that project |
| Ingest of a document | sha256 of the file bytes (manifest) | Re-chunked, re-contextualized where needed, re-embedded |
| Chunk context | sha1 of the chunk content + `CONTEXT_MODEL` + `CONTEXT_PROMPT_VERSION` | Only the changed chunks of an edited file go back to the model |
| Whole index | embedding model, dimensions, chunk sizes, `CONTEXTUALIZE` | Full rebuild, reusing the cached contexts |

Safety rails: a source that aborts (network, expired token) deletes nothing; `--only` never deletes; files
in `kb/<source>/` that sync does not know about are reported and removed only with `--prune-foreign`; a file
is rewritten only when its content changed, so a sync that finds nothing new leaves ingest with nothing to do.

## Contextual retrieval

A chunk embedded alone loses what it belongs to — "retries: 3", "returns the tenant" — which hurts code most.
Before indexing, a chat model writes 1–2 sentences per chunk from two things, in this prompt order:

1. **background** — the project card for repository files (its essentials come first so truncation keeps
   them), the catalog entity for portal pages, a one-liner otherwise;
2. **the document, rendered once**, split into its own chunks inside `<chunk id="N">` markers, with the
   instruction to write one line per id, keeping identifiers verbatim.

**One call situates a group of chunks**, not one call per chunk, because generation does not parallelise on
Ollama/Metal (aggregate throughput is a constant per model) — so the stage costs what it generates plus what
it re-reads, and sending each chunk separately re-reads the document every time. Groups are cut at
`CONTEXT_GROUP_CHARS` (`_API` for dense reference pages). An id the model skips or truncates is re-asked on
its own with the single-chunk prompt.

The sentences are prepended to the chunk for **both** the vector and the BM25 index
(`text = breadcrumb ⏎ context ⏎ content`), kept in their own column, shown under each citation, and given to
the answering model as `about: …`. Skipped, because there is nothing to situate: documents under
`CONTEXT_MIN_CHUNKS` (`_CODE` for source files), project cards, and kinds outside `CONTEXT_KINDS`; those get
a deterministic sentence built from the frontmatter and the card, which is also the fallback when a
generation fails.

This is still the slow stage — about 7 of the ~8 hours a full ingest takes — and the reason the scope is
`oneplatform` only. See README §10 for the levers and what each one measured.

## Storage

* **LanceDB** `data/lancedb/` — one `chunks` table, embedded and file-based. Columns: `id`, `source_id`,
  `source_type`, `kind`, `title`, `source_url`, `authority`, `lang`, `last_modified`, `rel_path`, `ordinal`,
  `heading_path`, `context`, `content`, `text`, `line_start`, `line_end`, `vector`. Filters are SQL-like
  predicates (`kind IN ('code')`); no ANN index, a brute-force cosine scan at this scale is exact and fast.
* **BM25** `data/bm25.json.gz` — Okapi BM25 rebuilt from the table after every ingest, so the two indexes
  cannot drift. The tokenizer folds accents and splits alphanumeric codes (`ADR0010` → `adr0010`, `adr`, `0010`).
* **Manifest** `data/manifest.json` — what is indexed, with content hashes and chunk counts. Flushed every
  few seconds, which is what makes an interrupted ingest resumable.
* **Contexts** `data/contexts/<shard>/<sha1(source_id)>.json` — the generated chunk contexts.
* **Sync state** `data/sync/<source>.json` — per-source item fingerprints and connector memory
  (`coveredRepos`, `repoEntities`, `projectHeads`, `projectEnrichment`).

## Answering

Hybrid retrieval, then generation: vector search and BM25 each return `RETRIEVAL_CANDIDATES` chunks,
Reciprocal Rank Fusion merges them (`score = Σ weight / (60 + rank)`), binding/normative documents get a
+15 %/+12 % boost, a per-document cap keeps one long file from filling the context, and `RETRIEVAL_TOP_K`
chunks reach the model. Each context block carries its heading path, line range, kind, authority, URL and
`about:` context; the prompt requires citations, forbids outside knowledge, and asks for the repository, file
and quoted lines when the answer comes from code. Code citations deep-link to `#L<start>-<end>` on the
GitLab blob.

## Where the code lives

```
src/sync/          index.ts (orchestrator, connector + enricher definitions)
                   devportal.ts · gitlab.ts · confluence.ts (CQL lookup, not a source)
                   project-card.ts (the per-repository card) · code.ts (languages, junk detection, symbols)
                   sources-config.ts (sources.yaml, globs, rules) · kb-writer.ts · html.ts · http.ts · state.ts
src/ingest/        loader.ts (frontmatter, kinds) · chunker.ts (prose + code)
                   contextualize.ts (background, prompt, cache) · pipeline.ts (batched load→context→embed→store)
src/store/         vector-store.ts (LanceDB) · bm25.ts
src/retrieval/     retriever.ts (RRF, boosts, diversity, optional LLM rerank)
src/generation/    prompt.ts (system prompt, context blocks, deep links) · ask.ts (streaming loop)
src/cli/           sync · ingest · ask · search · eval · doctor · map
src/server/        Fastify API + public/index.html (chat) + public/map.html (2-D map)
```

## Scale (2026-09-09)

| | |
|---|---|
| Portal | 8,599 documents from 267 TechDocs entities plus 131 API definitions |
| GitLab | 28,516 documents from 317 repositories (351 discovered, 31 excluded by `sources.yaml`, the rest empty or unreadable), incl. one project card each |
| Sync duration | ~33 min for GitLab, minutes for the portal; later runs are far shorter |
| Chunks | ~113,000, of which ~48,500 are code and ~58,500 prose |
| Contextualized | ~90,000 chunks go to the chat model; the rest get a deterministic context |
