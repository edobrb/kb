# Knowledge base architecture

How a page in the Developer Portal, a markdown file in a GitLab repository or a Confluence page becomes a
citable answer. This is the map of the system; the [README](README.md) has the operating instructions
(commands, configuration, tuning), and §7 there explains each stage in prose.

The knowledge base exists to answer **technical questions about OnePlatform and TeamSystem**. That goal
decides what is indexed: documentation, architecture decisions, API contracts and per-repository cards — not
source code (indexed until 2026-09-09; it was ~90 % of the files and pure noise for that purpose), not
generated API reference dumps, not meeting notes. Three systems are indexed, each with its own noise filter,
plus a hand-written folder.

## The pipeline

```
                          SYNC  (npm run sync, incremental, → kb/*.md with frontmatter)
 ┌──────────────────────────────┐  ┌──────────────────────────────────────┐  ┌────────────────────────────────────┐
 │ Developer Portal (Backstage) │  │ GitLab  biosphere / oneplatform group │  │ Confluence Cloud (selected spaces) │
 │ catalog entities + TechDocs  │  │ + the repos the portal points at     │  │ v2 API: spaces → pages → bodies    │
 │ html → markdown              │  │ per repo: head commit → tree → files │  │ ancestor chain (pages + folders)   │
 │ minus generated reference    │  │  *.md ───────────────► kind: doc     │  │ minus excluded trees / titles      │
 │ minus stubs                  │  │  openapi*/asyncapi* ─► kind: api     │  │ minus stubs, export_view → md      │
 │ OpenAPI defs ───► kind: api  │  │  README+langs+entity+wiki hits ►card │  │                                    │
 │ coveredRepos, repoEntities ──┼─►│                      (kind: project) │◄─┤ CQL lookup for the cards           │
 └──────────────┬───────────────┘  └───────────────────┬──────────────────┘  └─────────────────┬──────────────────┘
                ▼                                      ▼                                       ▼
   kb/devportal/<kind>/<name>/*.md     kb/gitlab/<group>/<project>/{**/*.md, **/openapi.yaml.md, __project.md}
                                                 kb/confluence/<SPACE>/<pageId>-<slug>.md
                              + kb/manually-curated/*.md (hand-written, never touched by sync)
                                                       │
                          INGEST (npm run ingest, incremental, resumable)
                                                       ▼
     doc/api/project ──► heading-aware chunker ("Breadcrumb > Title > H2")      code (off by default) ──► declaration-aware chunker
                                                       │  text = heading path ⏎⏎ content
                                                       ▼
   qwen3-embedding:0.6b ──► LanceDB data/lancedb (vector + kind, heading_path, line_start/end, …)
                            BM25   data/bm25.json.gz (rebuilt from the table)   manifest data/manifest.json
                            GRAPH  data/graph.json.gz (frontmatter + body links, rebuilt from the manifest)
                                                       │
                          ASK  (CLI · /api/ask SSE · web UI)
                                                       ▼
   query rewrite → embed query + BM25 → RRF fusion → authority boost → per-doc cap → filters (source_type, kind, lang)
   → prompt with numbered blocks (heading, kind, url, content) → chat model → [n] citations
                                          tools: search · fetch_document · related (the graph)
```

## Sources

| Source | What it contributes | What is filtered out | Credentials |
|---|---|---|---|
| **Developer Portal** `development.teamsystem.com` | Every TechDocs page of every catalog entity with `backstage.io/techdocs-ref`, plus the OpenAPI/AsyncAPI definition of `API` entities. Also exports `coveredRepos` and `repoEntities` (owner, system, lifecycle, description per repository) for the GitLab connector. Populated from GitLab by CI, so it covers repositories the token cannot read. | `devportal.exclude_pages` globs (the generated Swagger/Sphinx reference trees: ~6 200 of the 8 600 pages), pages whose title/body look generated (`IO.Swagger.Model.*`, `pkg.mod module`, "Back to Model list"…), pages without prose | `DEVPORTAL_TOKEN` (Backstage bearer; user tokens last ~1 h — `./refresh-dev-portal-token.sh` prints a fresh one) |
| **GitLab** `biosphere.teamsystem.com` | For the `oneplatform` group and, with `include_devportal_repos`, every repository the portal points at: markdown docs (`kind: doc`), OpenAPI/AsyncAPI contracts found in the repo (`kind: api`), one project card per repository (`kind: project`). Archives are refused by this instance (HTTP 406), so files are downloaded individually with `SYNC_CONCURRENCY` parallel requests. | Training/demo/playground/PoC/course repositories (`exclude_projects`), licences, AI-assistant files, changelogs, templates, test folders (`docs.exclude`), generator READMEs (Create React App, Vite, Angular CLI, Nest), pages without prose, `docs/**` of repositories the portal already renders. Source code unless `gitlab.code.enabled: true`. | `GITLAB_TOKEN` (`read_api`) |
| **Confluence** `teamsystem.atlassian.net` | Whole technical spaces — TeamCore (IAM), CTO (architecture, platform), TONEPLAT (core services), TeamMeteri (monetization), TeamWorksp and RPDD (registry), OBO — as `kind: doc`, one file per page, with the space and ancestor titles as breadcrumb. Still consulted per repository (`title ~`, then `text ~`) to put related pages on the project cards. | `exclude_trees` (a page is skipped when it or any ancestor — page or folder — matches an id or a title wildcard: sprint ceremonies, meetings, drafts, archives, onboarding, org material, the CTO copies of the ADRs), `exclude_titles`, pages without prose, optional `modified_since`, optional per-space `roots` | `CONFLUENCE_EMAIL` + `CONFLUENCE_API_TOKEN` (scoped tokens are routed through `api.atlassian.com` automatically) |
| **`kb/manually-curated/`** | Hand-written glossary, manifesto, design principles, product catalog. | — | — |

Scope, globs, tree filters and authority rules live in [`sources.yaml`](sources.yaml); the content heuristics
(prose count, generated pages, boilerplate READMEs, duplicate bodies) in `src/sync/quality.ts`. The
orchestrator also drops a document whose normalised body is identical to one already written in the same run
(the same README in ten repositories, a page copied into two spaces).

## Document kinds

`kind` is frontmatter, decides the chunking strategy and is a retrieval filter end to end (`--kind`,
`filters.kinds`, UI chips).

| kind | Body | Id → file | Chunked by |
|---|---|---|---|
| `doc` | Prose markdown: TechDocs page, README, ADR, in-repo documentation, Confluence page | `devportal:<ns>/<kind>/<name>/<page/>` → `kb/devportal/…`; `gitlab:<project>:<path>` → `kb/gitlab/<project>/<path>`; `confluence:<SPACE>:<pageId>` → `kb/confluence/<SPACE>/<pageId>-<slug>.md` | headings, ~450 tokens |
| `api` | OpenAPI/AsyncAPI definition in a fenced block, preceded by its title/description | `devportal:<ns>/api/<name>#definition` → `kb/devportal/api/<name>/__definition.md`; `gitlab:<project>:<path>` → `kb/gitlab/<project>/<path>.md` | headings (the fence is split by lines when oversized) |
| `project` | The repository card: description, Dev Portal entity (owner/system/lifecycle), languages, top-level folders, README excerpt, related Confluence pages | `gitlab:<project>:__project` → `kb/gitlab/<project>/__project.md` | headings |
| `code` | One fenced block with the language tag, the file verbatim. **Off by default** (`gitlab.code.enabled`) | `gitlab:<project>:<path>` → `kb/gitlab/<project>/<path>.md` | top-level declarations, ~600 tokens |

Frontmatter every document carries: `source_id`, `source_type`, `kind`, `title`, `source_url`, `authority`,
`lang`, `last_modified`, `fetched_at`, `fingerprint`, and `breadcrumb` — a short "where this lives" path
(`Dev Portal › Hermes`, `GitLab › oneplatform/adrs`, `Confluence › TeamCore › TS ID - Feature`) that the
chunker prepends to every chunk's heading path, so a chunk says which system and which tree it comes from in
both indexes. Plus source-specific fields (`entity`, `owner`, `system`, `project`, `file_path`, `blob_sha`,
`api_type`, `space`, `ancestors`, `labels`, `confluence_pages`…). A file without frontmatter still works:
title from the first `#`, source type from the folder, kind `doc`.

## What triggers re-work

Everything is incremental, and each stage has its own key. Nothing is redone unless its key changed.

| Stage | Key | Effect when it changes |
|---|---|---|
| Portal entity | TechDocs `etag` + hash of the page filters | The entity's pages are re-downloaded and re-filtered; otherwise one metadata request per entity |
| GitLab repository | default-branch head commit + hash of (portal coverage, portal entity, `gitlab.docs`, `gitlab.api_specs`, `gitlab.code`, quality thresholds) | The tree is listed again; otherwise one branch request per repository |
| GitLab file | blob sha | That file is downloaded again |
| Project card | sha256 of the rendered card | The card document is rewritten |
| Confluence page | page version number + hash of the quality thresholds | The page body is fetched again; the listing itself is one paginated request per space |
| Confluence card enrichment | `confluence.refresh_days` per project | The wiki is searched again for that project |
| Ingest of a document | sha256 of the file bytes (manifest) | Re-chunked, re-embedded |
| Whole index | embedding model, dimensions, chunk sizes | Full rebuild |
| Knowledge graph | nothing — rebuilt from the manifest at the end of every ingest (seconds, no model) | `data/graph.json.gz` is replaced, so it can never point at ids the index no longer has |

Safety rails: a source that aborts (network, expired token) deletes nothing; `--only` never deletes; files
in `kb/<source>/` that sync does not know about are reported and removed only with `--prune-foreign`; a file
is rewritten only when its content changed, so a sync that finds nothing new leaves ingest with nothing to do.
A page that a new filter now excludes is simply not emitted and its file is deleted on the next full pass.

## Storage

* **LanceDB** `data/lancedb/` — one `chunks` table, embedded and file-based. Columns: `id`, `source_id`,
  `source_type`, `kind`, `title`, `source_url`, `authority`, `lang`, `last_modified`, `rel_path`, `ordinal`,
  `heading_path`, `content`, `text`, `line_start`, `line_end`, `vector`. Filters are SQL-like predicates
  (`kind IN ('api')`); no ANN index, a brute-force cosine scan at this scale is exact and fast.
* **BM25** `data/bm25.json.gz` — Okapi BM25 rebuilt from the table after every ingest, so the two indexes
  cannot drift. The tokenizer folds accents and splits alphanumeric codes (`ADR0010` → `adr0010`, `adr`, `0010`).
* **Manifest** `data/manifest.json` — what is indexed, with content hashes and chunk counts. Flushed after
  every batch, which is what makes an interrupted ingest resumable.
* **Knowledge graph** `data/graph.json.gz` — the structure the chunk index throws away: which document
  links to which, the Confluence page tree, the project card of a repository, and the repository,
  space, catalog entity, owning team, tag and City Map node each document belongs to. Nodes are the
  manifest's documents plus one hub per group; edges are index triples, so ~6.7k nodes and ~23k edges
  fit in ~185 kB. Built by `src/graph/build.ts` at the end of every ingest — no model, no embedding,
  a pass over the kb files — and never allowed to outlive the manifest it was built from. See
  [§ Relations](#relations).
* **Sync state** `data/sync/<source>.json` — per-source item fingerprints and connector memory
  (`coveredRepos`, `repoEntities`, `projectHeads`, `projectEnrichment`, Confluence space counts).

## Relations

`kind`, `authority` and the breadcrumb say what a document *is*; the graph says what it is *attached
to*. Both halves are read straight out of what sync already wrote.

| Relation | From → to | Where it comes from |
|---|---|---|
| `links_to` | doc → doc | A markdown link in the body whose URL reverse-maps to an indexed `source_id` (`…/wiki/spaces/X/pages/123/…` → `confluence:X:123`, `…/-/blob/main/a.md` → `gitlab:<project>:a.md`, `/docs/<ns>/<kind>/<name>/<page>/` → `devportal:…`), or a relative link resolved against the document's own path |
| `child_of` | doc → doc | Confluence `parent_id` |
| `described_by` | doc → doc | Every repository document points at its project card (`project`) |
| `documents` | doc → doc | A project card points at the Dev Portal tree that renders the repository (`techdocs_ref`) |
| `related_wiki` | doc → doc | A project card points at the Confluence pages the CQL enricher tied to it (`confluence_pages`) |
| `in_repo`, `in_space`, `under`, `about_entity`, `owned_by`, `tagged`, `in_area`, `in_subarea`, `in_module` | doc → hub | `project`, `space`, the `ancestors` chain (one hub per prefix, so a subtree is one node), `entity`, `owner`, `tags`, and the City Map placement of `src/citymap.ts` |

Two rules keep it honest. **A target that is not in the manifest is dropped**, never guessed at, so
every edge points at a page `fetch_document` can actually read. And **a hub bigger than
`GRAPH_MAX_HUB_SIZE` (60) contributes no siblings**: "same repository" is a real hint in a repository
of eight documents and noise in one of three hundred — the cap excludes 7 of 230 repositories and 1
of 133 page trees, which is exactly the diffuse tail.

What that buys, on the current knowledge base: 3,182 real links between documents, and 69 % of
documents with at least one document-to-document edge (largest connected component 41 %). It is not
a recall trick — retrieval already finds pages that read alike — it answers the questions similarity
cannot: what supersedes this ADR, what else is in this repository, which page links here.

A by-product worth its own command: a link whose target *looks* internal and resolves to nothing is
a dangling reference in the documentation, and `npm run graph -- --broken-links` lists them (2,101
today, headed by ~325 links to a `policy-manager/overview/*` tree that has since been renamed to
`concepts/*`). Frontmatter references to pages the sync scope deliberately excludes are counted
separately, because those are decisions rather than bugs.

## Answering

Hybrid retrieval, then generation: vector search and BM25 each return `RETRIEVAL_CANDIDATES` chunks,
Reciprocal Rank Fusion merges them (`score = Σ weight / (60 + rank)`), binding/normative documents get a
+15 %/+12 % boost, a per-document cap keeps one long file from filling the context, and `RETRIEVAL_TOP_K`
chunks reach the model. Each context block carries its heading path (breadcrumb included), kind, authority
and URL; the prompt requires citations, forbids outside knowledge, and asks for the repository and file when
the answer comes from a repository document.

The model also gets two tools. `search(query)` runs the same hybrid retrieval on a query of the model's
choosing, for when the first pass missed the page: the user's words are not the documents' words, or the
answer spans pages. It returns only passages not already in the context (`TOOL_SEARCH_TOP_K` per call), the
user's filters still apply, and the prompt tells the model to search before declaring that the knowledge base
does not cover something. `fetch_document(source_id, section?)` reads the rest of a page when a passage is a
chunk of something larger (the next section, the full table, the exact values). Ids are resolved through
`data/manifest.json`, so only indexed documents are reachable; results are capped (`DOC_TOOL_MAX_CHARS`,
`TOOL_CHAR_BUDGET`) and carry the page outline so a follow-up call can ask for one section. Both results are
appended as numbered blocks and cited like any other.

`related(source_id, scope?)` is the third tool, and the only one that is not a search: it walks the
graph one hop and lists what the page is attached to — what it links to and what links to it, its
parent page, the rest of its repository or product module — as titles and ids, no text. It is what
the model reaches for when a block is clearly about the right thing but does not answer the question,
and it costs about as much as one passage. It adds no citable block on purpose: the model picks a
page from the list and reads it with `fetch_document`, so what ends up cited is a passage as usual.
Offered only when `data/graph.json.gz` is actually loaded (`TOOL_RELATED`, `TOOL_RELATED_LIMIT`).

The loop is bounded by `TOOL_MAX_ROUNDS` and the last
round runs without tools, so an answer always comes out.

## Where the code lives

```
src/citymap.ts     the City Map (Dev Portal areas › modules › components, fetched by sync) + taxonomy.yaml → where a document sits; colours the map
src/sync/          index.ts (orchestrator, source + enricher definitions, duplicate-body skip)
                   devportal.ts · gitlab.ts · confluence.ts (source connector + the CQL card lookup)
                   project-card.ts (the per-repository card) · quality.ts (prose/generated/boilerplate heuristics)
                   code.ts (languages, junk detection, symbols — used when code indexing is on)
                   sources-config.ts (sources.yaml, globs, rules) · kb-writer.ts · html.ts · http.ts · state.ts
src/ingest/        loader.ts (frontmatter, kinds) · chunker.ts (prose + code, breadcrumb prefix)
                   pipeline.ts (batched load → chunk → embed → store, BM25 rebuild) · manifest.ts · progress.ts
src/store/         vector-store.ts (LanceDB) · bm25.ts
src/graph/         build.ts (frontmatter + body links → nodes and edges, dangling-link report)
                   resolve.ts (URL / relative link → source_id) · index.ts (in-memory adjacency, neighbours, hubs)
                   types.ts (relations and their labels)
src/retrieval/     retriever.ts (RRF, boosts, diversity, optional LLM rerank)
                   documents.ts (source_id → kb file: whole documents and sections for the fetch_document tool)
src/generation/    prompt.ts (system prompt, context blocks, deep links) · ask.ts (streaming loop + tool loop)
                   tools.ts (search + fetch_document: schemas, dedup against the context, result formatting)
src/cli/           sync · ingest · ask · doc · search · eval · doctor · map · graph
src/server/        Fastify API + public/index.html (chat) + public/map.html (2-D map, graph overlay) + public/architecture.html (this document, interactive)
```
