import { readFile } from "node:fs/promises";

/**
 * Benchmark dataset: one JSON object per line in evals/questions.jsonl.
 *
 * Two kinds of cases:
 *  - answerable: `expected_source_ids` = doc(s) that answer it; `expected_keywords` must appear in the answer;
 *    `expected_answer` is a short gold answer used by the optional LLM judge.
 *  - negative (should_abstain: true): the KB does NOT cover it; the system must say so instead of inventing.
 *
 * Legacy lines ({question, expected_source_ids, expected_keywords}) are accepted and normalised.
 */

export const CATEGORIES = [
  "factual",
  "definition",
  "procedural",
  "numeric",
  "comparison",
  "yes-no",
  "multi-hop",
  "list",
  "negative",
] as const;
export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export const LANGS = ["en", "it", "und"] as const;

export interface EvalCase {
  id: string;
  question: string;
  lang: string;
  category: string;
  difficulty: string;
  /** Top-level kb folder of the expected doc(s); "none" for negatives. */
  source_type: string;
  expected_source_ids: string[];
  expected_keywords: string[];
  expected_answer?: string;
  should_abstain: boolean;
  notes?: string;
}

const IT_HINT = /\b(quali|quale|come|cosa|perch[eé]|dove|quando|sono|della|delle|degli|nel|nella|posso|deve|devono|possibile|funziona|utilizzare|usare)\b/i;

/** Cheap language guess for legacy lines without `lang`. */
export function guessLang(text: string): string {
  return IT_HINT.test(text) ? "it" : "en";
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

export function normalizeCase(raw: Record<string, unknown>, index: number): EvalCase {
  const question = str(raw["question"]);
  if (!question) throw new Error(`line ${index + 1}: missing "question"`);
  const expected_source_ids = strArray(raw["expected_source_ids"]);
  const should_abstain = raw["should_abstain"] === true || raw["category"] === "negative";
  const sourceTypeFromId = expected_source_ids[0]?.split(":")[0];
  return {
    id: str(raw["id"]) ?? `q-${String(index + 1).padStart(3, "0")}`,
    question,
    lang: str(raw["lang"]) ?? guessLang(question),
    category: str(raw["category"]) ?? (should_abstain ? "negative" : "factual"),
    difficulty: str(raw["difficulty"]) ?? "medium",
    source_type: str(raw["source_type"]) ?? (should_abstain ? "none" : (sourceTypeFromId ?? "unknown")),
    expected_source_ids,
    expected_keywords: strArray(raw["expected_keywords"]),
    expected_answer: str(raw["expected_answer"]),
    should_abstain,
    notes: str(raw["notes"]),
  };
}

export function parseJsonl(text: string): EvalCase[] {
  const out: EvalCase[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith("#") || t.startsWith("//")) return;
    let obj: unknown;
    try {
      obj = JSON.parse(t);
    } catch (e) {
      throw new Error(`line ${i + 1}: invalid JSON (${(e as Error).message})`);
    }
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error(`line ${i + 1}: not a JSON object`);
    out.push(normalizeCase(obj as Record<string, unknown>, i));
  });
  return out;
}

export async function loadCases(file: string): Promise<EvalCase[]> {
  return parseJsonl(await readFile(file, "utf8"));
}

/** `--filter category=numeric,lang=it,id=adr-` → {category:"numeric", lang:"it", id:"adr-"} */
export function parseFilterSpec(spec: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!spec) return out;
  for (const part of spec.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/** Exact match on any field except `id`, which matches by prefix. Multiple values with "|" (a|b). */
export function filterCases(cases: EvalCase[], filters: Record<string, string>): EvalCase[] {
  const entries = Object.entries(filters);
  if (!entries.length) return cases;
  return cases.filter((c) =>
    entries.every(([key, value]) => {
      const alternatives = value.split("|").map((v) => v.trim());
      const actual = (c as unknown as Record<string, unknown>)[key];
      if (key === "id") return alternatives.some((a) => c.id.startsWith(a));
      if (typeof actual === "boolean") return alternatives.includes(String(actual));
      return typeof actual === "string" && alternatives.includes(actual);
    }),
  );
}
