import { Retriever } from "../retrieval/retriever.js";
import type { Authority } from "../types.js";
import { flagList, flagString, parseArgs } from "./args.js";

const { flags, positional } = parseArgs();
const query = positional.join(" ").trim();

if (!query || flags["help"]) {
  console.log(`Usage: npm run search -- "your query" [--k 10] [--source-type adr,gitlab] [--kind code,doc] [--authority binding] [--lang en]

Shows the retrieval stage only (no LLM): fused rank, vector rank, BM25 rank, and the chunk text.`);
  process.exit(query ? 0 : 1);
}

const retriever = await Retriever.open();
const k = Number(flagString(flags, "k") ?? 10);
const results = await retriever.retrieve(query, {
  topK: k,
  noRerank: Boolean(flags["no-rerank"]),
  filters: {
    sourceTypes: flagList(flags, "source-type"),
    kinds: flagList(flags, "kind"),
    authorities: flagList(flags, "authority") as Authority[] | undefined,
    langs: flagList(flags, "lang"),
  },
});

if (!results.length) {
  console.log("No results.");
  process.exit(0);
}
results.forEach((r, i) => {
  console.log(
    `\n#${i + 1}  score=${r.score.toFixed(4)}  vec=${r.vectorRank ?? "-"}  bm25=${r.bm25Rank ?? "-"}  [${r.sourceType}/${r.kind}/${r.authority}]`,
  );
  console.log(`    ${r.headingPath}${r.lineStart ? `  L${r.lineStart}-${r.lineEnd}` : ""}`);
  console.log(`    ${r.sourceUrl ?? r.relPath}`);
  console.log(`    ${r.content.replace(/\s+/g, " ").slice(0, 240)}…`);
});
