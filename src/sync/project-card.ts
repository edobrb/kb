import type { ConfluenceHit } from "./types.js";

/** What the Dev Portal knows about a repository (collected by the devportal connector into `repoEntities`). */
export interface EntitySummary {
  ref: string;
  kind: string;
  title?: string;
  description?: string;
  owner?: string;
  system?: string;
  lifecycle?: string;
  type?: string;
  tags?: string[];
  /** City Map position (see src/citymap.ts): module the entity belongs to and the levels above it. */
  module?: string;
  subarea?: string;
  area?: string;
  /** The same as a breadcrumb, "Platform › Core Services - Foundation › Workspace". */
  cityMap?: string;
  /** Portal URL of the entity page. */
  url?: string;
}

export interface ProjectCardInput {
  path: string;
  name: string;
  webUrl: string;
  description: string | null;
  defaultBranch: string;
  lastActivity: string | null;
  topics: string[];
  /** GitLab `/languages`: language -> percentage. */
  languages: Record<string, number>;
  entity: EntitySummary | null;
  /** README body (markdown, frontmatter stripped) or null. */
  readme: string | null;
  confluence: ConfluenceHit[];
  files: { total: number; code: number; docs: number; topDirs: string[] };
}

const README_MAX_CHARS = 3_000;

/** Demote headings so the README lives under the card's own H2. */
function demote(md: string): string {
  return md.replace(/^(#{1,5})\s/gm, "#$1 ");
}

function excerpt(md: string, max: number): string {
  const clean = md.replace(/<!--[\s\S]*?-->/g, "").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const at = Math.max(cut.lastIndexOf("\n\n"), cut.lastIndexOf(". "));
  return `${cut.slice(0, at > max * 0.6 ? at + 1 : max).trimEnd()}\n\n[… README truncated]`;
}

/**
 * The "project card": one document per repository that says what the project is, who owns it, what it is
 * made of and where its functional documentation lives. Indexed like any document (it answers
 * "what is X / who owns X") and used as the background of every chunk context of that repository, so the
 * most important facts come first and survive truncation.
 */
export function buildProjectCard(p: ProjectCardInput): { title: string; body: string } {
  const segments = p.path.split("/");
  const group = segments[0] ?? "";
  const subgroup = segments.length > 2 ? segments.slice(1, -1).join("/") : "";
  const title = p.name && p.name !== segments.at(-1) ? `${p.name} (${p.path})` : p.path;

  const lines: string[] = [];
  lines.push(`# ${title}`, "");
  lines.push(`Repository \`${p.path}\` on GitLab (${p.webUrl}), default branch \`${p.defaultBranch}\`${p.lastActivity ? `, last activity ${p.lastActivity}` : ""}.`);
  if (p.description) lines.push("", p.description.trim());
  lines.push("", "## Summary", "");
  lines.push(`- Group \`${group}\`${subgroup ? `, sub-group \`${subgroup}\`` : ""}`);
  if (p.entity) {
    const e = p.entity;
    const bits = [
      `${e.title ?? e.ref} (${e.kind} \`${e.ref}\`${e.url ? `, ${e.url}` : ""})`,
      e.owner ? `owner ${e.owner}` : "",
      e.system ? `system ${e.system}` : "",
      e.lifecycle ? `lifecycle ${e.lifecycle}` : "",
      e.type ? `type ${e.type}` : "",
      e.tags?.length ? `tags ${e.tags.join(", ")}` : "",
    ].filter(Boolean);
    lines.push(`- Dev Portal: ${bits.join("; ")}`);
    if (e.cityMap) lines.push(`- City Map: ${e.cityMap}${e.module ? ` (module \`${e.module}\`)` : ""}`);
    if (e.description) lines.push(`- Dev Portal description: ${e.description.trim()}`);
  } else {
    lines.push("- Dev Portal: not catalogued");
  }
  const langs = Object.entries(p.languages)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([l, pct]) => `${l} ${Math.round(pct)}%`);
  if (langs.length) lines.push(`- Languages: ${langs.join(", ")}`);
  if (p.topics.length) lines.push(`- Topics: ${p.topics.join(", ")}`);
  lines.push(`- Contents: ${p.files.code} source files, ${p.files.docs} documentation files${p.files.topDirs.length ? `; top-level folders: ${p.files.topDirs.join(", ")}` : ""}`);

  if (p.readme) {
    lines.push("", "## README", "", demote(excerpt(p.readme, README_MAX_CHARS)));
  }

  if (p.confluence.length) {
    lines.push("", "## Related Confluence pages", "", "Pages found by searching the wiki for the project name; some may be only loosely related.", "");
    for (const h of p.confluence) {
      const meta = [h.space, h.lastModified ? `updated ${h.lastModified}` : ""].filter(Boolean).join(", ");
      lines.push(`- [${h.title}](${h.url})${meta ? ` (${meta})` : ""}${h.excerpt ? `: ${h.excerpt}` : ""}`);
    }
  }
  return { title, body: `${lines.join("\n").trim()}\n` };
}
