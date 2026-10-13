import { describe, expect, it } from "vitest";
import { buildDocMeta, cleanBody, parseFrontmatter } from "../src/ingest/loader.js";

const sample = `---
source_id: "adr:repo-oneplatform-adrs-platform-adr0010-client-credentials"
source_type: adr
title: ADR0010 Client Credentials and Token Management for M2M and User Access
authority: binding
source_url: "https://example.com/adr0010"
body_hash: "sha256:abc"
lang: en
last_modified: "2025-05-21"
translated_from: {path: "raw/x.md", version_hash: "sha256:1"}
---
<!-- confluence-page-id: 805961883 -->

# ADR0010 Client Credentials

### Status

Accepted.

Body text.
`;

describe("parseFrontmatter + buildDocMeta", () => {
  it("keeps binding only for a decision in force", () => {
    const meta = (status: string) => {
      const raw = sample.replace("Accepted.", status);
      const { frontmatter, body } = parseFrontmatter(raw);
      return buildDocMeta(frontmatter, body, "adr/file.md", raw).authority;
    };
    expect(meta("Accepted.")).toBe("binding");
    expect(meta("Deprecated — as of 2025-05-21. See ADR0010.")).toBe("descriptive");
    expect(meta("Outdated - as of 2025-02-08 see ADR0011")).toBe("descriptive");
    expect(meta("Proposed (2026-01-23) — open to discussion")).toBe("descriptive");
    expect(meta("What is the status, such as proposed, accepted, rejected, deprecated, superseded, etc.?")).toBe("descriptive");
    // Not a decision record at all: a task checklist that lives in an adr/ folder.
    const task = sample.replace(/### Status[\s\S]*$/, "- [ ] Task 006: add indexes\n- [x] Task 005\n");
    const { frontmatter, body } = parseFrontmatter(task);
    expect(buildDocMeta(frontmatter, body, "adr/file.md", task).authority).toBe("descriptive");
  });

  it("reads the kb frontmatter fields", () => {
    const { frontmatter, body } = parseFrontmatter(sample);
    const meta = buildDocMeta(frontmatter, body, "adr/file.md", sample);
    expect(meta.sourceId).toBe("adr:repo-oneplatform-adrs-platform-adr0010-client-credentials");
    expect(meta.sourceType).toBe("adr");
    expect(meta.authority).toBe("binding");
    expect(meta.sourceUrl).toBe("https://example.com/adr0010");
    expect(meta.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(meta.lastModified).toBe("2025-05-21");
    expect(meta.title).toContain("ADR0010");
    expect(cleanBody(body)).not.toContain("confluence-page-id");
    expect(cleanBody(body).startsWith("# ADR0010")).toBe(true);
  });

  it("leaves last_modified empty rather than passing the sync time off as an edit date", () => {
    const raw = `---\nsource_id: "devportal:default/api/orders"\nfetched_at: "2026-09-22"\n---\n\n# Orders API\n`;
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(buildDocMeta(frontmatter, body, "devportal/api/orders/__definition.md", raw).lastModified).toBeNull();
  });

  it("falls back gracefully when there is no frontmatter", () => {
    const raw = "# My Page\n\nHello";
    const { frontmatter, body } = parseFrontmatter(raw);
    const meta = buildDocMeta(frontmatter, body, "notes/my-page.md", raw);
    expect(meta.title).toBe("My Page");
    expect(meta.sourceType).toBe("notes");
    expect(meta.sourceId).toBe("notes:notes-my-page");
    expect(meta.authority).toBe("unknown");
    expect(meta.contentHash.startsWith("sha256:")).toBe(true);
  });

  it("survives malformed YAML", () => {
    const raw = "---\ntitle: [unclosed\nsource_id: x:y\n---\nbody";
    const { frontmatter, body } = parseFrontmatter(raw);
    expect(body).toBe("body");
    expect(frontmatter["source_id"]).toBe("x:y");
  });
});

describe("trimCardWikiSnippets", () => {
  it("keeps a card's wiki links and titles, not the snippets that came with them", async () => {
    const { trimCardWikiSnippets } = await import("../src/ingest/loader.js");
    const card = [
      "# oneplatform/onboarding",
      "",
      "## README",
      "",
      "Provisions workspaces.",
      "",
      "## Related Confluence pages",
      "",
      "Pages found by searching the wiki for the project name; some may be only loosely related.",
      "",
      "- [Visto di conformità - Raccolta requisiti](https://example.atlassian.net/wiki/spaces/T/pages/1/Visto) (TS OnePlatform, updated 2026-04-08): 1. Obiettivi e Requisiti Generali, il visto è un'attestazione…",
      "- [Fiscal Orchestrator Bulk Actions - (AI)](https://example.atlassian.net/wiki/spaces/T/pages/2/Bulk): Validato 1. Introduction…",
      "",
      "## Languages",
      "",
      "TypeScript",
    ].join("\n");
    const out = trimCardWikiSnippets(card);
    expect(out).toContain("- [Visto di conformità - Raccolta requisiti](https://example.atlassian.net/wiki/spaces/T/pages/1/Visto) (TS OnePlatform, updated 2026-04-08)\n");
    expect(out).toContain("- [Fiscal Orchestrator Bulk Actions - (AI)](https://example.atlassian.net/wiki/spaces/T/pages/2/Bulk)\n");
    expect(out).not.toContain("Obiettivi");
    expect(out).toContain("## Languages\n\nTypeScript");
    expect(out).toContain("Provisions workspaces.");
  });
});
