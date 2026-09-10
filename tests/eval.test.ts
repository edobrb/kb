import { describe, expect, it } from "vitest";
import { filterCases, normalizeCase, parseJsonl } from "../src/eval/dataset.js";
import {
  casePassed,
  looksLikeAbstention,
  missingKeywords,
  parseJudgeVerdict,
  scoreRetrieval,
  summarize,
  type CaseResult,
} from "../src/eval/metrics.js";

describe("eval dataset", () => {
  it("normalises legacy lines and skips comments", () => {
    const cases = parseJsonl(
      [
        "# comment",
        '{"question": "Quali sono i principi del manifesto?", "expected_source_ids": ["manually-curated:x"], "expected_keywords": ["Platform"]}',
        "",
        '{"id":"neg-001","question":"What is the vacation policy?","category":"negative"}',
      ].join("\n"),
    );
    expect(cases).toHaveLength(2);
    expect(cases[0]).toMatchObject({ id: "q-002", lang: "it", category: "factual", source_type: "manually-curated", should_abstain: false });
    expect(cases[1]).toMatchObject({ id: "neg-001", should_abstain: true, source_type: "none", expected_source_ids: [] });
  });

  it("rejects lines without a question or with bad JSON", () => {
    expect(() => parseJsonl('{"expected_source_ids": []}')).toThrow(/missing "question"/);
    expect(() => parseJsonl("{not json")).toThrow(/invalid JSON/);
  });

  it("filters by exact field, id prefix and alternatives", () => {
    const cases = [
      normalizeCase({ id: "adr-001", question: "q1", lang: "en", category: "numeric" }, 0),
      normalizeCase({ id: "cfl-a-001", question: "q2", lang: "it", category: "factual" }, 1),
      normalizeCase({ id: "cfl-b-001", question: "q3", lang: "it", category: "list" }, 2),
    ];
    expect(filterCases(cases, { lang: "it" }).map((c) => c.id)).toEqual(["cfl-a-001", "cfl-b-001"]);
    expect(filterCases(cases, { id: "adr-" }).map((c) => c.id)).toEqual(["adr-001"]);
    expect(filterCases(cases, { category: "numeric|list" }).map((c) => c.id)).toEqual(["adr-001", "cfl-b-001"]);
    expect(filterCases(cases, { should_abstain: "false", lang: "en" })).toHaveLength(1);
  });
});

describe("eval metrics", () => {
  it("scores retrieval at document level with rank and recall", () => {
    const r = scoreRetrieval(["a", "a", "b", "c", "b"], ["b", "z"]);
    expect(r.rank).toBe(2);
    expect(r.recall).toBe(0.5);
    expect(r.retrievedDocs).toEqual(["a", "b", "c"]);
    expect(scoreRetrieval(["a"], ["b"]).rank).toBeNull();
  });

  it("matches keywords ignoring case and whitespace", () => {
    expect(missingKeywords("Use RFC   9457 with application/problem+json.", ["rfc 9457", "Application/Problem+JSON", "W3C"])).toEqual(["W3C"]);
  });

  it("detects abstentions in English and Italian, but not normal answers", () => {
    expect(looksLikeAbstention("The knowledge base does not cover this topic. Related topics: …")).toBe(true);
    expect(looksLikeAbstention("Non ho trovato informazioni su questo argomento nella documentazione.")).toBe(true);
    expect(looksLikeAbstention("La knowledge base non copre le politiche ferie.")).toBe(true);
    expect(looksLikeAbstention("Errors must use RFC 9457 problem details [1]. The ADR does not mention gRPC.")).toBe(false);
  });

  it("parses judge verdicts from noisy output", () => {
    const v = parseJudgeVerdict('Sure.\n```json\n{"correctness": 2, "grounded": "1", "abstained": false, "rationale": "ok"}\n```\nDone.');
    expect(v).toEqual({ correctness: 2, grounded: 1, abstained: false, rationale: "ok" });
    expect(parseJudgeVerdict("no json here")).toBeNull();
    expect(parseJudgeVerdict('{"correctness": 7}')?.correctness).toBe(2);
  });

  it("defines pass per mode and case type", () => {
    const answerable = normalizeCase({ question: "q", expected_source_ids: ["a"], expected_keywords: ["x"] }, 0);
    const negative = normalizeCase({ question: "q", should_abstain: true }, 1);
    const hit = scoreRetrieval(["a"], ["a"]);
    const miss = scoreRetrieval(["b"], ["a"]);
    const ans = (o: Partial<CaseResult["answer"] & object>) =>
      ({ text: "", missingKeywords: [], keywordPass: true, abstained: false, citationHit: true, usedSourceIds: [], timings: {}, ...o }) as NonNullable<CaseResult["answer"]>;

    expect(casePassed(answerable, hit)).toBe(true);
    expect(casePassed(answerable, miss)).toBe(false);
    expect(casePassed(answerable, hit, ans({}))).toBe(true);
    expect(casePassed(answerable, hit, ans({ keywordPass: false }))).toBe(false);
    expect(casePassed(answerable, hit, ans({ abstained: true }))).toBe(false);
    expect(casePassed(answerable, hit, ans({ judge: { correctness: 0, grounded: 2, abstained: false, rationale: "" } }))).toBe(false);
    expect(casePassed(negative, miss)).toBe(true);
    expect(casePassed(negative, miss, ans({ abstained: true }))).toBe(true);
    expect(casePassed(negative, miss, ans({ abstained: false }))).toBe(false);
  });

  it("summarises groups, excluding negatives from retrieval metrics", () => {
    const base = { question: "q", lang: "en", category: "factual", difficulty: "easy", source_type: "adr", retrieveMs: 10 };
    const results: CaseResult[] = [
      { ...base, id: "1", should_abstain: false, expected_source_ids: ["a"], retrieval: scoreRetrieval(["a"], ["a"]), pass: true },
      { ...base, id: "2", should_abstain: false, expected_source_ids: ["a"], retrieval: scoreRetrieval(["x", "a"], ["a"]), pass: true },
      { ...base, id: "3", should_abstain: false, expected_source_ids: ["a"], retrieval: scoreRetrieval(["x"], ["a"]), pass: false },
      { ...base, id: "4", should_abstain: true, expected_source_ids: [], retrieval: scoreRetrieval(["x"], []), pass: true },
    ];
    const s = summarize(results);
    expect(s.n).toBe(4);
    expect(s.answerable).toBe(3);
    expect(s.hitAtK).toBeCloseTo(2 / 3);
    expect(s.mrr).toBeCloseTo((1 + 0.5 + 0) / 3);
    expect(s.keywordPass).toBeNull();
    expect(s.pass).toBe(0.75);
  });
});

describe("looksLikeAbstention", () => {
  it("recognises the refusals the model actually writes, in both languages", () => {
    for (const s of [
      "The knowledge base does not cover this.",
      "Based on the CONTEXT blocks provided, I cannot find any information about a Salesforce connector.",
      "Based on the CONTEXT provided, there is no mention of an official Flutter SDK.",
      "I don't find a Zendesk integration for the ticket routing service in the provided context.",
      "La knowledge base non copre questo aspetto.",
      "Non trovo alcun riferimento a questo servizio nel contesto.",
      "Non posso rispondere a questa domanda con i contenuti della knowledge base.",
      "Non riesco a rispondere a questa domanda con il materiale disponibile.",
      "I cannot answer this question with the documents I have.",
    ]) {
      expect(looksLikeAbstention(s), s).toBe(true);
    }
  });

  it("does not read a caveat inside a real answer as an abstention", () => {
    expect(
      looksLikeAbstention(
        "Platform APIs must use RFC 9457 problem+json [1]. The ADR does not mention gRPC, so only HTTP is covered.",
      ),
    ).toBe(false);
    expect(looksLikeAbstention("The retention period is 12 months [3].")).toBe(false);
  });
});
