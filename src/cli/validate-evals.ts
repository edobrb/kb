import path from "node:path";
import { config } from "../config.js";
import { CATEGORIES, DIFFICULTIES, LANGS, loadCases, type EvalCase } from "../eval/dataset.js";
import { containsKeyword } from "../eval/metrics.js";
import { listMarkdownFiles, loadDocument } from "../ingest/loader.js";
import { flagString, parseArgs } from "./args.js";

/**
 * Static checks for evals/questions.jsonl against the kb/ folder — no models, no index needed.
 *
 *   npm run eval:validate                 # errors → exit 1
 *   npm run eval:validate -- --strict     # warnings are errors too
 *   npm run eval:validate -- --file other.jsonl --kb ./kb
 *
 * Checks: valid JSONL, unique ids, every expected_source_id exists in kb/, every expected_keyword occurs
 * verbatim in one of the expected documents, negatives have no sources, enum fields, duplicates.
 * Run it whenever the dataset or the kb changes: a renamed page silently turns a HIT into a MISS otherwise.
 */

const { flags } = parseArgs();
const file = flagString(flags, "file") ?? path.join(process.cwd(), "evals", "questions.jsonl");
const kbDir = path.resolve(flagString(flags, "kb") ?? config.kbDir);
const strict = Boolean(flags["strict"]);

const errors: string[] = [];
const warnings: string[] = [];
const err = (c: EvalCase | null, msg: string) => errors.push(c ? `${c.id}: ${msg}` : msg);
const warn = (c: EvalCase | null, msg: string) => warnings.push(c ? `${c.id}: ${msg}` : msg);

let cases: EvalCase[];
try {
  cases = await loadCases(file);
} catch (e) {
  console.error(`Cannot parse ${file}: ${(e as Error).message}`);
  process.exit(1);
}

// Index the kb once: source_id -> body (lower-cased by containsKeyword) + declared source_type.
const docs = new Map<string, { body: string; sourceType: string; title: string }>();
for (const rel of await listMarkdownFiles(kbDir)) {
  const d = await loadDocument(kbDir, rel);
  if (docs.has(d.meta.sourceId)) warn(null, `kb: duplicate source_id ${d.meta.sourceId} (${rel})`);
  docs.set(d.meta.sourceId, { body: `${d.meta.title}\n${d.body}`, sourceType: d.meta.sourceType, title: d.meta.title });
}

const seenIds = new Map<string, number>();
const seenQuestions = new Map<string, string>();
const perDoc = new Map<string, number>();

for (const c of cases) {
  seenIds.set(c.id, (seenIds.get(c.id) ?? 0) + 1);
  const normQ = c.question.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const dup = seenQuestions.get(normQ);
  if (dup) warn(c, `duplicate question of ${dup}`);
  else seenQuestions.set(normQ, c.id);

  if (!(LANGS as readonly string[]).includes(c.lang)) warn(c, `lang "${c.lang}" not in ${LANGS.join("/")}`);
  if (!(CATEGORIES as readonly string[]).includes(c.category)) warn(c, `category "${c.category}" not in ${CATEGORIES.join("/")}`);
  if (!(DIFFICULTIES as readonly string[]).includes(c.difficulty)) warn(c, `difficulty "${c.difficulty}" not in ${DIFFICULTIES.join("/")}`);
  if (c.question.length < 12) warn(c, "question is very short");

  if (c.should_abstain) {
    if (c.expected_source_ids.length) err(c, "negative case must not list expected_source_ids");
    if (c.expected_keywords.length) warn(c, "negative case has expected_keywords (ignored)");
    continue;
  }

  if (!c.expected_source_ids.length) err(c, "no expected_source_ids");
  const found = c.expected_source_ids.filter((id) => docs.has(id));
  for (const id of c.expected_source_ids) {
    if (!docs.has(id)) err(c, `expected_source_id not found in kb: ${id}`);
    else perDoc.set(id, (perDoc.get(id) ?? 0) + 1);
  }
  const types = new Set(found.map((id) => (docs.get(id) as { sourceType: string }).sourceType));
  if (found.length && !types.has(c.source_type)) warn(c, `source_type "${c.source_type}" but expected docs are ${[...types].join(",")}`);
  if (c.category === "multi-hop" && c.expected_source_ids.length < 2) warn(c, "multi-hop with a single expected document");

  if (!c.expected_keywords.length) warn(c, "no expected_keywords (answer check will be skipped)");
  for (const kw of c.expected_keywords) {
    const present = found.some((id) => containsKeyword((docs.get(id) as { body: string }).body, kw));
    if (!present) err(c, `keyword "${kw}" not found in expected document(s)`);
    if (kw.length < 3) warn(c, `keyword "${kw}" is very short and will match almost anything`);
  }
  if (!c.expected_answer) warn(c, "no expected_answer (LLM judge will fall back to keywords)");
  if (c.expected_answer) {
    for (const kw of c.expected_keywords) {
      if (!containsKeyword(c.expected_answer, kw)) warn(c, `gold answer itself does not contain keyword "${kw}"`);
    }
  }
}
for (const [id, n] of seenIds) if (n > 1) err(null, `duplicate id ${id} (${n} times)`);

/* ------------------------------ summary ------------------------------ */

const count = (key: keyof EvalCase) => {
  const m = new Map<string, number>();
  for (const c of cases) m.set(String(c[key]), (m.get(String(c[key])) ?? 0) + 1);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("  ");
};
console.log(`${cases.length} cases in ${path.relative(process.cwd(), file)}  ·  kb: ${docs.size} documents`);
console.log(`  source_type: ${count("source_type")}`);
console.log(`  lang:        ${count("lang")}`);
console.log(`  category:    ${count("category")}`);
console.log(`  difficulty:  ${count("difficulty")}`);
console.log(`  distinct documents referenced: ${perDoc.size}  ·  negatives: ${cases.filter((c) => c.should_abstain).length}`);
const hot = [...perDoc.entries()].filter(([, n]) => n > 4).sort(([, a], [, b]) => b - a);
if (hot.length) console.log(`  documents with >4 questions: ${hot.map(([id, n]) => `${id} (${n})`).join(", ")}`);

if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.log(`  \x1b[33m⚠\x1b[0m ${w}`);
}
if (errors.length) {
  console.log(`\n${errors.length} error(s):`);
  for (const e of errors) console.log(`  \x1b[31m✖\x1b[0m ${e}`);
}
const failed = errors.length > 0 || (strict && warnings.length > 0);
console.log(failed ? "\n\x1b[31mValidation failed.\x1b[0m" : "\n\x1b[32mDataset is valid.\x1b[0m");
process.exit(failed ? 1 : 0);
