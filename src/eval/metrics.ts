import type { EvalCase } from "./dataset.js";

/* ------------------------------------------------------------------ */
/* Retrieval                                                           */
/* ------------------------------------------------------------------ */

export interface RetrievalOutcome {
  /** 1-based rank of the first expected document among retrieved documents; null = miss. */
  rank: number | null;
  /** Fraction of expected documents present in the retrieved set (1.0 for single-doc questions on a hit). */
  recall: number;
  /** Distinct retrieved source_ids in ranking order. */
  retrievedDocs: string[];
}

export function scoreRetrieval(retrievedSourceIdsInOrder: string[], expected: string[]): RetrievalOutcome {
  const retrievedDocs = [...new Set(retrievedSourceIdsInOrder)];
  const idx = retrievedDocs.findIndex((id) => expected.includes(id));
  const found = expected.filter((id) => retrievedDocs.includes(id)).length;
  return {
    rank: idx >= 0 ? idx + 1 : null,
    recall: expected.length ? found / expected.length : 0,
    retrievedDocs,
  };
}

/* ------------------------------------------------------------------ */
/* Answer checks                                                       */
/* ------------------------------------------------------------------ */

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Case- and whitespace-insensitive substring test, shared by the eval runner and the dataset validator. */
export function containsKeyword(text: string, keyword: string): boolean {
  return normalize(text).includes(normalize(keyword));
}

export function missingKeywords(answer: string, keywords: string[]): string[] {
  return keywords.filter((kw) => !containsKeyword(answer, kw));
}

/** Phrases the system prompt asks the model to use when the KB does not cover a question (EN + IT). */
const KB_SUBJECT_EN = "(knowledge base|kb|provided (context|documents|documentation|sources)|available (context|documents|documentation|sources)|context|documentation|documents|sources)";
const KB_SUBJECT_IT = "(knowledge base|kb|base di conoscenza|documentazione|contesto|documenti|fonti)( (fornit[ai]|fornit[ei]|disponibil[ei]|a disposizione))?";

/**
 * Phrases the system prompt asks the model to use when the KB does not cover a question (EN + IT).
 * The subject must be the knowledge base / context: "the ADR does not mention gRPC" inside an otherwise
 * complete answer is a caveat, not an abstention.
 */
export const ABSTAIN_PATTERNS: RegExp[] = [
  new RegExp(`\\bthe ${KB_SUBJECT_EN} (does not|doesn't|do not|don't|did not|didn't) (cover|contain|include|mention|address|provide|have|describe)`, "i"),
  new RegExp(`\\b(not|isn't|is not|aren't|are not) (covered|documented|available|found|mentioned|present|addressed|described) (in|by) the ${KB_SUBJECT_EN}`, "i"),
  /\bthere is (no|not enough|insufficient) (information|documentation|detail)s? (in|about|on)\b/i,
  /\b(no|not enough|insufficient) (information|details|documentation) (is |was |are |were )?(available|found|provided) (in|about|on)\b/i,
  /could not find anything relevant/i,
  /\b(outside|beyond) the scope of the (knowledge base|documentation|context)/i,
  new RegExp(`\\b(la|le|il|i|nella|nei) ${KB_SUBJECT_IT} non (copre|coprono|contiene|contengono|include|includono|menziona|menzionano|tratta|trattano|fornisce|forniscono|riporta|riportano|descrive|descrivono)`, "i"),
  new RegExp(`\\bnon (è|sono|viene|vengono) (coperto|coperta|coperti|coperte|trattato|trattata|trattati|trattate|documentato|documentata|documentati|documentate|presente|presenti|disponibile|disponibili|menzionato|menzionata) (nella|nel|nei|nelle|dalla|dal|dai|dalle) ${KB_SUBJECT_IT}`, "i"),
  /\bnessuna informazione\b/i,
  /\bnon (ho|abbiamo) trovato\b/i,
  /\bnon (sono|ci sono) (informazioni|dettagli|riferimenti) (su|riguardo|in merito|sul|sulla|sui)\b/i,
];

export function looksLikeAbstention(answer: string): boolean {
  const head = answer.slice(0, 600);
  return ABSTAIN_PATTERNS.some((re) => re.test(head));
}

/** True when at least one citation the model actually used points at an expected document. */
export function citationHit(usedCitationSourceIds: string[], expected: string[]): boolean {
  return usedCitationSourceIds.some((id) => expected.includes(id));
}

/* ------------------------------------------------------------------ */
/* LLM judge                                                            */
/* ------------------------------------------------------------------ */

export interface JudgeVerdict {
  /** 0 = wrong/missing, 1 = partially correct, 2 = correct and complete w.r.t. the gold answer. */
  correctness: 0 | 1 | 2;
  /** 0 = claims not supported by the context, 1 = partially, 2 = fully grounded. */
  grounded: 0 | 1 | 2;
  /** The answer says the knowledge base does not cover the question. */
  abstained: boolean;
  rationale: string;
}

export function buildJudgePrompt(c: EvalCase, answer: string, context: string): string {
  const gold = c.should_abstain
    ? "(The knowledge base does NOT cover this question. The ideal answer says so and does not invent anything.)"
    : (c.expected_answer ?? `(no gold answer; the answer must mention: ${c.expected_keywords.join(", ")})`);
  return [
    "You are grading an answer produced by an internal documentation assistant.",
    "Compare the CANDIDATE ANSWER with the GOLD ANSWER and check that its claims are supported by the CONTEXT.",
    "Ignore style and length. Judge only facts. Output ONLY a JSON object with these keys:",
    '{"correctness": 0|1|2, "grounded": 0|1|2, "abstained": true|false, "rationale": "<one sentence>"}',
    "correctness: 2 = same facts as gold (extra correct detail is fine), 1 = partially right or incomplete, 0 = wrong, missing or contradicts gold.",
    "grounded: 2 = every claim appears in the context, 1 = some claims unsupported, 0 = mostly unsupported or hallucinated.",
    "abstained: true if the candidate says the knowledge base / context does not cover the question.",
    "",
    `QUESTION:\n${c.question}`,
    "",
    `GOLD ANSWER:\n${gold}`,
    "",
    `CANDIDATE ANSWER:\n${answer.slice(0, 4000)}`,
    "",
    `CONTEXT (excerpts the candidate could cite):\n${context.slice(0, 6000)}`,
  ].join("\n");
}

function clamp012(v: unknown): 0 | 1 | 2 {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(2, Math.round(n))) as 0 | 1 | 2;
}

/** Tolerant parser: finds the first {...} block in the model output, even inside ```json fences or after thinking. */
export function parseJudgeVerdict(text: string): JudgeVerdict | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  // Try progressively longer candidates ending at each "}" so trailing prose does not break parsing.
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
          return {
            correctness: clamp012(obj["correctness"]),
            grounded: clamp012(obj["grounded"]),
            abstained: obj["abstained"] === true || obj["abstained"] === "true",
            rationale: typeof obj["rationale"] === "string" ? obj["rationale"] : "",
          };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Per-case result and aggregation                                     */
/* ------------------------------------------------------------------ */

export interface AnswerResult {
  text: string;
  missingKeywords: string[];
  keywordPass: boolean;
  abstained: boolean;
  citationHit: boolean;
  usedSourceIds: string[];
  judge?: JudgeVerdict;
  timings: Record<string, number>;
}

export interface CaseResult {
  id: string;
  question: string;
  lang: string;
  category: string;
  difficulty: string;
  source_type: string;
  should_abstain: boolean;
  expected_source_ids: string[];
  retrieval: RetrievalOutcome;
  retrieveMs: number;
  answer?: AnswerResult;
  /** End-to-end verdict, see `casePassed`. */
  pass: boolean;
  error?: string;
}

/**
 * What "pass" means:
 *  - negative case, answers on:   the model abstained (heuristic or judge).
 *  - negative case, answers off:  n/a → counted as pass so it does not drag retrieval-only runs down.
 *  - answerable, answers off:     expected doc in top-k.
 *  - answerable, answers on:      keywords present, not abstained, and (if judged) correctness ≥ 1.
 */
export function casePassed(c: EvalCase, retrieval: RetrievalOutcome, answer?: AnswerResult): boolean {
  if (c.should_abstain) return answer ? answer.abstained || answer.judge?.abstained === true : true;
  if (!answer) return retrieval.rank !== null;
  const judgeOk = answer.judge ? answer.judge.correctness >= 1 : true;
  return answer.keywordPass && !answer.abstained && judgeOk;
}

export function mean(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] as number;
}

export interface GroupSummary {
  n: number;
  /** Answerable cases only. */
  answerable: number;
  hitAtK: number;
  mrr: number;
  recall: number;
  /** Answer-level (only when answers were generated). */
  keywordPass: number | null;
  citationHit: number | null;
  /** Answerable cases that wrongly abstained. */
  falseAbstain: number | null;
  /** Negative cases that correctly abstained. */
  abstainPass: number | null;
  judgeCorrectness: number | null;
  judgeGrounded: number | null;
  judgeStrictCorrect: number | null;
  pass: number;
  retrieveMsP50: number;
  totalMsP50: number | null;
}

export function summarize(results: CaseResult[]): GroupSummary {
  const answerable = results.filter((r) => !r.should_abstain);
  const negatives = results.filter((r) => r.should_abstain);
  const answered = results.filter((r) => r.answer);
  const answeredAnswerable = answerable.filter((r) => r.answer);
  const judged = answeredAnswerable.filter((r) => r.answer?.judge);
  const ratio = (xs: CaseResult[], f: (r: CaseResult) => boolean) => (xs.length ? xs.filter(f).length / xs.length : null);

  return {
    n: results.length,
    answerable: answerable.length,
    hitAtK: answerable.length ? answerable.filter((r) => r.retrieval.rank !== null).length / answerable.length : 0,
    mrr: mean(answerable.map((r) => (r.retrieval.rank ? 1 / r.retrieval.rank : 0))),
    recall: mean(answerable.map((r) => r.retrieval.recall)),
    keywordPass: ratio(answeredAnswerable, (r) => r.answer?.keywordPass === true),
    citationHit: ratio(answeredAnswerable, (r) => r.answer?.citationHit === true),
    falseAbstain: ratio(answeredAnswerable, (r) => r.answer?.abstained === true),
    abstainPass: negatives.some((r) => r.answer) ? ratio(negatives.filter((r) => r.answer), (r) => r.pass) : null,
    judgeCorrectness: judged.length ? mean(judged.map((r) => (r.answer?.judge?.correctness ?? 0) / 2)) : null,
    judgeGrounded: judged.length ? mean(judged.map((r) => (r.answer?.judge?.grounded ?? 0) / 2)) : null,
    judgeStrictCorrect: ratio(judged, (r) => r.answer?.judge?.correctness === 2),
    pass: results.length ? results.filter((r) => r.pass).length / results.length : 0,
    retrieveMsP50: percentile(results.map((r) => r.retrieveMs), 50),
    totalMsP50: answered.length ? percentile(answered.map((r) => r.answer?.timings["totalMs"] ?? 0), 50) : null,
  };
}

export function groupBy(results: CaseResult[], key: keyof CaseResult): Record<string, GroupSummary> {
  const groups = new Map<string, CaseResult[]>();
  for (const r of results) {
    const k = String(r[key]);
    if (!groups.has(k)) groups.set(k, []);
    (groups.get(k) as CaseResult[]).push(r);
  }
  const out: Record<string, GroupSummary> = {};
  for (const [k, rs] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) out[k] = summarize(rs);
  return out;
}

export function pct(v: number | null): string {
  return v === null ? "  n/a" : `${(v * 100).toFixed(0).padStart(4)}%`;
}
