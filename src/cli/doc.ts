import { DocumentNotFoundError, getDocumentStore } from "../retrieval/documents.js";
import { flagString, parseArgs } from "./args.js";

/**
 * Print a whole kb document by source_id — the same view the model gets from the `fetch_document`
 * tool, so a bad answer can be checked against what the tool would actually have returned.
 *
 *   npm run doc -- "devportal:default/component/m3/m3/core-features/transfer-flow/"
 *   npm run doc -- confluence:TeamCore:907739295 --section "Passwordless"
 */
const { flags, positional } = parseArgs();
const requested = positional.join(" ").trim();

if (!requested || flags["help"]) {
  console.log(`Usage: npm run doc -- <source-id|kb/path.md> [--section "Heading"] [--max-chars 20000] [--outline] [--json]`);
  process.exit(requested ? 0 : 1);
}

const store = await getDocumentStore();
try {
  const maxChars = flags["max-chars"] ? Number(flagString(flags, "max-chars")) : undefined;
  const doc = await store.fetch(requested, {
    section: flagString(flags, "section") ?? null,
    ...(maxChars ? { maxChars } : {}),
  });
  if (flags["json"]) {
    console.log(JSON.stringify(doc, null, 2));
  } else if (flags["outline"]) {
    console.log(`${doc.title}  (${doc.sourceId}, ${doc.totalChars} chars)`);
    for (const h of doc.outline) console.log(`  - ${h}`);
  } else {
    console.error(
      `\x1b[2m${doc.sourceId} · ${doc.sourceType}/${doc.kind} · authority=${doc.authority} · ` +
        `${doc.returnedChars}/${doc.totalChars} chars${doc.truncated ? " (truncated)" : ""}` +
        `${doc.section ? ` · section "${doc.section}"` : ""}\x1b[0m`,
    );
    console.log(doc.content);
  }
} catch (err) {
  if (err instanceof DocumentNotFoundError) {
    console.error(`Not found: ${err.message}`);
    console.error(`(${store.size} documents indexed; run npm run ingest if the manifest is stale)`);
    process.exit(2);
  }
  throw err;
}
