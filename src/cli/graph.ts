import { config, paths } from "../config.js";
import { buildGraph, KbGraph, loadPlaces, manifestDocs, relationPhrase, RESOLUTION_REASONS, HUB_TYPES, type NodeType, type Relation } from "../graph/index.js";
import { formatDuration } from "../ingest/progress.js";
import { flagList, flagString, parseArgs } from "./args.js";

/**
 * Build and inspect the knowledge graph (src/graph).
 *
 *   npm run graph                                  rebuild data/graph.json.gz and report
 *   npm run graph -- --neighbors <source-id>       what one document is connected to
 *   npm run graph -- --hubs repo --top 20          the biggest repositories / spaces / modules / tags
 *   npm run graph -- --broken-links --top 40       internal links that point at nothing indexed
 */
const { flags, positional } = parseArgs();

if (flags["help"]) {
  console.log(`Usage: npm run graph -- [--neighbors <source-id>] [--hubs <type>] [--broken-links] [--relations a,b] [--top 25] [--json]

With no flag it rebuilds ${paths.graph} from the ingest manifest and prints what it found. The other
flags read the existing file instead of rebuilding.

  --neighbors <id>   list what one document is connected to (source_id, or a kb path)
  --relations <a,b>  restrict --neighbors to these relations (${["links_to", "child_of", "in_repo", "in_module"].join(", ")}, …)
  --members <hub>    list the documents of one hub ("repo:oneplatform/adrs", "tag:quarkus")
  --hubs <type>      biggest hubs of a type: ${HUB_TYPES.join(" | ")}
  --broken-links     internal links whose target is not indexed, grouped by reason
  --top <n>          rows to print (default 25)
  --json             machine-readable output`);
  process.exit(0);
}

const top = Number(flagString(flags, "top") ?? 25);
const asJson = Boolean(flags["json"]);
const pct = (n: number, d: number) => `${Math.round((100 * n) / Math.max(1, d))}%`;
const pad = (n: number | string, w: number) => String(n).padStart(w);

const openExisting = async (): Promise<KbGraph> => {
  const graph = await KbGraph.load();
  if (!graph) throw new Error(`No graph at ${paths.graph} — run \`npm run graph\` first.`);
  return graph;
};

// ---- inspection (no rebuild) --------------------------------------------------------------------

const neighborsOf = flagString(flags, "neighbors") ?? (positional.length ? positional.join(" ") : undefined);
if (neighborsOf) {
  const graph = await openExisting();
  const relations = flagList(flags, "relations") as Relation[] | undefined;
  const rows = graph.neighbors(neighborsOf, { limit: top, ...(relations ? { relations } : {}) });
  const node = graph.node(neighborsOf);
  if (!node) {
    console.error(`"${neighborsOf}" is not in the graph (${graph.docCount} documents). Ids look like "gitlab:oneplatform/adrs:Platform/ADR0010.md".`);
    process.exit(2);
  }
  if (asJson) {
    console.log(JSON.stringify({ node, hubs: graph.hubsOf(neighborsOf), neighbors: rows }, null, 2));
  } else {
    console.log(`${node.label}\n${node.id}\n`);
    const hubs = graph.hubsOf(neighborsOf);
    if (hubs.length) console.log(`Belongs to: ${hubs.map((h) => `${h.id} (${h.size})`).join(" · ")}\n`);
    if (!rows.length) console.log("No related documents.");
    for (const n of rows) {
      console.log(`  ${n.weight.toFixed(2)}  ${relationPhrase(n).padEnd(18)} ${n.title}`);
      console.log(`        ${n.sourceId}${n.via ? `  (via ${n.via.id}, ${n.via.size} docs)` : ""}`);
    }
  }
  process.exit(0);
}

const membersOf = flagString(flags, "members");
if (membersOf) {
  const graph = await openExisting();
  const rows = graph.membersOf(membersOf, top);
  if (asJson) console.log(JSON.stringify(rows, null, 2));
  else {
    console.log(`${membersOf}: ${graph.hubSize(membersOf)} documents\n`);
    for (const r of rows) console.log(`  ${r.title}\n        ${r.sourceId}`);
  }
  process.exit(0);
}

const hubType = flagString(flags, "hubs");
if (hubType) {
  if (!HUB_TYPES.includes(hubType as NodeType)) {
    console.error(`--hubs must be one of ${HUB_TYPES.join(", ")}`);
    process.exit(1);
  }
  const graph = await openExisting();
  const rows = graph.hubs(hubType as NodeType, top);
  if (asJson) console.log(JSON.stringify(rows, null, 2));
  else for (const r of rows) console.log(`  ${pad(r.size, 6)}  ${r.label}${r.label === r.id.split(":").slice(1).join(":") ? "" : `  (${r.id})`}`);
  process.exit(0);
}

if (flags["broken-links"]) {
  const graph = await openExisting();
  const links = graph.brokenLinks;
  if (asJson) {
    console.log(JSON.stringify(links, null, 2));
    process.exit(0);
  }
  const byReason = new Map<string, number>();
  for (const l of links) byReason.set(l.reason, (byReason.get(l.reason) ?? 0) + 1);
  console.log(`${graph.stats.brokenLinksTotal} internal links point at nothing indexed (${links.length} kept in the file).\n`);
  for (const [reason, n] of [...byReason].sort((a, b) => b[1] - a[1])) {
    console.log(`${pad(n, 6)}  ${reason} — ${RESOLUTION_REASONS[reason]?.what ?? ""}`);
  }
  // The same wrong href repeated across pages is one docs bug, so group by target.
  const byHref = new Map<string, { n: number; reason: string; from: string }>();
  for (const l of links) {
    const e = byHref.get(l.href);
    if (e) e.n++;
    else byHref.set(l.href, { n: 1, reason: l.reason, from: l.from });
  }
  console.log(`\nMost-repeated dangling targets:`);
  for (const [href, e] of [...byHref].sort((a, b) => b[1].n - a[1].n).slice(0, top)) {
    console.log(`${pad(e.n, 6)}  ${href}`);
    console.log(`        ${e.reason} · e.g. from ${e.from}`);
  }
  process.exit(0);
}

// ---- build ---------------------------------------------------------------------------------------

const started = Date.now();
const docs = await manifestDocs();
console.log(`Building the graph over ${docs.length.toLocaleString("en-US")} indexed documents from ${config.kbDir}…`);
const places = await loadPlaces(docs.map((d) => d.relPath));
if (!places) console.log(`No City Map available (run \`npm run sync\`) — building without area/sub-area/module hubs.`);
const graph = await buildGraph({ docs, places, log: (m) => console.log(m) });
const bytes = await KbGraph.save(graph);

const s = graph.stats;
console.log(`\nWrote ${paths.graph} — ${(bytes / 1024).toFixed(0)} kB gzipped (${(JSON.stringify(graph).length / 1_048_576).toFixed(2)} MB raw) in ${formatDuration(Date.now() - started)}`);
console.log(`${s.nodes.toLocaleString("en-US")} nodes · ${s.edges.toLocaleString("en-US")} edges`);

console.log(`\nEdges by relation:`);
for (const [r, n] of Object.entries(s.byRelation).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))) console.log(`${pad(n ?? 0, 8)}  ${r}`);

console.log(`\nConnectivity (document-to-document edges only):`);
console.log(`  ${s.connectedDocs.toLocaleString("en-US")} of ${graph.docs.toLocaleString("en-US")} documents have one (${pct(s.connectedDocs, graph.docs)})`);
console.log(`  largest connected component: ${s.largestComponent.toLocaleString("en-US")} documents (${pct(s.largestComponent, graph.docs)})`);

const loaded = new KbGraph(graph);
for (const type of HUB_TYPES) {
  const rows = loaded.hubs(type, 3);
  if (rows.length) console.log(`  biggest ${type}: ${rows.map((r) => `${r.label} (${r.size})`).join(", ")}`);
}

console.log(`\nBody-link targets dropped:`);
for (const [reason, n] of Object.entries(s.unresolved).sort((a, b) => b[1] - a[1])) {
  const meta = RESOLUTION_REASONS[reason];
  console.log(`${pad(n, 8)}  ${reason}${meta?.internal ? " *" : ""} — ${meta?.what ?? ""}`);
}
console.log(`\n* ${s.brokenLinksTotal.toLocaleString("en-US")} of those are dangling internal references written in the documentation: \`npm run graph -- --broken-links\``);
const gaps = Object.entries(s.scopeGaps).sort((a, b) => b[1] - a[1]);
if (gaps.length) {
  console.log(
    `\n${gaps.reduce((n, [, c]) => n + c, 0).toLocaleString("en-US")} frontmatter references point outside the index ` +
      `(${gaps.map(([r, n]) => `${n} ${r}`).join(", ")}) — excluded trees and repositories, not broken links.`,
  );
}

