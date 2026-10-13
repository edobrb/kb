import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { config, paths } from "../config.js";

/**
 * Feedback: what agents leave behind for the people who maintain the knowledge base.
 *
 * Two append-only JSONL files, neither of them indexed:
 *  - events.jsonl   every MCP tool call: what was asked, what came back. Nobody has to write these:
 *                   they are the signals agents give off anyway — a search that found nothing, the
 *                   same question reworded three times in one session.
 *  - reports.jsonl  the notes an agent chose to file with the MCP `report` tool: a document that is
 *                   wrong or outdated, something the knowledge base should cover and does not, a way
 *                   of finding things that is not obvious.
 *
 * Nothing here feeds retrieval. An agent's conclusion is unverified, and a note returned as a search
 * result would be cited with the confidence of an ADR; so a person reviews the reports and decides
 * what, if anything, goes into which document. Each report is pinned to the hashes of the documents
 * it was based on, so that review can tell when a page has changed since.
 */

/**
 * correction / gap / tip are about the documents. `security`: a page publishes a credential or personal
 * data, reviewed first. `indexing`: the knowledge base's own copy is wrong (cut, garbled, mislabelled, a
 * linked page missing) while the source may be fine, so the fix is in sync or ingest, not upstream.
 */
export type ReportKind = "correction" | "gap" | "tip" | "security" | "indexing";
export const REPORT_KINDS: readonly ReportKind[] = ["correction", "gap", "tip", "security", "indexing"];

/** A document a report was based on, pinned to the version that was indexed when it was filed. */
export interface ReportSource {
  source_id: string;
  /** Manifest hashes (see DocMeta); null when the manifest does not carry them. */
  content_hash: string | null;
  embed_hash: string | null;
  /**
   * Hash of the kb file when it differs from the indexed one: sync wrote a newer version that ingest has
   * not picked up, so search showed the old text and fetch_document the new. Absent when they agree.
   */
  kb_hash?: string;
}

/** One line of reports.jsonl. */
export interface AgentReport {
  id: string;
  ts: string;
  /** Review state: "new" until a person has looked at it. */
  status: "new";
  kind: ReportKind;
  note: string;
  /** The question or task the agent was working on. */
  question: string;
  /** How the agent knows: a test it ran, the code, an error message, a source outside the kb. */
  evidence: string | null;
  sources: ReportSource[];
  /** The one document that should change, when the agent named it (one of `sources`). */
  target?: string | null;
  /** Heading of the target the note is about. */
  section?: string | null;
  /** The exact words in the target that are wrong or outdated. */
  quote?: string | null;
  /** What the target should say instead, or what to add, as the agent would write it. */
  fix?: string | null;
  /** True when the documents disagree and only the owning team can say which one is right. */
  owner_decision?: boolean;
  /** As the agent declared it: MCP does not tell a server which model is calling. */
  model: string;
  /** The MCP server process that took the call; its tool calls are in events.jsonl under the same id. */
  session: string | null;
  /** The MCP client, "name/version" as it introduced itself. */
  client: string | null;
}

/** One line of events.jsonl. `event` is the MCP tool name. */
export interface FeedbackEvent {
  ts: string;
  event: string;
  [field: string]: unknown;
}

/**
 * Append one record as one line. Every MCP client session runs its own server process, all writing
 * the same files; one O_APPEND write per record keeps their lines whole.
 */
export async function appendJsonl(file: string, record: object): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}

/** Every report filed so far, oldest first; a line that does not parse is skipped. */
export async function readReports(file: string): Promise<AgentReport[]> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  const out: AgentReport[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as AgentReport);
    } catch {
      // a partial line from a crashed writer
    }
  }
  return out;
}

/** Log an event when FEEDBACK_EVENTS is on. Never throws: a lost log line must not fail the call it describes. */
export async function logEvent(event: FeedbackEvent, file = paths.feedbackEvents): Promise<void> {
  if (!config.feedback.events) return;
  try {
    await appendJsonl(file, event);
  } catch (err) {
    process.stderr.write(`ai-wiki feedback: cannot write ${file}: ${(err as Error).message}\n`);
  }
}
