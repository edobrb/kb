import * as cheerio from "cheerio";
import TurndownService from "turndown";
import gfmPlugin from "@joplin/turndown-plugin-gfm";

/** The subset of the DOM element API we use from turndown's (domino) nodes; tsconfig has no DOM lib. */
interface DomEl {
  nodeName: string;
  textContent: string | null;
  className?: string;
  checked?: boolean;
  parentElement: DomEl | null;
  classList: { contains(c: string): boolean };
  querySelector(sel: string): DomEl | null;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}
const el = (node: unknown): DomEl => node as DomEl;

export interface HtmlToMarkdownOptions {
  /** Used to absolutise relative links. */
  baseUrl?: string;
  /** Tried in order; the first matching element becomes the root. Falls back to <body>. */
  contentSelectors?: string[];
  /** Removed before conversion (in addition to script/style/nav/...). */
  removeSelectors?: string[];
}

const ALWAYS_REMOVE = ["script", "style", "noscript", "svg", "iframe", "template", "link", "meta"];

let turndown: TurndownService | null = null;

function languageOf(pre: DomEl): string {
  const code = pre.querySelector("code");
  const classes = `${pre.className ?? ""} ${code?.className ?? ""} ${pre.parentElement?.className ?? ""}`;
  const m = /(?:language|lang|highlight)-([\w+#-]+)/i.exec(classes);
  if (m?.[1]) return m[1].toLowerCase();
  // Confluence: <pre data-syntaxhighlighter-params="brush: java; gutter: false">
  const params = pre.getAttribute("data-syntaxhighlighter-params") ?? "";
  const brush = /brush:\s*([\w+#-]+)/i.exec(params);
  if (brush?.[1]) return brush[1].toLowerCase();
  return "";
}

function fence(text: string): string {
  let marker = "```";
  while (text.includes(marker)) marker += "`";
  return marker;
}

function getTurndown(): TurndownService {
  if (turndown) return turndown;
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
    strongDelimiter: "**",
    hr: "---",
  });
  // Tables + strikethrough (task lists are handled by our own rule below).
  td.use([gfmPlugin.tables, gfmPlugin.strikethrough]);

  // Do not escape markdown punctuation: `subject_token` must stay `subject_token` so BM25 sees the
  // same token in tables and prose (see evals/KB-NOTES.md). Our consumer is an LLM, not a strict renderer.
  td.escape = (s: string) => s;

  // Any <pre> becomes a fenced block (handles mkdocs-material's <pre><span></span><code> and
  // Confluence's <pre class="syntaxhighlighter-pre"> which have no direct <code> child).
  td.addRule("preBlock", {
    filter: (node) => node.nodeName === "PRE",
    replacement: (_content, node) => {
      const pre = el(node);
      const text = (pre.textContent ?? "").replace(/\n+$/, "");
      const f = fence(text);
      return `\n\n${f}${languageOf(pre)}\n${text}\n${f}\n\n`;
    },
  });

  // Confluence / mkdocs task list items.
  td.addRule("taskItem", {
    filter: (node) => {
      if (node.nodeName !== "LI") return false;
      const li = el(node);
      return li.classList.contains("task-list-item") || li.hasAttribute("data-inline-task-id") || !!li.querySelector(':scope > input[type="checkbox"]');
    },
    replacement: (content, node) => {
      const li = el(node);
      const input = li.querySelector('input[type="checkbox"]');
      const checked = li.classList.contains("checked") || input?.checked || input?.hasAttribute("checked");
      const body = content.replace(/^\s*\[[ x]\]\s*/i, "").trim().replace(/\n/gm, "\n    ");
      return `- [${checked ? "x" : " "}] ${body}\n`;
    },
  });

  // Confluence info/note/warning panels and mkdocs admonitions -> blockquotes.
  td.addRule("panel", {
    filter: (node) => {
      if (node.nodeName !== "DIV") return false;
      const cls = el(node).className ?? "";
      return /\b(confluence-information-macro|admonition|panel\b(?!.*code))/.test(cls) && !/\bcode\b/.test(cls);
    },
    replacement: (content) => {
      const lines = content.trim().split("\n");
      return `\n\n${lines.map((l) => (l ? `> ${l}` : ">")).join("\n")}\n\n`;
    },
  });

  turndown = td;
  return td;
}

/**
 * Convert an HTML fragment/page to Markdown suitable for the kb.
 * Removes navigation and styling, absolutises links, replaces images by their alt text.
 */
export function htmlToMarkdown(html: string, opts: HtmlToMarkdownOptions = {}): string {
  const $ = cheerio.load(html);
  $([...ALWAYS_REMOVE, ...(opts.removeSelectors ?? [])].join(",")).remove();

  const rootSelector = (opts.contentSelectors ?? []).find((sel) => $(sel).length > 0) ?? "body";
  const root = $(rootSelector).first();

  if (opts.baseUrl) {
    root.find("a[href]").each((_, a) => {
      const href = $(a).attr("href");
      if (!href || /^(https?:|mailto:|#|tel:)/i.test(href)) return;
      try {
        $(a).attr("href", new URL(href, opts.baseUrl).toString());
      } catch {
        /* leave as is */
      }
    });
  }

  root.find("img").each((_, img) => {
    const alt = ($(img).attr("alt") ?? $(img).attr("title") ?? "").trim();
    $(img).replaceWith(alt ? `[image: ${alt}]` : "");
  });

  const inner = root.html() ?? "";
  return tidyMarkdown(getTurndown().turndown(inner));
}

/** Normalise whitespace/noise in generated (or fetched) markdown. */
export function tidyMarkdown(md: string): string {
  return md
    .replace(/\r\n/g, "\n")
    .replace(/[  ]/g, " ")
    .replace(/[​‌‍﻿]/g, "")
    .replace(/\s*¶\s*$/gm, "")
    .replace(/\\_/g, "_")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Plain text of an HTML fragment (for titles). */
export function htmlText(html: string): string {
  return cheerio.load(html).text().replace(/\s+/g, " ").trim();
}
