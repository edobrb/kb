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

Body text.
`;

describe("parseFrontmatter + buildDocMeta", () => {
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
