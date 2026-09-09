/**
 * 2-D "map" of the knowledge base: every chunk vector is projected to a point with UMAP so semantically
 * close chunks land close together. Purely offline; the result is a JSON file the web UI renders.
 *
 * The payload is built for growth: metadata that belongs to a document is stored once in `documents` and
 * referenced by index, repeated strings live in `dict`, per-chunk data is held in parallel arrays, and chunk
 * text is not included at all (the UI fetches it on demand). Chunk ids are `${sourceId}::${ordinal}`, so they
 * are reconstructed on the client instead of being shipped.
 */
import { UMAP } from "umap-js";

/** A row as read from the vector store. `vector` may already be random-projected (see `preProjected`). */
export interface MapInputRow {
  id: string;
  source_id: string;
  source_type: string;
  title: string;
  source_url: string;
  authority: string;
  lang: string;
  rel_path: string;
  ordinal: number;
  heading_path: string;
  vector: ArrayLike<number>;
}

export interface MapDocument {
  /** sourceId; a chunk id is `${id}::${ordinal}`. */
  id: string;
  title: string;
  /** "" when the document has no source URL. */
  url: string;
  path: string;
  /** Indices into dict.groups / sourceTypes / langs / authorities. */
  g: number;
  s: number;
  l: number;
  a: number;
}

export interface MapCluster {
  id: number;
  /** Distinctive terms shared by the cluster's chunks, e.g. "Wazuh agent config". */
  name: string;
  n: number;
  /** Centroid in map coordinates, where the cluster's label is drawn. */
  x: number;
  y: number;
}

export interface MapLabel {
  x: number;
  y: number;
  text: string;
  /** Chunks in the cluster this label describes. */
  n: number;
  /** 0 = coarse (few, big regions), 1 = fine (shown when zoomed in). */
  level: number;
}

export interface KbMap {
  version: 2;
  generatedAt: string;
  embeddingModel: string;
  dimensions: number;
  chunks: number;
  docs: number;
  params: MapParams;
  dict: { groups: string[]; sourceTypes: string[]; langs: string[]; authorities: string[] };
  documents: MapDocument[];
  /** Semantic groups found in the embedding space; `points.cl` indexes this array. */
  clusters: MapCluster[];
  /** Parallel arrays, one entry per chunk. `doc` indexes `documents`, `cl` indexes `clusters`. */
  points: { x: number[]; y: number[]; doc: number[]; ord: number[]; head: string[]; cl: number[] };
  labels: MapLabel[];
}

export interface MapParams {
  nNeighbors: number;
  minDist: number;
  nEpochs: number;
  /** Random-projection width applied before UMAP (0 = use the raw vectors). */
  projectDims: number;
  /** Number of semantic clusters (k-means over the vectors) used for colouring and naming. */
  clusters: number;
  seed: number;
}

export const DEFAULT_MAP_PARAMS: MapParams = { nNeighbors: 15, minDist: 0.1, nEpochs: 400, projectDims: 256, clusters: 8, seed: 42 };

/**
 * "devportal/component/x/page.md" -> "devportal/component"; "manually-curated/foo.md" -> "manually-curated";
 * GitLab paths keep the sub-group too ("gitlab/oneplatform/islands"), since one group holds hundreds of repos.
 */
export function groupOf(relPath: string, sourceType: string): string {
  const parts = relPath.split("/").filter(Boolean);
  if (parts.length <= 2) return parts[0] ?? sourceType;
  if (parts[0] === "gitlab" && parts.length > 4) return `${parts[0]}/${parts[1]}/${parts[2]}`;
  return `${parts[0]}/${parts[1]}`;
}

export function excerptOf(content: string, max = 200): string {
  const s = content.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Deterministic PRNG (mulberry32) so two runs on the same index give the same picture. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Standard normal via Box–Muller on top of a uniform PRNG. */
function gaussian(rand: () => number): () => number {
  return () => {
    let u = 0;
    let v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

export function normalize(v: ArrayLike<number>): Float32Array {
  const out = new Float32Array(v.length);
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += (v[i] as number) * (v[i] as number);
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) out[i] = (v[i] as number) / norm;
  return out;
}

/** Cosine distance on L2-normalised vectors = 1 - dot. */
export function cosineDistance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += (a[i] as number) * (b[i] as number);
  return Math.max(0, 1 - dot);
}

/**
 * Gaussian random projection (Johnson–Lindenstrauss): `inDims` -> `outDims` while approximately preserving
 * angles, so the kNN graph UMAP builds is nearly the same but far cheaper to compute.
 *
 * Built once and applied per row, so a large index never has to be held at full width in memory:
 * 100k chunks are 1.6 GB at 4096 dims but 100 MB at 256.
 */
export class RandomProjector {
  private readonly matrix: Float32Array[] = [];

  constructor(
    readonly inDims: number,
    readonly outDims: number,
    seed: number,
  ) {
    const gauss = gaussian(seededRandom(seed));
    const scale = 1 / Math.sqrt(outDims);
    for (let d = 0; d < outDims; d++) {
      const col = new Float32Array(inDims);
      for (let i = 0; i < inDims; i++) col[i] = gauss() * scale;
      this.matrix.push(col);
    }
  }

  /** Project and L2-normalise, so cosine distance stays meaningful downstream. */
  project(v: ArrayLike<number>): Float32Array {
    const out = new Float32Array(this.outDims);
    let norm = 0;
    for (let d = 0; d < this.outDims; d++) {
      const col = this.matrix[d] as Float32Array;
      let s = 0;
      for (let i = 0; i < this.inDims; i++) s += (v[i] as number) * (col[i] as number);
      out[d] = s;
      norm += s * s;
    }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < this.outDims; d++) out[d] = (out[d] as number) / norm;
    return out;
  }
}

/** Convenience wrapper used by tests and small inputs. */
export function randomProject(vectors: ArrayLike<number>[], dims: number, seed: number): Float32Array[] {
  const inDims = vectors[0]?.length ?? 0;
  if (!inDims) return [];
  const p = new RandomProjector(inDims, dims, seed);
  return vectors.map((v) => p.project(v));
}

// ---- cluster labels ----------------------------------------------------------

/**
 * Words that carry no signal in a label. Italian + English function words plus the boilerplate that shows up
 * in almost every internal page title, which would otherwise win on frequency alone.
 */
const STOPWORDS = new Set(
  (
    "the and for with from that this these those are was were will would have has had not but you your our its it is " +
    "per con del della delle dei degli dal dalla alla alle allo agli nel nella nelle sul sulla sulle come cosa " +
    "che non piu meno sono stato stata essere avere gli una uno gli gli come dove quando gia gia gli " +
    "di da in su tra fra ed od al ai il lo la le un una " +
    "doc docs documento documentazione documentation page pagina note notes untitled home readme " +
    "team teams new nuovo nuova old vecchio copy copia draft bozza test todo tbd wip " +
    "guida guide guidelines linee overview intro introduzione appunti riunione meeting " +
    "gen feb mar apr mag giu lug ago set ott nov dic jan may jun jul aug sep oct dec " +
    "desde para como este esta sobre entre cual toda todo otro varios " +
    "vari varie vario alcuni alcune ogni tale tali dato data dell dello della degli " +
    "principali generali specifico specifica descrizione riferimenti allegati history revision"
  ).split(/\s+/),
);

/**
 * Break glued words apart so "VEICRequisiti" yields "VEIC" and "Requisiti" instead of one unreadable token.
 * Handles both a lowercase-to-uppercase boundary and an acronym followed by a capitalised word.
 */
export function splitWords(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
}

/**
 * Lowercase, strip accents, keep word-ish tokens of a useful length.
 *
 * Internal identifiers ("WI7EBDETTGRPMEN", "WI7RMATRICECTR") are distinctive enough to win a TF-IDF
 * ranking while telling a reader nothing, so several shapes are rejected: digits embedded before letters,
 * long runs of consonant letters, and a couple of letters followed by a record number. Versioned technical
 * terms survive ("oauth2", "rfc9457", "outlook365").
 */
export function tokenizeLabel(s: string): string[] {
  return splitWords(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => {
      if (t.length < 3 || t.length > 24 || STOPWORDS.has(t)) return false;
      if (/^\d+$/.test(t)) return false;
      if (t.length > 4 && /\d[a-z]/.test(t)) return false;
      // A long run of consonant *letters* means a code, not a word ("EBDETTGRPMEN"). Digits must not count,
      // or versioned terms such as "rfc9457" and "outlook365" would be thrown away with it.
      if (t.length > 5 && /[bcdfghjklmnpqrstvwxz]{4}/.test(t)) return false;
      // One or two letters followed by digits is a record key ("WI7", "WI45"), never a topic.
      if (/^[a-z]{1,2}\d+$/.test(t)) return false;
      return true;
    });
}

/** Remember how a token is usually written so labels read "TSID" and "Wazuh", not "Tsid" and "wazuh". */
function collectSurfaceForms(text: string, into: Map<string, Map<string, number>>): void {
  for (const raw of splitWords(text).split(/[^\p{L}\p{N}]+/u)) {
    if (!raw) continue;
    const key = raw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    let forms = into.get(key);
    if (!forms) into.set(key, (forms = new Map()));
    forms.set(raw, (forms.get(raw) ?? 0) + 1);
  }
}

function bestSurface(token: string, forms: Map<string, Map<string, number>>): string {
  const f = forms.get(token);
  if (!f) return token;
  let best = token;
  let bestScore = -1;
  for (const [surface, n] of f) {
    // Prefer the most common spelling; break ties towards the one with capitals (acronyms).
    const score = n * 10 + (/[A-Z]/.test(surface) ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = surface;
    }
  }
  return best;
}

/**
 * Name each group of chunks by the words that are frequent inside it and rare in the others.
 * Used for both the semantic cluster names and the finer on-map labels.
 *
 * Two details matter for the names to be useful:
 *  - A term counts once per *document*, not per chunk (pass `keys`), otherwise one verbose page with 300
 *    chunks names the whole cluster after itself.
 *  - The inverse document frequency is `log((G + 1) / (df + 0.5))`, which collapses to almost nothing for a
 *    term present in every group. Without that, corpus boilerplate ("Analisi Funzionale" in a spec-heavy
 *    knowledge base) wins on raw frequency and every cluster ends up with the same name. Term frequency is
 *    also sublinear, so a merely common word cannot outrank a distinctive one.
 */
export function nameGroups(groups: number[][], texts: string[], terms = 3, keys?: ArrayLike<number>): string[] {
  const forms = new Map<string, Map<string, number>>();
  const tfs: Map<string, number>[] = [];
  const sizes: number[] = [];
  const df = new Map<string, number>();
  for (const members of groups) {
    const tf = new Map<string, number>();
    const seen = new Set<string>();      // `${key}\u0000${term}`, so a term counts once per document
    const units = new Set<number>();
    for (const i of members) {
      const text = texts[i] ?? "";
      const key = keys ? (keys[i] as number) : i;
      units.add(key);
      collectSurfaceForms(text, forms);
      for (const t of new Set(tokenizeLabel(text))) {
        const stamp = `${key}\u0000${t}`;
        if (seen.has(stamp)) continue;
        seen.add(stamp);
        tf.set(t, (tf.get(t) ?? 0) + 1);
      }
    }
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    tfs.push(tf);
    sizes.push(units.size || 1);
  }
  const nGroups = groups.length || 1;
  return tfs.map((tf, gi) => {
    if (!(sizes[gi] as number)) return "";
    const scored = [...tf.entries()]
      // Sublinear tf on the raw document count (a ratio inside the log would go negative and invert the
      // ranking), times an idf that collapses to ~0 for a term present in every group.
      .map(([t, f]) => ({ t, s: (1 + Math.log(f)) * Math.log((nGroups + 1) / ((df.get(t) ?? 1) + 0.5)) }))
      .sort((a, b) => b.s - a.s);
    const picked: string[] = [];
    for (const { t } of scored) {
      // Skip a word that is a prefix variant of one already picked ("service" vs "services").
      if (picked.some((p) => p.slice(0, 5) === t.slice(0, 5))) continue;
      picked.push(t);
      if (picked.length === terms) break;
    }
    return picked.map((t) => bestSurface(t, forms)).join(" ");
  });
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Bin the points on a grid and name each dense bin, so a large map stays readable when zoomed in. */
export function gridLabels(
  xs: number[],
  ys: number[],
  texts: string[],
  opts: { cellsPerAxis: number; level: number; minPoints: number; terms?: number; keys?: ArrayLike<number> },
): MapLabel[] {
  const n = xs.length;
  if (!n) return [];
  const { cellsPerAxis: C, level, minPoints } = opts;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = xs[i] as number;
    const y = ys[i] as number;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const w = (x1 - x0 || 1) / C;
  const h = (y1 - y0 || 1) / C;
  const bins = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const cx = Math.min(C - 1, Math.floor(((xs[i] as number) - x0) / w));
    const cy = Math.min(C - 1, Math.floor(((ys[i] as number) - y0) / h));
    const key = cy * C + cx;
    let b = bins.get(key);
    if (!b) bins.set(key, (b = []));
    b.push(i);
  }
  const kept = [...bins.values()].filter((b) => b.length >= minPoints);
  const names = nameGroups(kept, texts, opts.terms ?? 2, opts.keys);
  const out: MapLabel[] = [];
  kept.forEach((members, i) => {
    const name = names[i];
    if (!name) return;
    let sx = 0;
    let sy = 0;
    for (const m of members) {
      sx += xs[m] as number;
      sy += ys[m] as number;
    }
    out.push({ x: round3(sx / members.length), y: round3(sy / members.length), text: name, n: members.length, level });
  });
  return out.sort((a, b) => b.n - a.n);
}

// ---- semantic clustering -----------------------------------------------------

/**
 * Spherical k-means over the embedding vectors: assignment by cosine similarity, centroids re-normalised
 * each round. This groups chunks by what they are *about*, independently of which space or repo they came
 * from, which is what the map colours by.
 *
 * Centroids are fitted on a sample (bounded work on a large index) and every point is then assigned.
 */
export function kmeansCosine(
  vectors: Float32Array[],
  k: number,
  seed: number,
  opts: { iterations?: number; sampleSize?: number } = {},
): { assignments: Int32Array; centroids: Float32Array[] } {
  const n = vectors.length;
  const dims = vectors[0]?.length ?? 0;
  const iterations = opts.iterations ?? 25;
  const sampleSize = Math.min(n, opts.sampleSize ?? 20_000);
  const rand = seededRandom(seed);
  const kk = Math.max(1, Math.min(k, n));

  // Sample for fitting (every point is assigned at the end regardless).
  const stride = Math.max(1, Math.floor(n / sampleSize));
  const sample: Float32Array[] = [];
  for (let i = 0; i < n; i += stride) sample.push(vectors[i] as Float32Array);

  const dot = (a: Float32Array, b: Float32Array) => {
    let s = 0;
    for (let i = 0; i < dims; i++) s += (a[i] as number) * (b[i] as number);
    return s;
  };

  // k-means++ seeding on cosine distance, so clusters do not collapse onto each other.
  const centroids: Float32Array[] = [Float32Array.from(sample[Math.floor(rand() * sample.length)] as Float32Array)];
  const best = new Float64Array(sample.length).fill(Infinity);
  while (centroids.length < kk) {
    const last = centroids[centroids.length - 1] as Float32Array;
    let total = 0;
    for (let i = 0; i < sample.length; i++) {
      const d = Math.max(0, 1 - dot(sample[i] as Float32Array, last));
      if (d < (best[i] as number)) best[i] = d;
      total += (best[i] as number) ** 2;
    }
    let target = rand() * total;
    let pick = sample.length - 1;
    for (let i = 0; i < sample.length; i++) {
      target -= (best[i] as number) ** 2;
      if (target <= 0) {
        pick = i;
        break;
      }
    }
    centroids.push(Float32Array.from(sample[pick] as Float32Array));
  }

  const assignOne = (v: Float32Array): number => {
    let bestI = 0;
    let bestS = -Infinity;
    for (let c = 0; c < centroids.length; c++) {
      const s = dot(v, centroids[c] as Float32Array);
      if (s > bestS) {
        bestS = s;
        bestI = c;
      }
    }
    return bestI;
  };

  const sampleAssign = new Int32Array(sample.length).fill(-1);
  for (let it = 0; it < iterations; it++) {
    let moved = 0;
    const sums = centroids.map(() => new Float64Array(dims));
    const counts = new Int32Array(centroids.length);
    for (let i = 0; i < sample.length; i++) {
      const a = assignOne(sample[i] as Float32Array);
      if (a !== sampleAssign[i]) {
        sampleAssign[i] = a;
        moved++;
      }
      const s = sums[a] as Float64Array;
      const v = sample[i] as Float32Array;
      for (let d = 0; d < dims; d++) s[d] = (s[d] as number) + (v[d] as number);
      counts[a] = (counts[a] as number) + 1;
    }
    for (let c = 0; c < centroids.length; c++) {
      if (!counts[c]) continue;
      const s = sums[c] as Float64Array;
      let norm = 0;
      for (let d = 0; d < dims; d++) norm += (s[d] as number) * (s[d] as number);
      norm = Math.sqrt(norm) || 1;
      const cen = centroids[c] as Float32Array;
      for (let d = 0; d < dims; d++) cen[d] = (s[d] as number) / norm;
    }
    if (moved === 0) break;
  }

  const assignments = new Int32Array(n);
  for (let i = 0; i < n; i++) assignments[i] = assignOne(vectors[i] as Float32Array);
  return { assignments, centroids };
}

// ---- projection --------------------------------------------------------------

export interface BuildMapOptions {
  params?: Partial<MapParams>;
  embeddingModel: string;
  dimensions: number;
  /** True when the caller already applied the random projection (streaming, to bound memory). */
  preProjected?: boolean;
  onProgress?: (info: { phase: "project" | "cluster" | "umap" | "labels"; epoch?: number; epochs?: number }) => void;
}

/** Project every row to 2-D and assemble the payload. Runs UMAP epoch by epoch so callers can show progress. */
export async function buildMap(rows: MapInputRow[], opts: BuildMapOptions): Promise<KbMap> {
  // Drop undefined overrides so a CLI flag that was not given does not erase the default.
  const overrides = Object.fromEntries(Object.entries(opts.params ?? {}).filter(([, v]) => v !== undefined));
  const params: MapParams = { ...DEFAULT_MAP_PARAMS, ...overrides };
  const n = rows.length;
  if (n < 4) throw new Error(`Need at least 4 chunks to build a map, found ${n}`);

  opts.onProgress?.({ phase: "project" });
  const inputDims = rows[0]?.vector.length ?? 0;
  const project = !opts.preProjected && params.projectDims > 0 && params.projectDims < inputDims;
  const data: Float32Array[] = project
    ? (() => {
        const p = new RandomProjector(inputDims, params.projectDims, params.seed);
        return rows.map((r) => p.project(r.vector));
      })()
    : rows.map((r) => (opts.preProjected ? (r.vector as Float32Array) : normalize(r.vector)));

  // Colour by meaning, not provenance: cluster in the embedding space, before UMAP distorts distances.
  opts.onProgress?.({ phase: "cluster" });
  const { assignments } = kmeansCosine(data, Math.max(1, Math.min(params.clusters, n)), params.seed + 2);

  const nNeighbors = Math.max(2, Math.min(params.nNeighbors, n - 1));
  const umap = new UMAP({
    nComponents: 2,
    nNeighbors,
    minDist: params.minDist,
    nEpochs: params.nEpochs,
    distanceFn: cosineDistance as unknown as (a: number[], b: number[]) => number,
    random: seededRandom(params.seed + 1),
  });
  // umap-js types want number[][]; typed arrays are indexed identically at runtime.
  const epochs = umap.initializeFit(data as unknown as number[][]);
  for (let e = 0; e < epochs; e++) {
    umap.step();
    if (e % 10 === 0 || e === epochs - 1) opts.onProgress?.({ phase: "umap", epoch: e + 1, epochs });
    // Yield to the event loop occasionally so progress output flushes.
    if (e % 25 === 0) await new Promise((r) => setImmediate(r));
  }
  const coords = umap.getEmbedding();

  // ---- assemble the compact payload ----
  const groups: string[] = [];
  const sourceTypes: string[] = [];
  const langs: string[] = [];
  const authorities: string[] = [];
  const intern = (dict: string[], v: string): number => {
    const i = dict.indexOf(v);
    return i >= 0 ? i : dict.push(v) - 1;
  };

  const documents: MapDocument[] = [];
  const docIndex = new Map<string, number>();
  const x: number[] = [];
  const y: number[] = [];
  const doc: number[] = [];
  const ord: number[] = [];
  const head: string[] = [];
  const cl: number[] = [];
  const labelText: string[] = [];

  for (let i = 0; i < n; i++) {
    const r = rows[i] as MapInputRow;
    let di = docIndex.get(r.source_id);
    if (di === undefined) {
      di = documents.length;
      docIndex.set(r.source_id, di);
      documents.push({
        id: r.source_id,
        title: r.title,
        url: r.source_url ?? "",
        path: r.rel_path,
        g: intern(groups, groupOf(r.rel_path, r.source_type)),
        s: intern(sourceTypes, r.source_type),
        l: intern(langs, r.lang),
        a: intern(authorities, r.authority),
      });
    }
    const [px, py] = coords[i] as [number, number];
    x.push(round3(px));
    y.push(round3(py));
    doc.push(di);
    ord.push(r.ordinal);
    head.push(r.heading_path);
    cl.push(assignments[i] as number);
    labelText.push(`${r.title} ${r.heading_path}`);
  }

  opts.onProgress?.({ phase: "labels" });
  // Name each semantic cluster from the words that distinguish it, and place it at its centre of mass.
  const nClusters = Math.max(...cl) + 1;
  const members: number[][] = Array.from({ length: nClusters }, () => []);
  for (let i = 0; i < n; i++) (members[cl[i] as number] as number[]).push(i);
  const names = nameGroups(members, labelText, 3, doc);
  const clusters: MapCluster[] = members.map((m, i) => {
    let sx = 0;
    let sy = 0;
    for (const j of m) {
      sx += x[j] as number;
      sy += y[j] as number;
    }
    return {
      id: i,
      name: names[i] || `cluster ${i + 1}`,
      n: m.length,
      x: round3(m.length ? sx / m.length : 0),
      y: round3(m.length ? sy / m.length : 0),
    };
  });

  // Level 0 = the cluster names (few, big regions). Level 1 = finer local detail, shown when zoomed in.
  const labels: MapLabel[] = [
    ...clusters.filter((c) => c.n > 0).map((c) => ({ x: c.x, y: c.y, text: c.name, n: c.n, level: 0 })),
    ...gridLabels(x, y, labelText, { cellsPerAxis: 14, level: 1, minPoints: Math.max(5, Math.round(n / 2000)), terms: 2, keys: doc }),
  ];

  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    embeddingModel: opts.embeddingModel,
    dimensions: opts.dimensions,
    chunks: n,
    docs: documents.length,
    params: { ...params, nNeighbors },
    dict: { groups, sourceTypes, langs, authorities },
    documents,
    clusters,
    points: { x, y, doc, ord, head, cl },
    labels,
  };
}
