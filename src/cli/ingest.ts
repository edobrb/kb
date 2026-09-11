import { config } from "../config.js";
import { ingest } from "../ingest/pipeline.js";
import { createProgressRenderer, formatDuration } from "../ingest/progress.js";
import { flagString, parseArgs } from "./args.js";

const { flags } = parseArgs();

if (flags["help"]) {
  console.log(`Usage: npm run ingest -- [--reset] [--dry-run] [--only <substring>] [--kb <dir>]

  --reset       drop the current index and rebuild everything
  --dry-run     parse + chunk only; print stats and a few sample chunks
  --only <s>    only process files whose path contains <s>
  --kb <dir>    knowledge base folder (default: KB_DIR=${config.kbDir})
  --quiet       no live progress line (only phase messages)`);
  process.exit(0);
}

// A TTY gets one line rewritten in place; a pipe/CI log gets a new line every 15 s.
const interactive = Boolean(process.stdout.isTTY) && !flags["quiet"];
const progress = createProgressRenderer({
  interactive,
  write: (s) => process.stdout.write(s),
  columns: process.stdout.columns ?? 0,
});

const report = await ingest({
  reset: Boolean(flags["reset"]),
  dryRun: Boolean(flags["dry-run"]),
  only: flagString(flags, "only"),
  kbDir: flagString(flags, "kb"),
  log: (m) => {
    progress.finish();
    console.log(m);
  },
  onProgress: flags["quiet"] ? undefined : (p) => progress.update(p),
});
progress.finish();

const n = (v: number) => v.toLocaleString("en-US");
console.log(
  `\nDone in ${formatDuration(report.durationMs)} — files: ${n(report.filesSeen)}, unchanged: ${n(report.docsUnchanged)}, ` +
    `added: ${n(report.docsAdded)}, updated: ${n(report.docsUpdated)}, metadata only: ${n(report.docsRefreshed)}, ` +
    `removed: ${n(report.docsRemoved)}, ` +
    `chunks written: ${n(report.chunksWritten)}, total chunks in index: ${n(report.totalChunks)}`,
);
