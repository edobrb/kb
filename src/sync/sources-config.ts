import { readFile } from "node:fs/promises";
import YAML from "yaml";
import type { SyncDoc } from "./types.js";

export interface Rule {
  /** Wildcard on the source id, e.g. "gitlab:oneplatform/adrs:*" (`*` matches anything). */
  match?: string;
  /** Wildcard on the source URL. */
  url?: string;
  /** Wildcard on the title. */
  title?: string;
  source_type?: string;
  authority?: "binding" | "normative" | "descriptive";
  skip?: boolean;
}

export interface SourcesConfig {
  confluence: {
    enabled: boolean;
    spaces: { include: string[]; exclude: string[] };
    include_personal_spaces: boolean;
    include_blogposts: boolean;
    min_body_chars: number;
  };
  devportal: {
    enabled: boolean;
    include_api_definitions: boolean;
    max_definition_chars: number;
    exclude_entities: string[];
    min_body_chars: number;
  };
  gitlab: {
    enabled: boolean;
    groups: string[];
    projects: string[];
    /** Project paths (wildcards allowed, case-insensitive) never indexed, e.g. the repo that held the old KB. */
    exclude_projects: string[];
    skip_if_in_devportal: boolean;
    include: string[];
    exclude: string[];
    max_file_kb: number;
    include_archived: boolean;
    min_body_chars: number;
  };
  rules: Rule[];
}

export const DEFAULT_SOURCES: SourcesConfig = {
  confluence: {
    enabled: true,
    spaces: { include: [], exclude: [] },
    include_personal_spaces: false,
    include_blogposts: false,
    min_body_chars: 40,
  },
  devportal: {
    enabled: true,
    include_api_definitions: true,
    max_definition_chars: 60_000,
    exclude_entities: [],
    min_body_chars: 40,
  },
  gitlab: {
    enabled: true,
    groups: [],
    projects: [],
    exclude_projects: [],
    skip_if_in_devportal: true,
    include: ["**/*.md", "**/*.markdown"],
    exclude: ["**/node_modules/**", "**/vendor/**", "**/CHANGELOG*", "**/LICENSE*", "**/.gitlab/**", "**/.github/**"],
    max_file_kb: 512,
    include_archived: false,
    min_body_chars: 40,
  },
  rules: [],
};

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Deep-merge `patch` over `base` (arrays are replaced, not concatenated). */
function merge<T>(base: T, patch: unknown): T {
  if (!isObj(base) || !isObj(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const cur = (base as Record<string, unknown>)[k];
    out[k] = isObj(cur) && isObj(v) ? merge(cur, v) : v;
  }
  return out as T;
}

export function parseSourcesConfig(yamlText: string): SourcesConfig {
  const parsed = YAML.parse(yamlText) ?? {};
  if (!isObj(parsed)) throw new Error("sources.yaml must be a mapping");
  const cfg = merge(DEFAULT_SOURCES, parsed);
  cfg.rules = Array.isArray(cfg.rules) ? cfg.rules : [];
  for (const r of cfg.rules) {
    if (r.authority && !["binding", "normative", "descriptive"].includes(r.authority))
      throw new Error(`sources.yaml rule ${JSON.stringify(r.match ?? r.url ?? r.title)}: authority must be binding|normative|descriptive`);
  }
  return cfg;
}

export async function loadSourcesConfig(file: string): Promise<SourcesConfig> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return structuredClone(DEFAULT_SOURCES);
  }
  return parseSourcesConfig(text);
}

/** `*` matches anything (including `/`), `?` one char. Case-insensitive, anchored. */
export function wildcardToRegExp(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${esc}$`, "i");
}

/** Path glob: `**` crosses directories, `*` and `?` do not. Case-insensitive, anchored. */
export function globToRegExp(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

export function matchesAny(path: string, patterns: string[], cache = new Map<string, RegExp>()): boolean {
  for (const p of patterns) {
    let re = cache.get(p);
    if (!re) {
      re = globToRegExp(p);
      cache.set(p, re);
    }
    if (re.test(path)) return true;
  }
  return false;
}

function ruleMatches(rule: Rule, doc: SyncDoc): boolean {
  if (!rule.match && !rule.url && !rule.title) return false;
  if (rule.match && !wildcardToRegExp(rule.match).test(doc.sourceId)) return false;
  if (rule.url && !(doc.sourceUrl && wildcardToRegExp(rule.url).test(doc.sourceUrl))) return false;
  if (rule.title && !wildcardToRegExp(rule.title).test(doc.title)) return false;
  return true;
}

/** Apply the first matching rule. Returns null when the document must be skipped. */
export function applyRules(doc: SyncDoc, rules: Rule[]): SyncDoc | null {
  for (const rule of rules) {
    if (!ruleMatches(rule, doc)) continue;
    if (rule.skip) return null;
    return {
      ...doc,
      sourceType: rule.source_type ?? doc.sourceType,
      authority: rule.authority ?? doc.authority,
    };
  }
  return doc;
}
