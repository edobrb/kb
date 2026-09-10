import { createWriteStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { loadTaxonomy, placeKbDocuments, type CityMap, type KbPlacement } from "../citymap.js";
import { config, paths } from "../config.js";
import { formatDuration } from "../ingest/progress.js";
import { VectorStore } from "../store/vector-store.js";
import { readState } from "../sync/state.js";
import { buildMap, DEFAULT_MAP_PARAMS, gridLabels, nameGroups, normalize, RandomProjector, type KbMap, type MapInputRow } from "../viz/map.js";
import { flagString, parseArgs } from "./args.js";

const { flags } = parseArgs();

if (flags["help"]) {
  console.log(`Usage: npm run map -- [--out <file>] [--clusters 8] [--neighbors 15] [--min-dist 0.1] [--epochs 400] [--project 256] [--seed 42]

Projects every chunk vector in the LanceDB index to 2-D with UMAP, groups the chunks into semantic clusters,
and writes a gzipped JSON file that the web UI renders at /map.html (npm run serve). Re-run after
\`npm run ingest\` to refresh the picture. Documents are also placed on TeamSystem's City Map (area › sub-area ›
module) from the Dev Portal catalog saved by \`npm run sync\` plus the rules in taxonomy.yaml; that is the
default colour of the map.

  --out <file>       output path (default: ${paths.kbMap})
  --relabel          recompute cluster names, labels and City Map placements on the existing map only (seconds, no re-projection)
  --clusters <n>     semantic clusters used for colour and labels (default ${DEFAULT_MAP_PARAMS.clusters}; >8 share grey in the UI)
  --neighbors <n>    UMAP n_neighbors: small = local detail, large = global shape (default ${DEFAULT_MAP_PARAMS.nNeighbors})
  --min-dist <f>     UMAP min_dist: how tightly points may pack (default ${DEFAULT_MAP_PARAMS.minDist})
  --epochs <n>       optimisation epochs (default ${DEFAULT_MAP_PARAMS.nEpochs})
  --project <dims>   random-projection width before UMAP, 0 = raw vectors (default ${DEFAULT_MAP_PARAMS.projectDims})
  --seed <n>         PRNG seed (default ${DEFAULT_MAP_PARAMS.seed})`);
  process.exit(0);
}

const num = (name: string): number | undefined => {
  const v = flagString(flags, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number, got "${v}"`);
  return n;
};

const out = flagString(flags, "out") ?? paths.kbMap;
const started = Date.now();

const writeMap = async (m: KbMap, path: string): Promise<number> => {
  // Gzipped on disk and served with content-encoding: gzip, so the browser gets a few hundred KB
  // instead of several MB as the knowledge base grows.
  const json = JSON.stringify(m);
  await pipeline(Readable.from([json]), createGzip({ level: 9 }), createWriteStream(path));
  console.log(`Size: ${mb((await stat(path)).size)} gzipped (${mb(Buffer.byteLength(json))} raw)`);
  return Buffer.byteLength(json);
};
const mb = (b: number) => `${(b / 1_048_576).toFixed(1)} MB`;

const printClusters = (m: KbMap) => {
  console.log(`\nSemantic clusters (labels on the map):`);
  for (const c of [...m.clusters].sort((a, b) => b.n - a.n)) console.log(`  ${String(c.n).padStart(7)}  ${c.name}`);
};

const printPlaces = (m: KbMap) => {
  const chunksBySubarea = new Map<string, number>();
  for (const di of m.points.doc) {
    const name = m.dict.subareas[(m.documents[di] as KbMap["documents"][number]).sa] ?? "";
    chunksBySubarea.set(name, (chunksBySubarea.get(name) ?? 0) + 1);
  }
  console.log(`\nCity Map sub-areas (default colour of the map, chunks):`);
  for (const [name, n] of [...chunksBySubarea.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16)) console.log(`  ${String(n).padStart(7)}  ${name || "—"}`);
};

/**
 * City Map position of every document: the catalog copy saved by the last `npm run sync` plus taxonomy.yaml.
 * Read from kb/ frontmatter here rather than stored in the index, so changing a rule is a `--relabel`, not an ingest.
 */
const placeDocuments = async (relPaths: Iterable<string>): Promise<Map<string, KbPlacement>> => {
  const cityMap = ((await readState(paths.syncState, "devportal"))?.meta["citymap"] as CityMap | undefined) ?? null;
  if (!cityMap) console.log(`No City Map in ${paths.syncState}/devportal.json (run \`npm run sync\` with Dev Portal credentials) — placing documents with taxonomy.yaml only.`);
  const taxonomy = await loadTaxonomy(config.sync.taxonomyFile);
  const placed = await placeKbDocuments(config.kbDir, relPaths, cityMap, taxonomy);
  const via: Record<string, number> = {};
  for (const p of placed.values()) via[p.via] = (via[p.via] ?? 0) + 1;
  const total = placed.size;
  const unplaced = via["none"] ?? 0;
  const how = ["frontmatter", "catalog", "repo", "rule", "owner"].filter((k) => via[k]).map((k) => `${via[k]} via ${k}`).join(", ");
  console.log(
    `City Map: ${(total - unplaced).toLocaleString("en-US")} of ${total.toLocaleString("en-US")} documents placed (${Math.round(((total - unplaced) / Math.max(1, total)) * 100)}%)` +
      (how ? ` — ${how}` : "") +
      (unplaced ? `; ${unplaced.toLocaleString("en-US")} not on the map` : ""),
  );
  return placed;
};

const intern = (list: string[], v: string): number => {
  const i = list.indexOf(v);
  return i >= 0 ? i : list.push(v) - 1;
};

// Naming is cheap and worth iterating on; re-projecting 60k vectors is not.
if (flags["relabel"]) {
  const existing = JSON.parse(gunzipSync(await readFile(out)).toString()) as KbMap;
  const version = existing.version as number;
  if (version !== 2 && version !== 3) throw new Error(`${out} is format v${version}; rebuild it with \`npm run map\``);
  const { x, y, doc, ord, head, cl } = existing.points;
  const texts = head.map((h, i) => `${(existing.documents[doc[i] as number] as { title: string }).title} ${h}`);
  const members: number[][] = existing.clusters.map(() => []);
  cl.forEach((c, i) => (members[c] as number[]).push(i));
  const names = nameGroups(members, texts, 3, doc);
  existing.clusters = existing.clusters.map((c, i) => ({ ...c, name: names[i] || `cluster ${i + 1}` }));
  existing.labels = [
    ...existing.clusters.filter((c) => c.n > 0).map((c) => ({ x: c.x, y: c.y, text: c.name, n: c.n, level: 0 })),
    ...gridLabels(x, y, texts, { cellsPerAxis: 14, level: 1, minPoints: Math.max(5, Math.round(x.length / 2000)), terms: 2, keys: doc }),
  ];
  // City Map placements too (a v2 map is upgraded in place: it lacked them).
  const placed = await placeDocuments(existing.documents.map((d) => d.path));
  const areas: string[] = [];
  const subareas: string[] = [];
  const modules: string[] = [];
  existing.documents = existing.documents.map((d) => {
    const l = placed.get(d.path)?.labels;
    return { ...d, ar: intern(areas, l?.area ?? ""), sa: intern(subareas, l?.subarea ?? ""), mo: intern(modules, l?.module ?? "") };
  });
  existing.dict = { ...existing.dict, areas, subareas, modules };
  existing.version = 3;
  existing.generatedAt = new Date().toISOString();
  void ord;
  await writeMap(existing, out);
  printClusters(existing);
  printPlaces(existing);
  console.log(`\nRelabelled ${out} in ${formatDuration(Date.now() - started)} — reload /map.html.`);
  process.exit(0);
}

const store = await VectorStore.open(paths.lanceDb, config.embedding.dimensions);
if (store.isEmpty) {
  console.error(`Vector index at ${paths.lanceDb} is empty — run \`npm run ingest\` first.`);
  process.exit(1);
}

const projectDims = num("project") ?? DEFAULT_MAP_PARAMS.projectDims;
const seed = num("seed") ?? DEFAULT_MAP_PARAMS.seed;
const total = await store.count();
console.log(`Reading ${total.toLocaleString("en-US")} chunks from ${paths.lanceDb}…`);

// Project each vector as it arrives and drop the full-width one: a large index would not fit in memory
// otherwise (100k chunks is 1.6 GB at 4096 dims, 400 MB at 1024), while the 256-dim projection is ~100 MB.
// Skipped when EMBEDDING_DIMENSIONS is already at or below the projection width.
const projector = projectDims > 0 && projectDims < config.embedding.dimensions ? new RandomProjector(config.embedding.dimensions, projectDims, seed) : null;
const rows: MapInputRow[] = [];
for await (const r of store.scanForMap()) {
  rows.push({ ...r, vector: projector ? projector.project(r.vector) : normalize(r.vector) });
}
{
  const placed = await placeDocuments(rows.map((r) => r.rel_path));
  for (const r of rows) {
    const l = placed.get(r.rel_path)?.labels;
    if (l) Object.assign(r, { area: l.area, subarea: l.subarea, module: l.module });
  }
}

const interactive = Boolean(process.stdout.isTTY);
let lastLine = "";
const line = (s: string) => {
  if (interactive) {
    process.stdout.write(`\r${s.padEnd(lastLine.length)}`);
    lastLine = s;
  } else if (s !== lastLine) {
    console.log(s);
    lastLine = s;
  }
};

const map = await buildMap(rows, {
  embeddingModel: config.embedding.model,
  dimensions: config.embedding.dimensions,
  preProjected: true,
  params: {
    nNeighbors: num("neighbors"),
    minDist: num("min-dist"),
    nEpochs: num("epochs"),
    clusters: num("clusters"),
    projectDims,
    seed,
  },
  onProgress: (p) => {
    if (p.phase === "project") line("Preparing vectors…");
    else if (p.phase === "cluster") line("Clustering in embedding space…");
    else if (p.phase === "labels") line("Naming clusters…");
    else if (p.epoch !== undefined && p.epochs) line(`UMAP epoch ${p.epoch}/${p.epochs} (${Math.round((100 * p.epoch) / p.epochs)}%) · ${formatDuration(Date.now() - started)}`);
  },
});
if (interactive) process.stdout.write("\n");

console.log(
  `Wrote ${out} — ${map.chunks.toLocaleString("en-US")} chunks from ${map.docs.toLocaleString("en-US")} documents in ${formatDuration(Date.now() - started)}`,
);
await writeMap(map, out);
printClusters(map);
printPlaces(map);
console.log(`\nOpen http://${config.server.host}:${config.server.port}/map.html after \`npm run serve\`.`);
