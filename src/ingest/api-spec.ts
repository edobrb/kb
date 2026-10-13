import YAML from "yaml";
import { detectLang } from "../sync/lang.js";

/**
 * API definitions (`kind: api`) arrive as sync writes them: a short preamble and the whole OpenAPI or
 * AsyncAPI document in one fenced block — often a single line of minified JSON. Taken as is, the chunker
 * cuts that line into character windows that carry no path or method, fetch_document finds no heading to
 * offer as an outline (so `section` cannot reach an operation), and a definition cut at sync
 * (`# … truncated (N chars)`) reads as a complete one.
 *
 * `renderApiSpec` parses the document — repairing JSON that was cut mid-way — and rewrites the body as
 * markdown with one section per operation and one per component, each holding that part of the definition
 * as YAML. Nothing is dropped: the top-level fields go under "Overview", everything else under the section
 * it belongs to, in the original order. A definition that does not parse, or is neither OpenAPI/Swagger nor
 * AsyncAPI, is returned unchanged (null).
 */

export interface RenderedSpec {
  body: string;
  /** Set when sync kept only the first `kept` of `total` characters. */
  truncated: { kept: number; total: number } | null;
  operations: number;
  components: number;
  /** Language of the summaries and descriptions ("it", "en" or "und"). */
  lang: "it" | "en" | "und";
}

/** Marker sync appends to a definition it cut (src/sync/devportal.ts). */
const TRUNCATION_RE = /^# … truncated \((\d+) chars\)\s*$/;
/** The first line of the notice the rendered body carries, so fetch_document can say so in its header. */
export const CUT_NOTICE = "> **Cut at sync:**";

const HTTP_METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Parse JSON that may stop in the middle: cut back to the last complete member and close what is still
 * open. Returns null when even that fails.
 */
export function parseTruncatedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // fall through to the repair
  }
  const closers: string[] = [];
  // Cut points: just before a comma between members, or just after a container closes, with the closers
  // still needed there. Only the last few hundred are kept; the repair tries them from the end.
  const cuts: { at: number; close: string }[] = [];
  const remember = (at: number) => {
    cuts.push({ at, close: [...closers].reverse().join("") });
    if (cuts.length > 400) cuts.shift();
  };
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") closers.push("}");
    else if (c === "[") closers.push("]");
    else if (c === "}" || c === "]") {
      closers.pop();
      remember(i + 1);
    } else if (c === ",") remember(i);
  }
  for (let k = cuts.length - 1; k >= 0; k--) {
    const { at, close } = cuts[k] as { at: number; close: string };
    try {
      return JSON.parse(text.slice(0, at) + close);
    } catch {
      // try an earlier cut
    }
  }
  return null;
}

function parseDefinition(source: string, cut: boolean): unknown {
  const text = source.trim();
  if (!text) return null;
  if (text.startsWith("{") || text.startsWith("[")) return cut ? parseTruncatedJson(text) : safe(() => JSON.parse(text));
  const lines = text.split("\n");
  // A YAML document cut at sync usually parses once the last, partial lines are dropped.
  for (let drop = 0; drop <= (cut ? 6 : 0); drop++) {
    const parsed = safe(() => YAML.parse(lines.slice(0, lines.length - drop).join("\n"), { maxAliasCount: 1000 }));
    if (isObject(parsed)) return parsed;
  }
  return null;
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

function yamlBlock(value: unknown): string {
  const text = YAML.stringify(value, { lineWidth: 0, aliasDuplicateObjects: false }).trimEnd();
  return `\`\`\`yaml\n${text}\n\`\`\``;
}

/** Summaries and descriptions, to tell the language of a definition its preamble does not reveal. */
function proseOf(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 12 || out.length > 400) return out;
  if (Array.isArray(value)) for (const v of value) proseOf(v, out, depth + 1);
  else if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if ((k === "summary" || k === "description" || k === "title") && typeof v === "string") out.push(v);
      else proseOf(v, out, depth + 1);
    }
  }
  return out;
}

/** One line under an operation heading: operationId, tags, deprecated — what a reader scans for. */
function operationFacts(op: Json): string {
  const facts: string[] = [];
  if (typeof op["operationId"] === "string") facts.push(`operationId \`${op["operationId"]}\``);
  if (Array.isArray(op["tags"]) && op["tags"].length) facts.push(`tags: ${op["tags"].join(", ")}`);
  if (op["deprecated"] === true) facts.push("**deprecated**");
  return facts.join(" · ");
}

const oneLine = (s: unknown): string => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");

function renderOpenApi(spec: Json, sections: string[]): { operations: number; components: number } {
  let operations = 0;
  const paths = isObject(spec["paths"]) ? spec["paths"] : {};
  if (Object.keys(paths).length) sections.push("## Operations");
  for (const [route, item] of Object.entries(paths)) {
    if (!isObject(item)) continue;
    const shared = Object.fromEntries(Object.entries(item).filter(([k]) => !HTTP_METHODS.includes(k)));
    const methods = Object.entries(item).filter(([k, v]) => HTTP_METHODS.includes(k) && isObject(v)) as [string, Json][];
    if (!methods.length) {
      sections.push(`### ${route}\n\n${yamlBlock(item)}`);
      continue;
    }
    methods.forEach(([method, op], i) => {
      operations++;
      const summary = oneLine(op["summary"]);
      const facts = operationFacts(op);
      const parts = [`### ${method.toUpperCase()} ${route}${summary ? ` — ${summary}` : ""}`];
      if (facts) parts.push(facts);
      if (i === 0 && Object.keys(shared).length) parts.push(`Shared by every method of \`${route}\`:\n\n${yamlBlock(shared)}`);
      parts.push(yamlBlock(op));
      sections.push(parts.join("\n\n"));
    });
  }

  let components = 0;
  // OpenAPI 3: components.<type>.<name>; Swagger 2: definitions / parameters / responses / securityDefinitions.
  const groups: [string, unknown][] = isObject(spec["components"])
    ? Object.entries(spec["components"])
    : (["definitions", "parameters", "responses", "securityDefinitions"] as const).map((k) => [k === "definitions" ? "schemas" : k, spec[k]]);
  for (const [type, entries] of groups) {
    if (!isObject(entries) || !Object.keys(entries).length) continue;
    sections.push(`## ${type === "schemas" ? "Schemas" : `Components: ${type}`}`);
    for (const [name, value] of Object.entries(entries)) {
      components++;
      sections.push(`### ${name}\n\n${yamlBlock(value)}`);
    }
  }
  return { operations, components };
}

function renderAsyncApi(spec: Json, sections: string[]): { operations: number; components: number } {
  let operations = 0;
  const channels = isObject(spec["channels"]) ? spec["channels"] : {};
  if (Object.keys(channels).length) sections.push("## Channels");
  for (const [name, item] of Object.entries(channels)) {
    const ops = isObject(item) ? ["publish", "subscribe"].filter((k) => k in item) : [];
    operations += Math.max(1, ops.length);
    const address = isObject(item) && typeof item["address"] === "string" ? ` (${item["address"]})` : "";
    sections.push(`### ${name}${address}${ops.length ? ` — ${ops.join(", ")}` : ""}\n\n${yamlBlock(item)}`);
  }
  if (isObject(spec["operations"]) && Object.keys(spec["operations"]).length) {
    sections.push("## Operations");
    for (const [name, op] of Object.entries(spec["operations"])) {
      operations++;
      const action = isObject(op) && typeof op["action"] === "string" ? ` — ${op["action"]}` : "";
      sections.push(`### ${name}${action}\n\n${yamlBlock(op)}`);
    }
  }
  let components = 0;
  if (isObject(spec["components"])) {
    for (const [type, entries] of Object.entries(spec["components"])) {
      if (!isObject(entries) || !Object.keys(entries).length) continue;
      sections.push(`## ${type === "schemas" ? "Schemas" : type === "messages" ? "Messages" : `Components: ${type}`}`);
      for (const [name, value] of Object.entries(entries)) {
        components++;
        sections.push(`### ${name}\n\n${yamlBlock(value)}`);
      }
    }
  }
  return { operations, components };
}

/** Top-level GraphQL SDL definitions: `type Query {`, `input AbiCabInput {`, `enum Status {`, `scalar Date`. */
const GRAPHQL_DEF_RE = /^(?:"""[\s\S]*?"""\s*\n)?(extend\s+)?(type|input|enum|interface|union|scalar|schema|directive)\b\s*@?(\w*)/;

/** A GraphQL schema: one section per definition, grouped by what it is (Query and Mutation first). */
function renderGraphql(source: string, sections: string[], truncated: RenderedSpec["truncated"]): RenderedSpec | null {
  const lines = source.split("\n");
  const starts: { line: number; kind: string; name: string }[] = [];
  lines.forEach((l, i) => {
    if (/^\s/.test(l)) return; // only top-level definitions start at column 0
    const m = GRAPHQL_DEF_RE.exec(l);
    if (m) starts.push({ line: i, kind: `${m[1] ? "extend " : ""}${m[2]}`, name: m[3] || (m[2] as string) });
  });
  if (starts.length < 2) return null;
  const groups = new Map<string, string[]>();
  const order = (name: string) => (name === "Query" ? 0 : name === "Mutation" ? 1 : name === "Subscription" ? 2 : 3);
  const defs = starts.map((s, k) => ({ ...s, text: lines.slice(s.line, starts[k + 1]?.line ?? lines.length).join("\n").trim() }));
  defs.sort((a, b) => order(a.name) - order(b.name));
  for (const d of defs) {
    const group = d.kind === "type" && order(d.name) < 3 ? "Root operations" : `${d.kind.replace(/^\w/, (c) => c.toUpperCase())} definitions`;
    const list = groups.get(group) ?? [];
    list.push(`### ${d.kind} ${d.name}\n\n\`\`\`graphql\n${d.text}\n\`\`\``);
    groups.set(group, list);
  }
  for (const [group, list] of groups) sections.push(`## ${group}`, ...list);
  const prose = [...source.matchAll(/"""([\s\S]*?)"""|"([^"\n]{12,})"/g)].map((m) => m[1] ?? m[2] ?? "").join("\n");
  const operations = defs.filter((d) => order(d.name) < 3).reduce((n, d) => n + (d.text.match(/^\s+\w+\s*[(:]/gm)?.length ?? 0), 0);
  return { body: sections.join("\n\n"), truncated, operations, components: defs.length, lang: detectLang(prose) };
}

const cache = new Map<string, RenderedSpec | null>();

/** Rewrite an API definition document as one section per operation and component (see above). */
export function renderApiSpec(body: string): RenderedSpec | null {
  const hit = cache.get(body);
  if (hit !== undefined) return hit;
  const result = render(body);
  cache.set(body, result);
  if (cache.size > 16) cache.delete(cache.keys().next().value as string);
  return result;
}

function render(body: string): RenderedSpec | null {
  const lines = body.split("\n");
  const open = lines.findIndex((l) => /^\s{0,3}(`{3,}|~{3,})/.test(l));
  if (open < 0) return null;
  const fence = (/^\s{0,3}(`{3,}|~{3,})/.exec(lines[open] as string)?.[1] ?? "```") as string;
  let close = -1;
  for (let i = lines.length - 1; i > open; i--) {
    if ((lines[i] as string).trim() === fence) {
      close = i;
      break;
    }
  }
  if (close < 0) return null;

  const inner = lines.slice(open + 1, close);
  let truncated: RenderedSpec["truncated"] = null;
  const marker = TRUNCATION_RE.exec((inner.at(-1) ?? "").trim());
  if (marker) {
    inner.pop();
    truncated = { kept: inner.join("\n").length, total: Number(marker[1]) };
  }

  const sections: string[] = [];
  const preamble = [...lines.slice(0, open), ...lines.slice(close + 1)].join("\n").trim();
  if (preamble) sections.push(preamble);
  if (truncated) {
    sections.push(
      `${CUT_NOTICE} this copy keeps the first ${truncated.kept.toLocaleString("en-US")} of ${truncated.total.toLocaleString("en-US")} characters ` +
        `of the definition. Operations and components past that point are missing here; an absent path or schema is not proof it does not exist — check the source URL.`,
    );
  }

  const source = inner.join("\n");
  const spec = parseDefinition(source, truncated !== null);
  if (!isObject(spec)) return renderGraphql(source, sections, truncated);
  const isAsync = "asyncapi" in spec || ("channels" in spec && !("paths" in spec));
  if (!isAsync && !("paths" in spec) && !("swagger" in spec) && !("openapi" in spec)) return null;
  const structural = new Set(["paths", "components", "definitions", "parameters", "responses", "securityDefinitions", "channels", "operations"]);
  const overview = Object.fromEntries(Object.entries(spec).filter(([k]) => !structural.has(k)));
  if (Object.keys(overview).length) sections.push(`## Overview\n\n${yamlBlock(overview)}`);

  const counts = isAsync ? renderAsyncApi(spec, sections) : renderOpenApi(spec, sections);
  const lang = detectLang(proseOf(spec).join("\n"));
  return { body: sections.join("\n\n"), truncated, ...counts, lang };
}
