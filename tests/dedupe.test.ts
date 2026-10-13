import { describe, expect, it } from "vitest";
import { dropNearDuplicates } from "../src/retrieval/retriever.js";
import type { RetrievedChunk } from "../src/types.js";

const README =
  "The onboarding orchestrator provisions a workspace for every new customer, assigns the default licences, " +
  "registers the company in the item registry and publishes an onboarding completed event on Hermes so that " +
  "downstream products can start their own setup without polling the orchestrator.";

const chunk = (sourceId: string, content: string, score: number): RetrievedChunk => ({
  id: `${sourceId}#0`,
  sourceId,
  sourceType: "gitlab",
  kind: "doc",
  title: sourceId,
  sourceUrl: null,
  authority: "descriptive",
  lang: "en",
  relPath: `${sourceId}.md`,
  ordinal: 0,
  headingPath: sourceId,
  content,
  lineStart: null,
  lineEnd: null,
  lastModified: null,
  score,
  vectorRank: 1,
  bm25Rank: 1,
});

describe("dropNearDuplicates", () => {
  it("keeps the better-ranked copy of the same text and names the other", () => {
    const out = dropNearDuplicates([
      chunk("gitlab:onboarding:README.md", README, 0.03),
      chunk("gitlab:onboarding:__project", `## README excerpt\n\n${README}\n\n## Languages\n\nTypeScript`, 0.029),
      chunk("devportal:default/component/other/", "A different page about metering consumption events and their idempotency keys, nothing alike.", 0.028),
    ]);
    expect(out.map((c) => c.sourceId)).toEqual(["gitlab:onboarding:README.md", "devportal:default/component/other/"]);
    expect(out[0]?.duplicates).toEqual(["gitlab:onboarding:__project"]);
  });

  it("leaves short passages and different chunks of one document alone", () => {
    const out = dropNearDuplicates([chunk("a", "Accepted.", 0.03), chunk("b", "Accepted.", 0.02), chunk("c", README, 0.01), { ...chunk("c", README, 0.009), id: "c#1" }]);
    expect(out).toHaveLength(4);
  });
});
