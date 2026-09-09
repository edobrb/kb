import { describe, expect, it } from "vitest";
import { applyRules, globToRegExp, matchesAny, parseSourcesConfig, wildcardToRegExp } from "../src/sync/sources-config.js";
import type { SyncDoc } from "../src/sync/types.js";

const doc = (sourceId: string, title = "T", sourceUrl: string | null = null): SyncDoc => ({
  sourceId,
  sourceType: sourceId.split(":")[0] as string,
  relPath: "x/y.md",
  title,
  sourceUrl,
  lastModified: null,
  body: "",
  fingerprint: "1",
  extra: {},
});

describe("globToRegExp", () => {
  it("treats ** as crossing directories and * as one segment", () => {
    expect(globToRegExp("**/*.md").test("README.md")).toBe(true);
    expect(globToRegExp("**/*.md").test("docs/a/b.md")).toBe(true);
    expect(globToRegExp("*.md").test("docs/a.md")).toBe(false);
    expect(globToRegExp("**/node_modules/**").test("web/node_modules/x/README.md")).toBe(true);
    expect(globToRegExp("**/CHANGELOG*").test("CHANGELOG.md")).toBe(true);
    expect(globToRegExp("docs/**").test("docs/x/y.md")).toBe(true);
    expect(globToRegExp("docs/**").test("src/docs/x.md")).toBe(false);
  });
  it("is case-insensitive", () => {
    expect(matchesAny("Docs/README.MD", ["**/*.md"])).toBe(true);
  });
});

describe("wildcardToRegExp", () => {
  it("lets * cross any character", () => {
    expect(wildcardToRegExp("gitlab:oneplatform/adrs:*").test("gitlab:oneplatform/adrs:Platform/ADR0001.md")).toBe(true);
    expect(wildcardToRegExp("gitlab:oneplatform/adrs:*").test("gitlab:oneplatform/other:x.md")).toBe(false);
    expect(wildcardToRegExp("*ADR[0-9]*").test("ADR[0-9] thing")).toBe(true);
  });
});

describe("parseSourcesConfig + applyRules", () => {
  const cfg = parseSourcesConfig(`
gitlab:
  groups: [oneplatform]
rules:
  - match: "gitlab:oneplatform/adrs:template.md"
    skip: true
  - match: "gitlab:oneplatform/adrs:*"
    source_type: adr
    authority: binding
  - url: "https://teamsystem.atlassian.net/wiki/spaces/CTO/*"
    authority: normative
`);

  it("merges over defaults", () => {
    expect(cfg.gitlab.groups).toEqual(["oneplatform"]);
    expect(cfg.gitlab.include).toEqual(["**/*.md", "**/*.markdown"]);
    expect(cfg.confluence.enabled).toBe(true);
    expect(cfg.rules).toHaveLength(3);
  });

  it("applies the first matching rule", () => {
    expect(applyRules(doc("gitlab:oneplatform/adrs:template.md"), cfg.rules)).toBeNull();
    const adr = applyRules(doc("gitlab:oneplatform/adrs:Platform/ADR0001.md"), cfg.rules);
    expect(adr?.sourceType).toBe("adr");
    expect(adr?.authority).toBe("binding");
    const cto = applyRules(doc("confluence:CTO:1", "x", "https://teamsystem.atlassian.net/wiki/spaces/CTO/pages/1/x"), cfg.rules);
    expect(cto?.authority).toBe("normative");
    expect(cto?.sourceType).toBe("confluence");
    const other = applyRules(doc("confluence:MPDD:2", "x", "https://teamsystem.atlassian.net/wiki/spaces/MPDD/pages/2/x"), cfg.rules);
    expect(other?.authority).toBeUndefined();
  });

  it("rejects unknown authority values", () => {
    expect(() => parseSourcesConfig(`rules:\n  - match: "x"\n    authority: official`)).toThrow(/authority/);
  });
});
