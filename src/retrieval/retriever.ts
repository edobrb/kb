import { config, paths } from "../config.js";
import { getChatProvider } from "../llm/chat.js";
import { getEmbedder } from "../llm/embeddings.js";
import { Bm25Index } from "../store/bm25.js";
import { VectorStore } from "../store/vector-store.js";
import type { RetrievalFilters, RetrievedChunk } from "../types.js";
import type { Row } from "../store/vector-store.js";

/** Reciprocal Rank Fusion constant (Cormack et al. 2009). 60 is the standard choice. */
const RRF_K = 60;

/** Binding/normative documents (ADRs, standards) are slightly favoured over descriptive ones. */
const AUTHORITY_BOOST: Record<string, number> = {
  binding: 1.15,
  normative: 1.12,
  descriptive: 1.0,
  unknown: 1.0,
};

export interface RetrieveOptions {
  topK?: number;
  candidates?: number;
  filters?: RetrievalFilters;
  /** Skip the optional LLM rerank even if configured. */
  noRerank?: boolean;
}

export interface RetrieverStats {
  chunks: number;
  bm25Docs: number;
  dimensions: number;
}

function toRetrieved(row: Row, score: number, vectorRank: number | null, bm25Rank: number | null): RetrievedChunk {
  return {
    id: row.id,
    sourceId: row.source_id,
    sourceType: row.source_type,
    kind: row.kind,
    title: row.title,
    sourceUrl: row.source_url || null,
    authority: row.authority,
    lang: row.lang,
    relPath: row.rel_path,
    ordinal: row.ordinal,
    headingPath: row.heading_path,
    content: row.content,
    lineStart: row.line_start >= 0 ? row.line_start : null,
    lineEnd: row.line_end >= 0 ? row.line_end : null,
    score,
    vectorRank,
    bm25Rank,
  };
}

export class Retriever {
  private constructor(
    private readonly store: VectorStore,
    private readonly bm25: Bm25Index | null,
  ) {}

  static async open(): Promise<Retriever> {
    const embedder = getEmbedder();
    const store = await VectorStore.open(paths.lanceDb, embedder.dimensions);
    const bm25 = await Bm25Index.load(paths.bm25Index);
    return new Retriever(store, bm25);
  }

  async stats(): Promise<RetrieverStats> {
    return { chunks: await this.store.count(), bm25Docs: this.bm25?.size ?? 0, dimensions: this.store.dimensions };
  }

  /** Fetch single chunks by id, e.g. to show a passage the map UI just selected. */
  async chunksByIds(ids: string[]): Promise<RetrievedChunk[]> {
    const rows = await this.store.getByIds(ids);
    return ids.flatMap((id) => {
      const row = rows.get(id);
      return row ? [toRetrieved(row, 0, null, null)] : [];
    });
  }

  async facets(): Promise<{ sourceTypes: Record<string, number>; kinds: Record<string, number>; authorities: Record<string, number>; langs: Record<string, number> }> {
    const [sourceTypes, kinds, authorities, langs] = await Promise.all([
      this.store.distinct("source_type"),
      this.store.distinct("kind"),
      this.store.distinct("authority"),
      this.store.distinct("lang"),
    ]);
    return { sourceTypes, kinds, authorities, langs };
  }

  /**
   * Hybrid retrieval:
   *  1. vector search (cosine) over Qwen3 embeddings  -> ranked list A
   *  2. BM25 keyword search                           -> ranked list B
   *  3. Reciprocal Rank Fusion of A and B, weighted
   *  4. authority boost, cap chunks per document, take top-k
   *  5. optional LLM rerank (RERANK=llm)
   */
  async retrieve(query: string, opts: RetrieveOptions = {}): Promise<RetrievedChunk[]> {
    const topK = opts.topK ?? config.retrieval.topK;
    const candidates = Math.max(topK, opts.candidates ?? config.retrieval.candidates);
    const filters = opts.filters;

    if (this.store.isEmpty) {
      throw new Error("The index is empty. Run `npm run ingest` first.");
    }

    const embedder = getEmbedder();
    const [queryVector, bm25Hits] = await Promise.all([
      embedder.embedQuery(query),
      Promise.resolve(this.bm25?.search(query, candidates, filters) ?? []),
    ]);
    const vectorHits = await this.store.search(queryVector, candidates, filters);

    // Fuse.
    const fused = new Map<string, { score: number; vectorRank: number | null; bm25Rank: number | null; row?: Row }>();
    vectorHits.forEach((hit, i) => {
      const rank = i + 1;
      fused.set(hit.row.id, {
        score: config.retrieval.vectorWeight / (RRF_K + rank),
        vectorRank: rank,
        bm25Rank: null,
        row: hit.row,
      });
    });
    bm25Hits.forEach((hit, i) => {
      const rank = i + 1;
      const existing = fused.get(hit.id);
      const add = config.retrieval.bm25Weight / (RRF_K + rank);
      if (existing) {
        existing.score += add;
        existing.bm25Rank = rank;
      } else {
        fused.set(hit.id, { score: add, vectorRank: null, bm25Rank: rank });
      }
    });

    // Hydrate rows that only BM25 returned.
    const missing = [...fused.entries()].filter(([, v]) => !v.row).map(([id]) => id);
    if (missing.length) {
      const rows = await this.store.getByIds(missing);
      for (const id of missing) {
        const row = rows.get(id);
        if (row) (fused.get(id) as { row?: Row }).row = row;
        else fused.delete(id); // stale BM25 entry (should not happen after a clean ingest)
      }
    }

    // Boost + sort.
    let ranked = [...fused.values()]
      .filter((v) => v.row)
      .map((v) => {
        const row = v.row as Row;
        const boost = AUTHORITY_BOOST[row.authority] ?? 1;
        return toRetrieved(row, v.score * boost, v.vectorRank, v.bm25Rank);
      })
      .sort((a, b) => b.score - a.score);

    // Diversity: cap chunks per document so one long page does not crowd out everything else.
    const perDoc = new Map<string, number>();
    ranked = ranked.filter((c) => {
      const n = perDoc.get(c.sourceId) ?? 0;
      if (n >= config.retrieval.maxChunksPerDoc) return false;
      perDoc.set(c.sourceId, n + 1);
      return true;
    });

    if (config.retrieval.rerank === "llm" && !opts.noRerank && ranked.length > topK) {
      ranked = await llmRerank(query, ranked.slice(0, Math.min(ranked.length, topK * 3)));
    }

    return ranked.slice(0, topK);
  }
}

/**
 * Pointwise LLM rerank: ask the chat model for a 0-10 relevance score per candidate.
 * Slow (one short generation per candidate) but noticeably more precise on ambiguous questions.
 */
async function llmRerank(query: string, candidates: RetrievedChunk[]): Promise<RetrievedChunk[]> {
  const chat = getChatProvider();
  const scored = await Promise.all(
    candidates.map(async (c) => {
      const prompt =
        `Rate how useful the passage is for answering the question. Reply with a single integer 0-10, nothing else.\n\n` +
        `Question: ${query}\n\nPassage (${c.headingPath}):\n${c.content.slice(0, 2000)}`;
      try {
        const out = await chat.complete([{ role: "user", content: prompt }], { temperature: 0, think: false });
        const m = /\d+/.exec(out);
        const s = m ? Math.min(10, Number(m[0])) : 0;
        return { c, s };
      } catch {
        return { c, s: 0 };
      }
    }),
  );
  return scored
    .sort((a, b) => b.s - a.s || b.c.score - a.c.score)
    .map(({ c, s }) => ({ ...c, score: s / 10 + c.score }));
}
