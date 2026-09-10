import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { filterCases, loadCases, parseFilterSpec, type EvalCase } from "../eval/dataset.js";
import {
  buildJudgePrompt,
  casePassed,
  citationHit,
  groupBy,
  looksLikeAbstention,
  missingKeywords,
  parseJudgeVerdict,
  pct,
  scoreRetrieval,
  summarize,
  type AnswerResult,
  type CaseResult,
  type GroupSummary,
} from "../eval/metrics.js";
import { askOnce } from "../generation/ask.js";
import { getChatProvider } from "../llm/chat.js";
import { Retriever } from "../retrieval/retriever.js";
import { flagString, parseArgs } from "./args.js";

/**
 * Benchmark runner over evals/questions.jsonl.
 *
 *   npm run eval                          retrieval only: hit@k, MRR, recall@k (fast, no generation)
 *   npm run eval -- --answers             + generate answers: keyword check, abstention, citation hit
 *   npm run eval -- --judge               + LLM-as-judge (correctness vs gold answer, groundedness)
 *   npm run eval -- --filter lang=it,source_type=confluence --limit 20
 *   npm run eval -- --report              write evals/reports/<timestamp>.json (or --report path.json)
 *   npm run eval -- --compare evals/reports/prev.json   print deltas against a previous report
 *
 * Measure retrieval and generation separately: if the right document is not in the top-k, no prompt fixes it.
 */

const { flags } = parseArgs();
const file = flagString(flags, "file") ?? path.join(process.cwd(), "evals", "questions.jsonl");
const k = Number(flagString(flags, "k") ?? config.retrieval.topK);
const withJudge = Boolean(flags["judge"]);
const withAnswers = Boolean(flags["answers"]) || withJudge;
const limit = Number(flagString(flags, "limit") ?? 0);
const quiet = Boolean(flags["quiet"]);
const filters = parseFilterSpec(flagString(flags, "filter"));
const compareFile = flagString(flags, "compare");
const reportFlag = flags["report"];

const GREEN = (s: string) => `\x1b[32m${s}\x1b[0m`;
const RED = (s: string) => `\x1b[31m${s}\x1b[0m`;
const YELLOW = (s: string) => `\x1b[33m${s}\x1b[0m`;
const DIM = (s: string) => `\x1b[2m${s}\x1b[0m`;

let cases = filterCases(await loadCases(file), filters);
if (limit > 0) cases = cases.slice(0, limit);
if (!cases.length) {
  console.error("No cases match. Check --file / --filter.");
  process.exit(2);
}

const mode = withJudge ? "retrieval + answers + judge" : withAnswers ? "retrieval + answers" : "retrieval only";
console.log(
  `Evaluating ${cases.length} cases from ${path.relative(process.cwd(), file)}  (k=${k}, ${mode})\n` +
    DIM(
      `embedding=${config.embedding.model}  chat=${config.chat.model}${withJudge ? `  judge=${config.eval.judgeModel}` : ""}  ` +
        `rerank=${config.retrieval.rerank}  weights vector/bm25=${config.retrieval.vectorWeight}/${config.retrieval.bm25Weight}` +
        (withAnswers ? `  tools=${config.tools.enabled ? `on (${config.tools.maxRounds} rounds, ${config.tools.docMaxChars} chars)` : "off"}` : ""),
    ) + "\n",
);

const retriever = await Retriever.open();
const results: CaseResult[] = [];

async function judge(c: EvalCase, answer: string, context: string) {
  const prompt = buildJudgePrompt(c, answer, context);
  const out = await getChatProvider().complete([{ role: "user", content: prompt }], {
    temperature: 0,
    think: false,
    model: config.eval.judgeModel,
  });
  return parseJudgeVerdict(out) ?? undefined;
}

for (const c of cases) {
  const t0 = Date.now();
  let retrieval = scoreRetrieval([], c.expected_source_ids);
  let answer: AnswerResult | undefined;
  let error: string | undefined;
  try {
    const chunks = await retriever.retrieve(c.question, { topK: k });
    retrieval = scoreRetrieval(chunks.map((r) => r.sourceId), c.expected_source_ids);
  } catch (e) {
    error = (e as Error).message;
  }
  const retrieveMs = Date.now() - t0;

  if (withAnswers && !error) {
    try {
      const res = await askOnce({ messages: [{ role: "user", content: c.question }], topK: k });
      const usedSourceIds = [...new Set(res.usedCitations.map((n) => res.citations[n - 1]?.sourceId).filter((x): x is string => !!x))];
      const missing = missingKeywords(res.answer, c.expected_keywords);
      answer = {
        text: res.answer,
        missingKeywords: missing,
        keywordPass: missing.length === 0,
        abstained: looksLikeAbstention(res.answer),
        citationHit: citationHit(usedSourceIds, c.expected_source_ids),
        usedSourceIds,
        timings: res.timings,
        ...(res.tools.length ? { toolCalls: res.tools.map(({ name, args, summary, ok }) => ({ name, args, summary, ok })) } : {}),
      };
      if (withJudge) {
        const context = res.citations.map((ct) => `[${ct.n}] ${ct.headingPath}\n${ct.excerpt}`).join("\n\n");
        answer.judge = await judge(c, res.answer, context);
      }
    } catch (e) {
      error = (e as Error).message;
    }
  }

  const result: CaseResult = {
    id: c.id,
    question: c.question,
    lang: c.lang,
    category: c.category,
    difficulty: c.difficulty,
    source_type: c.source_type,
    should_abstain: c.should_abstain,
    expected_source_ids: c.expected_source_ids,
    retrieval,
    retrieveMs,
    answer,
    pass: error ? false : casePassed(c, retrieval, answer),
    error,
  };
  results.push(result);

  if (quiet) continue;
  const tag = c.should_abstain ? DIM("NEG   ") : retrieval.rank ? GREEN(`HIT @${retrieval.rank}`.padEnd(6)) : RED("MISS  ");
  const verdict = result.pass ? GREEN("pass") : RED("FAIL");
  console.log(`${tag} ${verdict}  ${DIM(c.id.padEnd(12))} ${c.question}`);
  if (error) console.log(RED(`       error: ${error}`));
  if (!c.should_abstain && !retrieval.rank) {
    console.log(`       expected: ${c.expected_source_ids.join(" | ")}`);
    console.log(`       got:      ${retrieval.retrievedDocs.slice(0, 3).join(" | ")}`);
  } else if (!c.should_abstain && retrieval.recall < 1) {
    console.log(YELLOW(`       partial recall ${retrieval.recall.toFixed(2)} (multi-doc question)`));
  }
  if (answer) {
    if (c.should_abstain) {
      console.log(answer.abstained ? GREEN("       abstained correctly") : RED(`       did NOT abstain: ${answer.text.slice(0, 160).replace(/\n/g, " ")}`));
    } else {
      const parts = [
        answer.keywordPass ? GREEN("keywords ok") : YELLOW(`missing keywords: ${answer.missingKeywords.join(", ")}`),
        answer.citationHit ? GREEN("cites expected doc") : YELLOW("does not cite expected doc"),
        answer.abstained ? RED("abstained on an answerable question") : "",
      ].filter(Boolean);
      console.log(`       ${parts.join("  ·  ")}`);
    }
    if (answer.toolCalls?.length) {
      for (const t of answer.toolCalls) console.log(DIM(`       ${t.ok ? "tool" : "tool!"} ${t.name}: ${t.summary}`));
    }
    if (answer.judge) {
      const j = answer.judge;
      const color = j.correctness === 2 ? GREEN : j.correctness === 1 ? YELLOW : RED;
      console.log(`       judge: ${color(`correctness ${j.correctness}/2`)}  grounded ${j.grounded}/2  ${DIM(j.rationale)}`);
    }
  }
}

/* ---------------------------------- summary ---------------------------------- */

const overall = summarize(results);

function row(label: string, s: GroupSummary): string {
  const cols = [
    label.padEnd(22),
    String(s.n).padStart(4),
    pct(s.hitAtK),
    s.mrr.toFixed(3).padStart(6),
    pct(s.recall),
    withAnswers ? pct(s.keywordPass) : "",
    withAnswers ? pct(s.citationHit) : "",
    withAnswers ? pct(s.abstainPass) : "",
    withJudge ? pct(s.judgeCorrectness) : "",
    withJudge ? pct(s.judgeGrounded) : "",
    pct(s.pass),
  ];
  return cols.filter((c) => c !== "").join("  ");
}
const header = [
  "group".padEnd(22),
  "   n",
  `hit@${k}`.padStart(5),
  "   MRR",
  "recall",
  withAnswers ? "keywd" : "",
  withAnswers ? " cite" : "",
  withAnswers ? "abstn" : "",
  withJudge ? "corr." : "",
  withJudge ? "grnd." : "",
  " pass",
].filter((c) => c !== "").join("  ");

console.log(`\n${header}\n${"-".repeat(header.length)}`);
console.log(row("ALL", overall));
for (const key of ["source_type", "lang", "category", "difficulty"] as const) {
  const groups = groupBy(results, key);
  if (Object.keys(groups).length < 2) continue;
  console.log(DIM(`— by ${key}`));
  for (const [name, s] of Object.entries(groups)) console.log(row(`  ${name}`, s));
}
console.log(
  `\nLatency p50: retrieve ${overall.retrieveMsP50} ms` +
    (overall.totalMsP50 !== null ? `, end-to-end ${overall.totalMsP50} ms` : "") +
    (overall.falseAbstain !== null ? `   ·   false abstentions: ${pct(overall.falseAbstain).trim()}` : ""),
);
const withTools = results.filter((r) => r.answer?.toolCalls?.length).length;
if (withAnswers && withTools) {
  const calls = results.reduce((n, r) => n + (r.answer?.toolCalls?.length ?? 0), 0);
  console.log(DIM(`Whole-document reads: ${calls} call(s) in ${withTools}/${results.length} answers`));
}
const errors = results.filter((r) => r.error).length;
if (errors) console.log(RED(`${errors} case(s) errored — see above.`));

/* ------------------------------------ report ---------------------------------- */

interface Report {
  createdAt: string;
  file: string;
  k: number;
  mode: string;
  config: Record<string, unknown>;
  summary: GroupSummary;
  bySourceType: Record<string, GroupSummary>;
  byLang: Record<string, GroupSummary>;
  byCategory: Record<string, GroupSummary>;
  byDifficulty: Record<string, GroupSummary>;
  cases: CaseResult[];
}

const report: Report = {
  createdAt: new Date().toISOString(),
  file: path.relative(process.cwd(), file),
  k,
  mode,
  config: {
    embeddingModel: config.embedding.model,
    embeddingDimensions: config.embedding.dimensions,
    chatModel: config.chat.model,
    judgeModel: withJudge ? config.eval.judgeModel : null,
    chunking: config.chunking,
    retrieval: config.retrieval,
    tools: withAnswers ? config.tools : null,
  },
  summary: overall,
  bySourceType: groupBy(results, "source_type"),
  byLang: groupBy(results, "lang"),
  byCategory: groupBy(results, "category"),
  byDifficulty: groupBy(results, "difficulty"),
  cases: results,
};

if (reportFlag) {
  const target =
    typeof reportFlag === "string"
      ? path.resolve(reportFlag)
      : path.join(process.cwd(), "evals", "reports", `eval-${report.createdAt.replace(/[:.]/g, "-")}.json`);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(report, null, 2));
  console.log(DIM(`\nReport written to ${path.relative(process.cwd(), target)}`));
}

if (compareFile) {
  const prev = JSON.parse(await readFile(compareFile, "utf8")) as Report;
  const metric = (label: string, a: number | null, b: number | null) => {
    if (a === null || b === null) return;
    const d = (b - a) * 100;
    const sign = d > 0.5 ? GREEN(`+${d.toFixed(1)}`) : d < -0.5 ? RED(d.toFixed(1)) : DIM(d.toFixed(1));
    console.log(`  ${label.padEnd(18)} ${pct(a)} → ${pct(b)}   ${sign} pts`);
  };
  console.log(`\nCompared with ${path.relative(process.cwd(), compareFile)} (${prev.createdAt}, ${prev.summary.n} cases):`);
  metric(`hit@${k}`, prev.summary.hitAtK, overall.hitAtK);
  metric("MRR", prev.summary.mrr, overall.mrr);
  metric("recall", prev.summary.recall, overall.recall);
  metric("keyword pass", prev.summary.keywordPass, overall.keywordPass);
  metric("citation hit", prev.summary.citationHit, overall.citationHit);
  metric("abstain pass", prev.summary.abstainPass, overall.abstainPass);
  metric("judge correctness", prev.summary.judgeCorrectness, overall.judgeCorrectness);
  metric("judge grounded", prev.summary.judgeGrounded, overall.judgeGrounded);
  metric("pass", prev.summary.pass, overall.pass);

  // Per-question regressions: passed before, fails now.
  const prevById = new Map(prev.cases.map((c) => [c.id, c]));
  const regressions = results.filter((r) => prevById.get(r.id)?.pass && !r.pass);
  const fixes = results.filter((r) => prevById.get(r.id)?.pass === false && r.pass);
  if (regressions.length) {
    console.log(RED(`  regressions (${regressions.length}):`));
    for (const r of regressions) console.log(`    ${r.id}  ${r.question}`);
  }
  if (fixes.length) console.log(GREEN(`  newly passing: ${fixes.length}`));
}
