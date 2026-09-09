import { createWriteStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { config, paths } from "../config.js";
import { formatDuration } from "../ingest/progress.js";
import { VectorStore } from "../store/vector-store.js";
import { buildMap, DEFAULT_MAP_PARAMS, gridLabels, nameGroups, normalize, RandomProjector, type KbMap, type MapInputRow } from "../viz/map.js";
import { flagString, parseArgs } from "./args.js";

const { flags } = parseArgs();

if (flags["help"]) {
  console.log(`Usage: npm run map -- [--out <file>] [--clusters 8] [--neighbors 15] [--min-dist 0.1] [--epochs 400] [--project 256] [--seed 42]

Projects every chunk vector in the LanceDB index to 2-D with UMAP, groups the chunks into semantic clusters,
and writes a gzipped JSON file that the web UI renders at /map.html (npm run serve). Re-run after
\`npm run ingest\` to refresh the picture.

  --out <file>       output path (default: ${paths.kbMap})
  --relabel          recompute cluster names and labels on the existing map only (seconds, no re-projection)
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
  console.log(`\nSemantic clusters (colour and labels on the map):`);
  for (const c of [...m.clusters].sort((a, b) => b.n - a.n)) console.log(`  ${String(c.n).padStart(7)}  ${c.name}`);
};

// Naming is cheap and worth iterating on; re-projecting 60k vectors is not.
if (flags["relabel"]) {
  const existing = JSON.parse(gunzipSync(await readFile(out)).toString()) as KbMap;
  if (existing.version !== 2) throw new Error(`${out} is format v${existing.version}; rebuild it with \`npm run map\``);
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
  existing.generatedAt = new Date().toISOString();
  void ord;
  await writeMap(existing, out);
  printClusters(existing);
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

// Project each vector as it arrives and drop the full-width one: at 4096 dims a large index would not fit
// in memory (100k chunks = 1.6 GB), while the 256-dim projection is ~100 MB.
const projector = projectDims > 0 && projectDims < config.embedding.dimensions ? new RandomProjector(config.embedding.dimensions, projectDims, seed) : null;
const rows: MapInputRow[] = [];
for await (const r of store.scanForMap()) {
  rows.push({ ...r, vector: projector ? projector.project(r.vector) : normalize(r.vector) });
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
console.log(`\nOpen http://${config.server.host}:${config.server.port}/map.html after \`npm run serve\`.`);
