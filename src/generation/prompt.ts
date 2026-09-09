import type { ChatMessage, Citation, RetrievedChunk } from "../types.js";

export const SYSTEM_PROMPT = `You are the internal knowledge assistant for TeamSystem OnePlatform. Your knowledge base contains the Developer Portal documentation (TechDocs pages, API definitions), the OnePlatform GitLab repositories (README and docs, project cards, and the SOURCE CODE itself) and a few hand-written references (glossary, manifesto, ADRs).

Rules:
- Answer ONLY from the CONTEXT blocks below. Do not use outside knowledge about TeamSystem.
- If the context does not contain the answer, say so plainly (e.g. "The knowledge base does not cover this") and, if useful, say which related topics the context does cover. Never invent names, dates, endpoints, values, code or policies.
- Cite your sources: after each sentence or bullet that relies on a context block, add its number like [1] or [2][4]. Only cite blocks you actually used.
- Prefer blocks marked authority=binding or normative (ADRs, standards) when they conflict with descriptive pages, and mention the conflict.
- When the answer comes from source code (kind=code), name the repository and file path, quote the relevant lines in a code block, and describe what the code does rather than paraphrasing it loosely. Distinguish what the code does from what the documentation says when they differ.
- Reply in the same language as the user's question (Italian or English). Keep the same terminology used in the documents.
- Be concise and concrete: use short paragraphs, code blocks for code/config, and tables only when the context has tabular data.`;

/** GitLab blob URL with a line anchor for code chunks; other URLs unchanged. */
export function deepLink(c: Pick<RetrievedChunk, "sourceUrl" | "kind" | "lineStart" | "lineEnd">): string | null {
  if (!c.sourceUrl) return null;
  if (c.kind === "code" && c.lineStart && /\/-\/blob\//.test(c.sourceUrl)) {
    return `${c.sourceUrl}#L${c.lineStart}${c.lineEnd && c.lineEnd > c.lineStart ? `-${c.lineEnd}` : ""}`;
  }
  return c.sourceUrl;
}

/** Turn retrieved chunks into numbered citations (deterministic order = ranking order). */
export function toCitations(chunks: RetrievedChunk[]): Citation[] {
  return chunks.map((c, i) => ({
    n: i + 1,
    chunkId: c.id,
    sourceId: c.sourceId,
    title: c.title,
    sourceUrl: deepLink(c),
    sourceType: c.sourceType,
    kind: c.kind,
    authority: c.authority,
    headingPath: c.headingPath,
    relPath: c.relPath,
    excerpt: c.content.length > 600 ? `${c.content.slice(0, 600)}…` : c.content,
    lineStart: c.lineStart,
    lineEnd: c.lineEnd,
    score: c.score,
  }));
}

export function formatContext(chunks: RetrievedChunk[]): string {
  return chunks
    .map((c, i) => {
      const url = deepLink(c);
      const header = [
        `[${i + 1}] ${c.headingPath}${c.kind === "code" && c.lineStart ? ` (lines ${c.lineStart}-${c.lineEnd})` : ""}`,
        `source_type=${c.sourceType} kind=${c.kind} authority=${c.authority}${url ? ` url=${url}` : ""}`,
      ].join("\n");
      return `${header}\n${c.content}`;
    })
    .join("\n\n-----\n\n");
}

/**
 * Build the chat transcript sent to the model. Retrieved context goes into the system prompt;
 * prior turns are kept (trimmed) so follow-up questions work.
 */
export function buildMessages(history: ChatMessage[], question: string, chunks: RetrievedChunk[], maxHistory = 6): ChatMessage[] {
  const system: ChatMessage = {
    role: "system",
    content: `${SYSTEM_PROMPT}\n\nCONTEXT:\n\n${formatContext(chunks)}`,
  };
  const prior = history.filter((m) => m.role !== "system").slice(-maxHistory);
  return [...[system], ...prior, { role: "user", content: question }];
}

/** Extract the [n] citation numbers the model actually used, in first-use order. */
export function extractCitedNumbers(answer: string, max: number): number[] {
  const seen = new Set<number>();
  for (const m of answer.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(m[1]);
    if (n >= 1 && n <= max) seen.add(n);
  }
  return [...seen];
}
