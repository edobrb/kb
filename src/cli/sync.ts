import { config } from "../config.js";
import { ingest } from "../ingest/pipeline.js";
import { runSync } from "../sync/index.js";
import { flagList, flagString, parseArgs } from "./args.js";

const { flags } = parseArgs();

if (flags["help"]) {
  console.log(`Usage: npm run sync -- [--source devportal,gitlab,confluence] [--full] [--dry-run] [--only <substring>] [--prune-foreign] [--ingest]

Gathers documentation from the configured sources (see sources.yaml, credentials in .env) into ${config.kbDir}
as markdown files with frontmatter. Incremental: only pages/files whose version changed are downloaded.

  --source <list>   comma-separated subset of sources (default: every enabled source, in the order
                    devportal, gitlab, confluence so GitLab can skip repos already covered by the portal)
  --full            ignore the previous state and re-download everything
  --dry-run         fetch and report, but write nothing
  --only <s>        only items whose id/title/entity/project contains <s> (debugging; never deletes)
  --prune-foreign   delete files inside kb/<source>/ that this sync did not produce (e.g. old imports)
  --ingest          run "npm run ingest" right after a successful sync
  --kb <dir>        write into another folder instead of KB_DIR=${config.kbDir} (e.g. to inspect output)
  --state-dir <dir> keep the sync state elsewhere (default: DATA_DIR/sync)`);
  process.exit(0);
}

const reports = await runSync({
  sources: flagList(flags, "source"),
  full: Boolean(flags["full"]),
  dryRun: Boolean(flags["dry-run"]),
  only: flagString(flags, "only"),
  pruneForeign: Boolean(flags["prune-foreign"]),
  kbDir: flagString(flags, "kb"),
  stateDir: flagString(flags, "state-dir"),
  log: (m) => console.log(m),
});

console.log("\nSummary");
for (const r of reports) {
  const status = r.fatal ? `ABORTED (${r.fatal})` : "ok";
  console.log(
    `  ${r.source.padEnd(11)} ${status.padEnd(6)} +${r.added} ~${r.updated} =${r.unchanged} -${r.removed}  skipped ${r.skipped}, errors ${r.errors}` +
      (r.foreign ? `, foreign files ${r.foreign}` : ""),
  );
}

const failed = reports.filter((r) => r.fatal);
if (flags["ingest"] && !flags["dry-run"]) {
  if (failed.length) console.log(`\nSkipping ingest: ${failed.length} source(s) aborted.`);
  else {
    console.log("\nIngesting...");
    const rep = await ingest({ kbDir: flagString(flags, "kb"), log: (m) => console.log(m) });
    console.log(`Ingest done: files ${rep.filesSeen}, added ${rep.docsAdded}, updated ${rep.docsUpdated}, removed ${rep.docsRemoved}, chunks ${rep.totalChunks}`);
  }
}
process.exit(failed.length ? 1 : 0);
