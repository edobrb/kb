import { describe, expect, it } from "vitest";
import { htmlToMarkdown, tidyMarkdown } from "../src/sync/html.js";
import { detectLang } from "../src/sync/lang.js";
import { ensureTitleHeading, renderKbDocument, slugify } from "../src/sync/kb-writer.js";

/** Selectors the old Confluence connector removed; the converter is still exercised on Confluence-shaped HTML. */
const CONFLUENCE_REMOVE = [".toc-macro", ".plugin_pagetree", ".confluence-embedded-file-wrapper", ".expand-control-icon", ".aui-icon", ".confluence-information-macro-icon", ".hidden"];

const confluenceExportView = `
<h2><strong>Executive Summary</strong></h2>
<p>The token is passed as <code>subject_token</code> in the request.</p>
<div class="table-wrap"><table class="confluenceTable"><tbody>
<tr><th class="confluenceTh">Code</th><th class="confluenceTh">Meaning</th></tr>
<tr><td class="confluenceTd"><p>READONLY_DATE_LIMIT_REACHED</p></td><td class="confluenceTd">The <em>date</em> limit was hit</td></tr>
</tbody></table></div>
<div class="code panel pdl"><div class="codeHeader panelHeader pdl"><b>Example</b></div>
<div class="codeContent panelContent pdl"><pre class="syntaxhighlighter-pre" data-syntaxhighlighter-params="brush: java; gutter: false; theme: Confluence">var x = a &amp;&amp; b;
System.out.println("hi");</pre></div></div>
<div class="confluence-information-macro confluence-information-macro-note"><span class="aui-icon aui-icon-small aui-iconfont-warning confluence-information-macro-icon"></span>
<div class="confluence-information-macro-body"><p>Never store the secret.</p></div></div>
<ul class="inline-task-list"><li data-inline-task-id="1" class="checked">Done item</li><li data-inline-task-id="2">Open item</li></ul>
<p><img src="/wiki/download/attachments/1/diagram.png" alt="Sequence diagram"></p>
<div class="toc-macro rbtoc"><ul><li><a href="#x">Executive Summary</a></li></ul></div>
<p>See <a href="/wiki/spaces/CTO/pages/123/Other">the other page</a>.</p>
`;

const mkdocsPage = `<!doctype html><html><head><title>Consume records - Hermes</title><style>.x{}</style></head><body>
<header class="md-header">Hermes docs</header>
<nav class="md-nav"><ul><li><a href="../">Home</a></li></ul></nav>
<div class="md-container"><main class="md-main"><div class="md-content" data-md-component="content">
<article class="md-content__inner md-typeset">
<a href="https://biosphere.teamsystem.com/tsdigital/oneplatform/hermes-2.0/docs/-/edit/main/docs/consume-records.md" title="Edit" class="md-content__button md-icon">edit</a>
<h1 id="consume-records">Consume records<a class="headerlink" href="#consume-records" title="Permanent link">¶</a></h1>
<p>Bootstrap servers are listed below.</p>
<h2 id="bootstrap-servers">Bootstrap servers<a class="headerlink" href="#bootstrap-servers">¶</a></h2>
<div class="highlight"><pre><span></span><code><span class="nt">bootstrap.servers</span><span class="p">:</span> <span class="l">kafka:9092</span>
</code></pre></div>
<div class="admonition warning"><p class="admonition-title">Warning</p><p>Use TLS.</p></div>
<ul class="task-list"><li class="task-list-item"><input type="checkbox" checked disabled> Configured</li></ul>
</article></div></main></div>
<footer class="md-footer">footer stuff</footer>
</body></html>`;

describe("htmlToMarkdown — Confluence export_view", () => {
  const md = htmlToMarkdown(confluenceExportView, { baseUrl: "https://teamsystem.atlassian.net/wiki/", removeSelectors: CONFLUENCE_REMOVE });

  it("renders headings, tables, inline code and keeps identifiers unescaped", () => {
    expect(md).toContain("## **Executive Summary**");
    expect(md).toContain("`subject_token`");
    expect(md).toContain("| Code | Meaning |");
    expect(md).toContain("READONLY_DATE_LIMIT_REACHED");
    expect(md).not.toContain("\\_");
  });

  it("turns Confluence code panels into fenced blocks with the brush language", () => {
    expect(md).toContain("```java\nvar x = a && b;\nSystem.out.println(\"hi\");\n```");
  });

  it("converts info macros to blockquotes and task lists to checkboxes", () => {
    expect(md).toContain("> Never store the secret.");
    expect(md).toContain("- [x] Done item");
    expect(md).toContain("- [ ] Open item");
  });

  it("drops images (keeping alt text), TOC macros, and absolutises links", () => {
    expect(md).not.toContain("<img");
    expect(md).toContain("[image: Sequence diagram]");
    expect(md).not.toContain("#x");
    expect(md).toContain("[the other page](https://teamsystem.atlassian.net/wiki/spaces/CTO/pages/123/Other)");
  });
});

describe("htmlToMarkdown — mkdocs / TechDocs page", () => {
  const md = htmlToMarkdown(mkdocsPage, {
    baseUrl: "https://development.teamsystem.com/docs/default/module/hermes/consume-records/",
    contentSelectors: ["article.md-content__inner", "article", '[role="main"]'],
    removeSelectors: [".headerlink", ".md-content__button", ".md-nav", ".md-header", ".md-footer", "nav", "footer", "header"],
  });

  it("keeps only the article, without nav/footer/¶ anchors/edit button", () => {
    expect(md.startsWith("# Consume records")).toBe(true);
    expect(md).not.toContain("Hermes docs");
    expect(md).not.toContain("footer stuff");
    expect(md).not.toContain("¶");
    expect(md).not.toContain("edit");
  });

  it("flattens highlighted <pre><span></span><code> into a fenced block", () => {
    expect(md).toContain("```\nbootstrap.servers: kafka:9092\n```");
  });

  it("handles admonitions and checked task items", () => {
    expect(md).toContain("> Warning");
    expect(md).toContain("> Use TLS.");
    expect(md).toContain("- [x] Configured");
  });
});

describe("tidyMarkdown / kb-writer helpers", () => {
  it("normalises whitespace and escaped underscores", () => {
    expect(tidyMarkdown("a b  \n\n\n\nc \\_d\\_ ¶")).toBe("a b\n\nc _d_");
  });

  it("slugifies unicode titles", () => {
    expect(slugify("Guida all'autenticazione M2M (v2)")).toBe("guida-all-autenticazione-m2m-v2");
    expect(slugify("   ")).toBe("untitled");
  });

  it("prepends the title heading only when missing", () => {
    expect(ensureTitleHeading("body", "T")).toBe("# T\n\nbody");
    expect(ensureTitleHeading("# Own\n\nbody", "T")).toBe("# Own\n\nbody");
    expect(ensureTitleHeading("<!-- confluence-page-id: 1 -->\n<!-- k: v -->\n\n# Own\n\nbody", "T")).toBe("<!-- confluence-page-id: 1 -->\n<!-- k: v -->\n\n# Own\n\nbody");
  });

  it("renders frontmatter that the loader understands", () => {
    const out = renderKbDocument(
      {
        sourceId: "confluence:CTO:1",
        sourceType: "confluence",
        relPath: "confluence/CTO/1-x.md",
        title: "Title: with colon",
        sourceUrl: "https://x/y",
        lastModified: "2026-01-02",
        body: "Hello",
        fingerprint: "v3",
        extra: { space_key: "CTO", empty: "", list: [], tags: ["a", "b"] },
      },
      "2026-09-08",
    );
    expect(out.startsWith("---\nsource_id: confluence:CTO:1\nsource_type: confluence\n")).toBe(true);
    expect(out).toContain('title: "Title: with colon"');
    expect(out).toContain("authority: descriptive");
    expect(out).toContain("lang: und");
    expect(out).toContain("fetched_at: 2026-09-08");
    expect(out).toContain("space_key: CTO");
    expect(out).not.toContain("empty:");
    expect(out).not.toContain("list:");
    expect(out).toContain("tags:\n  - a\n  - b");
    expect(out.endsWith("---\n\n# Title: with colon\n\nHello\n")).toBe(true);
  });
});

describe("detectLang", () => {
  it("detects Italian and English prose", () => {
    expect(detectLang("Il token viene passato nella richiesta e non deve essere salvato per nessun motivo, anche se la policy lo consente.")).toBe("it");
    expect(detectLang("The token is passed in the request and must not be stored for any reason, even if the policy allows it.")).toBe("en");
  });
  it("returns und for short or code-only text", () => {
    expect(detectLang("```\nconst x = 1;\n```")).toBe("und");
    expect(detectLang("OK")).toBe("und");
  });
});

describe("mkdocs line-numbered code tables", () => {
  it("keeps only the code of a Pygments highlighttable", async () => {
    const { htmlToMarkdown } = await import("../src/sync/html.js");
    const html = `<article><p>Intro.</p><div class="language-yaml highlight"><table class="highlighttable"><tr><td class="linenos"><div class="linenodiv"><pre><span class="normal">1</span>\n<span class="normal">2</span></pre></div></td><td class="code"><div><pre><span></span><code>openapi: 3.0.0\ninfo: x</code></pre></div></td></tr></table></div><p>After.</p></article>`;
    const md = htmlToMarkdown(html, { contentSelectors: ["article"] });
    expect(md).toContain("```yaml\nopenapi: 3.0.0\ninfo: x\n```");
    expect(md).not.toContain("|");
    expect(md).not.toContain("<br>");
    expect(md).not.toMatch(/^1\s*$/m);
  });
});
