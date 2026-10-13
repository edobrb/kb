import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config, paths } from "../config.js";
import { listMarkdownFiles, parseFrontmatter } from "../ingest/loader.js";
import { redactSecrets, type SecretFinding } from "../secrets.js";
import { flagString, parseArgs } from "./args.js";

/**
 * Credentials published in the pages the knowledge base copies (src/secrets.ts).
 *
 *   npm run secrets                   scan kb/, print one line per document, write data/feedback/secrets.json
 *   npm run secrets -- --json         the same list on stdout
 *   npm run secrets -- --rule jwt     only one rule
 *
 * The index never holds these values (they are redacted at ingest and again at retrieval), but the pages
 * upstream still publish them: this is the list to send to their owners, who have to rotate the
 * credential and edit the page. Values are never printed, only their first characters and length.
 */
const { flags } = parseArgs();

if (flags["help"]) {
  console.log(`Usage: npm run secrets -- [--json] [--rule <name>]

Scans every markdown file under ${config.kbDir} for credentials and writes ${paths.secretsReport}.`);
  process.exit(0);
}

const onlyRule = flagString(flags, "rule");

interface DocumentSecrets {
  source_id: string;
  source_url: string | null;
  owner: string | null;
  rel_path: string;
  rules: Record<string, number>;
  findings: SecretFinding[];
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

const found: DocumentSecrets[] = [];
for (const relPath of await listMarkdownFiles(config.kbDir)) {
  const raw = await readFile(path.join(config.kbDir, relPath), "utf8");
  const { frontmatter, body } = parseFrontmatter(raw);
  const findings = redactSecrets(body).findings.filter((f) => !onlyRule || f.rule === onlyRule);
  if (!findings.length) continue;
  const rules: Record<string, number> = {};
  for (const f of findings) rules[f.rule] = (rules[f.rule] ?? 0) + 1;
  found.push({
    source_id: str(frontmatter["source_id"]) ?? relPath,
    source_url: str(frontmatter["source_url"]),
    owner: str(frontmatter["owner"]),
    rel_path: relPath.split(path.sep).join("/"),
    rules,
    findings,
  });
}
found.sort((a, b) => b.findings.length - a.findings.length || a.source_id.localeCompare(b.source_id));

const report = { generated_at: new Date().toISOString(), documents: found.length, findings: found.reduce((n, d) => n + d.findings.length, 0), list: found };
await mkdir(path.dirname(paths.secretsReport), { recursive: true });
await writeFile(paths.secretsReport, `${JSON.stringify(report, null, 2)}\n`, "utf8");

if (flags["json"]) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const byRule = new Map<string, number>();
  for (const d of found) for (const [r, n] of Object.entries(d.rules)) byRule.set(r, (byRule.get(r) ?? 0) + n);
  console.log(`${report.findings} credentials in ${found.length} documents (values redacted in the index and in fetch_document)\n`);
  for (const [r, n] of [...byRule].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${r}`);
  console.log("");
  for (const d of found) {
    const rules = Object.entries(d.rules).map(([r, n]) => `${r}×${n}`).join(", ");
    console.log(`${d.source_id}\n    ${rules}${d.owner ? `  · owner ${d.owner}` : ""}\n    ${d.source_url ?? d.rel_path}`);
  }
  console.log(`\nWritten to ${paths.secretsReport}`);
}
