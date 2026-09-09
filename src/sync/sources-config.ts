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
  devportal: {
    enabled: boolean;
    include_api_definitions: boolean;
    max_definition_chars: number;
    /** "kind/name" or "ns/kind/name" (wildcards allowed, case-insensitive). */
    exclude_entities: string[];
    /** Page globs on "<kind>/<name>/<page path>" never indexed (generated reference trees). */
    exclude_pages: string[];
    min_body_chars: number;
    /** Pages with fewer prose words (outside code, tables, headings, link lists) are stubs and skipped. */
    min_prose_words: number;
    /** Skip pages whose title/body look generated from code (Swagger models, Sphinx modules...). */
    skip_generated: boolean;
  };
  gitlab: {
    enabled: boolean;
    groups: string[];
    projects: string[];
    /** Project paths (wildcards allowed, case-insensitive) never indexed, e.g. the repo that held the old KB. */
    exclude_projects: string[];
    /**
     * Also sync the repositories the Dev Portal catalog points at (`coveredRepos` from the devportal state),
     * wherever they live on GitLab: their README, non-TechDocs markdown and a project card with the catalog
     * owner/system. Their docs/** is already rendered by the portal and is skipped.
     */
    include_devportal_repos: boolean;
    include_archived: boolean;
    min_body_chars: number;
    /** Markdown pages with fewer prose words are stubs and skipped (tables and code count as content). */
    min_prose_words: number;
    /** Skip READMEs left by project generators (Create React App, Vite, Angular CLI, Nest...). */
    skip_boilerplate_readmes: boolean;
    /** One "project card" per repository (description, owner, README excerpt, related Confluence pages). */
    project_cards: boolean;
    /** Markdown documentation inside the repositories. */
    docs: {
      enabled: boolean;
      include: string[];
      exclude: string[];
      max_file_kb: number;
      /** For repositories the Dev Portal already renders, skip the mkdocs content (docs/**) but keep READMEs etc. */
      skip_techdocs_if_in_devportal: boolean;
    };
    /** OpenAPI / AsyncAPI contracts kept in the repositories, indexed as `kind: api` (small, high value). */
    api_specs: {
      enabled: boolean;
      include: string[];
      exclude: string[];
      max_file_kb: number;
    };
    /** Source code, stored one fenced block per file and chunked at declaration boundaries. Off by default. */
    code: {
      enabled: boolean;
      include: string[];
      exclude: string[];
      max_file_kb: number;
      /** Files longer than this are almost always generated. */
      max_lines: number;
      /** A repository with more source files than this is vendored/generated: its code is skipped and the folders are logged. */
      max_files_per_project: number;
      skip_tests: boolean;
      test_patterns: string[];
    };
  };
  /**
   * Confluence Cloud is indexed *selectively*: whole technical spaces, minus the subtrees and titles that
   * are meeting notes, sprint ceremonies, drafts and archives, minus pages without prose. It is also still
   * consulted while building the GitLab project cards (`enrich_projects`).
   */
  confluence: {
    enabled: boolean;
    spaces: { include: string[]; exclude: string[] };
    /** Optional per-space root page/folder ids: when set for a space, only their descendants are indexed. */
    roots: Record<string, string[]>;
    /** A page is skipped when it or any ancestor (page or folder) matches one of these (id or title wildcard). */
    exclude_trees: { id?: string; title?: string }[];
    /** Title wildcards applied to the page itself only. */
    exclude_titles: string[];
    /** Only pages modified on/after this ISO date (YYYY-MM-DD) are indexed; empty = no limit. */
    modified_since: string;
    min_body_chars: number;
    min_prose_words: number;
    /** Pages longer than this (markdown chars) are truncated with a marker. */
    max_body_chars: number;
    /** Project-card enrichment (the lookup the GitLab connector uses). */
    enrich_projects: boolean;
    max_pages_per_project: number;
    excerpt_chars: number;
    /** Re-run the card lookup for a project only after this many days. */
    refresh_days: number;
  };
  rules: Rule[];
}

export const DEFAULT_SOURCES: SourcesConfig = {
  devportal: {
    enabled: true,
    include_api_definitions: true,
    max_definition_chars: 60_000,
    exclude_entities: [],
    exclude_pages: [],
    min_body_chars: 40,
    min_prose_words: 15,
    skip_generated: true,
  },
  gitlab: {
    enabled: true,
    groups: [],
    projects: [],
    exclude_projects: [],
    include_devportal_repos: false,
    include_archived: false,
    min_body_chars: 40,
    min_prose_words: 15,
    skip_boilerplate_readmes: true,
    project_cards: true,
    docs: {
      enabled: true,
      include: ["**/*.md", "**/*.markdown", "**/*.mdx"],
      exclude: ["**/node_modules/**", "**/vendor/**", "**/CHANGELOG*", "**/LICENSE*", "**/.gitlab/**", "**/.github/**"],
      max_file_kb: 512,
      skip_techdocs_if_in_devportal: true,
    },
    api_specs: {
      enabled: true,
      include: ["**/openapi*.yaml", "**/openapi*.yml", "**/openapi*.json", "**/swagger*.yaml", "**/swagger*.yml", "**/swagger*.json", "**/asyncapi*.yaml", "**/asyncapi*.yml", "**/asyncapi*.json"],
      exclude: ["**/node_modules/**", "**/vendor/**", "**/dist/**", "**/build/**", "**/test/**", "**/tests/**", "**/__tests__/**", "**/fixtures/**", "**/examples/**", "**/*.template.*"],
      max_file_kb: 1024,
    },
    code: {
      enabled: false,
      include: [
        "**/*.ts", "**/*.tsx", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs",
        "**/*.py", "**/*.kt", "**/*.kts", "**/*.java", "**/*.go", "**/*.cs", "**/*.rs", "**/*.rb", "**/*.php", "**/*.scala",
        "**/*.sql", "**/*.sh", "**/*.bash", "**/*.ps1",
        "**/*.tf", "**/*.hcl", "**/*.yaml", "**/*.yml", "**/*.toml", "**/*.proto", "**/*.graphql", "**/*.gql", "**/*.prisma",
        "**/Dockerfile", "**/Dockerfile.*", "**/*.dockerfile", "**/Makefile", "**/Jenkinsfile",
        "**/*.gradle", "**/*.gradle.kts", "**/pom.xml", "**/*.csproj", "**/package.json",
        "**/openapi*.json", "**/swagger*.json", "**/*.schema.json",
      ],
      exclude: [
        "**/node_modules/**", "**/vendor/**", "**/dist/**", "**/build/**", "**/target/**", "**/out/**", "**/bin/**", "**/obj/**",
        "**/coverage/**", "**/__pycache__/**", "**/.next/**", "**/.nuxt/**", "**/.terraform/**", "**/.git/**", "**/.idea/**", "**/.vscode/**",
        "**/.venv/**", "**/venv/**", "**/site-packages/**", "**/Pods/**", "**/bower_components/**", "**/jspm_packages/**", "**/.yarn/**", "**/.pnpm/**",
        "**/third_party/**", "**/third-party/**", "**/externals/**", "**/*.bundle.js", "**/*.chunk.js", "**/*-lock.*",
        "**/*.min.*", "**/*.map", "**/*.d.ts", "**/*.snap", "**/*.lock", "**/package-lock.json", "**/yarn.lock", "**/pnpm-lock.yaml",
        "**/fixtures/**", "**/__snapshots__/**", "**/*.generated.*", "**/generated/**", "**/__generated__/**",
      ],
      max_file_kb: 256,
      max_lines: 4000,
      max_files_per_project: 5000,
      skip_tests: true,
      test_patterns: ["**/test/**", "**/tests/**", "**/__tests__/**", "**/e2e/**", "**/cypress/**", "**/*.test.*", "**/*.spec.*", "**/*_test.go", "**/test_*.py", "**/*Test.java", "**/*Test.kt", "**/*Tests.cs"],
    },
  },
  confluence: {
    enabled: false,
    spaces: { include: [], exclude: [] },
    roots: {},
    exclude_trees: [],
    exclude_titles: [],
    modified_since: "",
    min_body_chars: 120,
    min_prose_words: 25,
    max_body_chars: 400_000,
    enrich_projects: true,
    max_pages_per_project: 3,
    excerpt_chars: 400,
    refresh_days: 30,
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

/** Keys of the pre-2026-09-09 layout, with the new home of each setting. */
const LEGACY: [path: string[], hint: string][] = [
  [["gitlab", "include"], "gitlab.docs.include (markdown) / gitlab.code.include (source files)"],
  [["gitlab", "exclude"], "gitlab.docs.exclude / gitlab.code.exclude"],
  [["gitlab", "max_file_kb"], "gitlab.docs.max_file_kb / gitlab.code.max_file_kb"],
  [["gitlab", "skip_if_in_devportal"], "gitlab.docs.skip_techdocs_if_in_devportal"],
];

export function parseSourcesConfig(yamlText: string): SourcesConfig {
  const parsed = YAML.parse(yamlText) ?? {};
  if (!isObj(parsed)) throw new Error("sources.yaml must be a mapping");
  for (const [path, hint] of LEGACY) {
    let cur: unknown = parsed;
    for (const k of path) cur = isObj(cur) ? cur[k] : undefined;
    if (cur !== undefined) throw new Error(`sources.yaml: "${path.join(".")}" is no longer supported — ${hint}`);
  }
  const cfg = merge(DEFAULT_SOURCES, parsed);
  cfg.rules = Array.isArray(cfg.rules) ? cfg.rules : [];
  for (const r of cfg.rules) {
    if (r.authority && !["binding", "normative", "descriptive"].includes(r.authority))
      throw new Error(`sources.yaml rule ${JSON.stringify(r.match ?? r.url ?? r.title)}: authority must be binding|normative|descriptive`);
  }
  cfg.confluence.exclude_trees = (Array.isArray(cfg.confluence.exclude_trees) ? cfg.confluence.exclude_trees : []).map((t) => {
    if (!isObj(t) || (t["id"] === undefined && t["title"] === undefined)) throw new Error(`sources.yaml confluence.exclude_trees: each entry needs an "id" or a "title"`);
    return { ...(t["id"] !== undefined ? { id: String(t["id"]) } : {}), ...(typeof t["title"] === "string" ? { title: t["title"] } : {}) };
  });
  cfg.confluence.roots = isObj(cfg.confluence.roots) ? Object.fromEntries(Object.entries(cfg.confluence.roots).map(([k, v]) => [k, (Array.isArray(v) ? v : [v]).map(String)])) : {};
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
