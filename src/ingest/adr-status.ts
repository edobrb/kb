/**
 * What an architecture decision record says about itself: "Status: Accepted", "### Stato\n\nDeprecato",
 * "| Status | Proposed |".
 *
 * Sync marks documents `binding` by where they live (sources.yaml rules: the adrs repository, `adr*`
 * folders, titles with "ADR<n>"), which made deprecated ADRs, proposals, empty templates, ADR index pages
 * and task checklists that happen to sit in an `adr/` folder rank and filter as binding rules. Ingest
 * reads the status instead and keeps `binding` only for decisions in force.
 */

export type AdrStatus = "accepted" | "proposed" | "deprecated" | "superseded" | "rejected" | "template";

export interface AdrStatusInfo {
  status: AdrStatus;
  /** The status as the document words it, for display ("Outdated — as of 2022-06-28"). */
  raw: string;
}

const clean = (s: string): string =>
  s
    .replace(/[*_`>#|]/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();

function classify(raw: string): AdrStatus | null {
  const s = raw.toLowerCase();
  if (!s) return null;
  if (/^[[{<]|proposed\s*[|/,]\s*accepted|accepted\s*[|/,]\s*(?:rejected|deprecated|superseded)|\bstatus here\b|such as|e\.g\.|ad esempio|what is the status|one of\b|^\.\.\.|^tbd$/.test(s)) return "template";
  if (/supersed|sostituit|replaced by|superat|rimpiazzat/.test(s)) return "superseded";
  if (/deprecat|obsolet|outdated|no longer|non più|retired|withdrawn|ritirat|dismess|archiviat/.test(s)) return "deprecated";
  if (/reject|rifiutat|respint|declined/.test(s)) return "rejected";
  if (/propos|draft|bozza|in review|under review|in revisione|in discussione|\brfc\b|\bwip\b|pending|in attesa/.test(s)) return "proposed";
  if (/accept|approv|accettat|adopt|adottat|in force|in vigore|\bactive\b|attiv|decided|decis|implemented|implementat|final/.test(s)) return "accepted";
  return null;
}

/** The status line of an ADR body (and of its frontmatter `status`), or null when it states none. */
export function adrStatus(body: string, frontmatterStatus?: unknown): AdrStatusInfo | null {
  const candidates: string[] = [];
  if (typeof frontmatterStatus === "string") candidates.push(frontmatterStatus);
  // "## Status" / "### Stato" / "## 1. Status", then its first non-empty line
  const heading = /^#{1,6}\s*(?:\d+[.)]?\s*)?(?:status|stato)\b[^\n]*\n+((?:[ \t]*\n)*)([^\n]+)/im.exec(body);
  if (heading?.[2]) candidates.push(heading[2]);
  // "Status: Accepted", "**Stato:** Approvato", "- Status — Proposed", "| Status | Accepted |"
  const inline = /^[ \t]*(?:[-*][ \t]+)?\|?[ \t]*(?:\*\*|__)?(?:status|stato)(?:\*\*|__)?[ \t]*(?:[:：|—–-][ \t]*)+(?:\*\*|__)?([^\n|]+)/im.exec(body);
  if (inline?.[1]) candidates.push(inline[1]);
  for (const c of candidates) {
    const raw = clean(c).slice(0, 120);
    const status = classify(raw);
    if (status) return { status, raw };
  }
  return null;
}

/** Whether a body reads like a decision record at all: a status, or a Decision / Context section. */
export function looksLikeAdr(body: string): boolean {
  return /^#{1,6}\s*(?:\d+[.)]?\s*)?(?:decision|decisione|context|contesto|status|stato)\b/im.test(body);
}

/**
 * The authority a `binding` document really has: binding while in force (or when it states no status but
 * reads like a decision), descriptive when deprecated, superseded, rejected, only proposed, a blank
 * template, or not a decision record at all.
 */
export function effectiveAuthority<A extends string>(authority: A, body: string, frontmatterStatus?: unknown): A | "descriptive" {
  if (authority !== "binding") return authority;
  const info = adrStatus(body, frontmatterStatus);
  if (info) return info.status === "accepted" ? authority : "descriptive";
  return looksLikeAdr(body) ? authority : "descriptive";
}
