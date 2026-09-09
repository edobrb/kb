import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { RetrievalFilters } from "../types.js";

/**
 * Small in-process BM25 index (Okapi BM25, k1=1.2, b=0.75) persisted as gzipped JSON.
 * It is rebuilt from the LanceDB table after each ingest, so the two never drift apart.
 * Keyword search matters for product codes, acronyms (TSID, M2M, ADR0010), and proper nouns
 * where embedding models are weak.
 */

const STOPWORDS = new Set(
  (
    "a an and are as at be but by for from has have if in into is it its of on or that the their then there these they this to was were will with " +
    "il lo la i gli le un uno una di del della dei delle dello da dal dalla dai dalle in nel nella nei nelle su sul sulla sui sulle per con e ed o od ma che chi cui non si è al alla ai alle allo come anche più questo questa questi queste quello quella sono essere"
  ).split(/\s+/),
);

export function tokenize(text: string): string[] {
  const folded = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const raw = folded.match(/[\p{L}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  for (const tok of raw) {
    if (tok.length < 2 || STOPWORDS.has(tok)) continue;
    out.push(tok);
    // "adr0010" -> also "adr" and "0010" so both spellings match.
    const parts = tok.match(/\p{L}+|\p{N}+/gu);
    if (parts && parts.length > 1) for (const p of parts) if (p.length >= 2 && !STOPWORDS.has(p)) out.push(p);
  }
  return out;
}

export interface Bm25Doc {
  id: string;
  text: string;
  sourceType: string;
  kind: string;
  authority: string;
  lang: string;
}

export interface Bm25Hit {
  id: string;
  score: number;
}

interface Serialized {
  version: 2;
  ids: string[];
  lens: number[];
  sourceTypes: string[];
  kinds: string[];
  authorities: string[];
  langs: string[];
  /** term -> flat [docIdx, tf, docIdx, tf, ...] */
  postings: Record<string, number[]>;
}

export class Bm25Index {
  private ids: string[] = [];
  private lens: number[] = [];
  private sourceTypes: string[] = [];
  private kinds: string[] = [];
  private authorities: string[] = [];
  private langs: string[] = [];
  private postings = new Map<string, number[]>();
  private avgdl = 0;

  static readonly k1 = 1.2;
  static readonly b = 0.75;

  get size(): number {
    return this.ids.length;
  }

  static build(docs: Bm25Doc[]): Bm25Index {
    const idx = new Bm25Index();
    let total = 0;
    docs.forEach((doc, di) => {
      const tokens = tokenize(doc.text);
      idx.ids.push(doc.id);
      idx.lens.push(tokens.length);
      idx.sourceTypes.push(doc.sourceType);
      idx.kinds.push(doc.kind);
      idx.authorities.push(doc.authority);
      idx.langs.push(doc.lang);
      total += tokens.length;
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      for (const [term, f] of tf) {
        let p = idx.postings.get(term);
        if (!p) idx.postings.set(term, (p = []));
        p.push(di, f);
      }
    });
    idx.avgdl = docs.length ? total / docs.length : 0;
    return idx;
  }

  search(query: string, k: number, filters?: RetrievalFilters): Bm25Hit[] {
    const terms = [...new Set(tokenize(query))];
    if (!terms.length || !this.ids.length) return [];
    const N = this.ids.length;
    const scores = new Float64Array(N);
    const touched = new Set<number>();
    for (const term of terms) {
      const p = this.postings.get(term);
      if (!p) continue;
      const df = p.length / 2;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (let i = 0; i < p.length; i += 2) {
        const di = p[i] as number;
        const tf = p[i + 1] as number;
        const dl = this.lens[di] as number;
        const denom = tf + Bm25Index.k1 * (1 - Bm25Index.b + (Bm25Index.b * dl) / (this.avgdl || 1));
        scores[di] = (scores[di] as number) + idf * ((tf * (Bm25Index.k1 + 1)) / denom);
        touched.add(di);
      }
    }
    const hits: Bm25Hit[] = [];
    for (const di of touched) {
      if (!this.passes(di, filters)) continue;
      hits.push({ id: this.ids[di] as string, score: scores[di] as number });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, k);
  }

  private passes(di: number, f?: RetrievalFilters): boolean {
    if (!f) return true;
    if (f.sourceTypes?.length && !f.sourceTypes.includes(this.sourceTypes[di] as string)) return false;
    if (f.kinds?.length && !f.kinds.includes(this.kinds[di] as string)) return false;
    if (f.authorities?.length && !(f.authorities as string[]).includes(this.authorities[di] as string)) return false;
    if (f.langs?.length && !f.langs.includes(this.langs[di] as string)) return false;
    return true;
  }

  async save(file: string): Promise<void> {
    const data: Serialized = {
      version: 2,
      ids: this.ids,
      lens: this.lens,
      sourceTypes: this.sourceTypes,
      kinds: this.kinds,
      authorities: this.authorities,
      langs: this.langs,
      postings: Object.fromEntries(this.postings),
    };
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, gzipSync(Buffer.from(JSON.stringify(data)), { level: 6 }));
    await rename(tmp, file);
  }

  static async load(file: string): Promise<Bm25Index | null> {
    let buf: Buffer;
    try {
      buf = await readFile(file);
    } catch {
      return null;
    }
    const data = JSON.parse(gunzipSync(buf).toString("utf8")) as Serialized;
    if (data.version !== 2) return null; // older layout: `npm run ingest` rebuilds it from the table
    const idx = new Bm25Index();
    idx.ids = data.ids;
    idx.lens = data.lens;
    idx.sourceTypes = data.sourceTypes;
    idx.kinds = data.kinds;
    idx.authorities = data.authorities;
    idx.langs = data.langs;
    idx.postings = new Map(Object.entries(data.postings));
    idx.avgdl = idx.lens.length ? idx.lens.reduce((a, b) => a + b, 0) / idx.lens.length : 0;
    return idx;
  }
}
