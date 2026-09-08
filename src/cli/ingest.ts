import { config } from "../config.js";
import { ingest } from "../ingest/pipeline.js";
import { flagString, parseArgs } from "./args.js";

const { flags } = parseArgs();

if (flags["help"]) {
  console.log(`Usage: npm run ingest -- [--reset] [--dry-run] [--only <substring>] [--kb <dir>]

  --reset       drop the current index and rebuild everything
  --dry-run     parse + chunk only; print stats and a few sample chunks
  --only <s>    only process files whose path contains <s>
  --kb <dir>    knowledge base folder (default: KB_DIR=${config.kbDir})`);
  process.exit(0);
}

const report = await ingest({
  reset: Boolean(flags["reset"]),
  dryRun: Boolean(flags["dry-run"]),
  only: flagString(flags, "only"),
  kbDir: flagString(flags, "kb"),
  log: (m) => console.log(m),
});

console.log(
  `\nDone in ${(report.durationMs / 1000).toFixed(1)}s — files: ${report.filesSeen}, unchanged: ${report.docsUnchanged}, ` +
    `added: ${report.docsAdded}, updated: ${report.docsUpdated}, removed: ${report.docsRemoved}, ` +
    `chunks written: ${report.chunksWritten}, total chunks in index: ${report.totalChunks}`,
);
