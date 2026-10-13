import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { CUT_NOTICE, parseTruncatedJson, renderApiSpec } from "../src/ingest/api-spec.js";
import { chunkDocument } from "../src/ingest/chunker.js";
import { loadDocument } from "../src/ingest/loader.js";
import { headingText } from "../src/markdown.js";
import { DocumentStore, outlineOf, sourceIdFromUrl } from "../src/retrieval/documents.js";

const SPEC = {
  openapi: "3.1.0",
  info: {
    title: "ApiIntegration | v1",
    version: "1.0.0",
    description: "API per gli integratori: con questa API il gestionale carica i documenti nella cartella del cliente e ne legge lo stato, che viene aggiornato anche dal servizio di conservazione.",
  },
  servers: [{ url: "https://onedoc-dev.example.com/api/integration" }],
  paths: {
    "/categories": {
      parameters: [{ name: "X-Item-ID", in: "header", required: true, schema: { type: "string" } }],
      get: { tags: ["Categories"], summary: "Elenco delle categorie", description: "Restituisce tutte le categorie del cliente", operationId: "getCategories", responses: { "200": { description: "OK" } } },
      post: { tags: ["Categories"], summary: "Crea una categoria", operationId: "createCategory", deprecated: true, responses: { "201": { description: "Creata" } } },
    },
    "/documents/{id}": {
      delete: { summary: "Elimina un documento", responses: { "204": { description: "Nessun contenuto" } } },
    },
  },
  components: {
    schemas: { DocumentResponse: { type: "object", properties: { id: { type: "string" }, ts_bi: { type: "string" } } } },
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
  },
};

const page = (definition: string) =>
  `# ApiIntegration (API definition)\n\nIntegrator API per TS Documents\n\nAPI type: openapi. Owner: documentale.\n\n\`\`\`yaml\n${definition}\n\`\`\``;

describe("renderApiSpec", () => {
  it("writes one section per operation and component, losing nothing", () => {
    const r = renderApiSpec(page(JSON.stringify(SPEC)));
    expect(r).not.toBeNull();
    const body = r?.body ?? "";
    const headings = outlineOf(body.split("\n")).map((h) => `${"#".repeat(h.level)} ${h.text}`);
    expect(headings).toEqual([
      "# ApiIntegration (API definition)",
      "## Overview",
      "## Operations",
      "### GET /categories — Elenco delle categorie",
      "### POST /categories — Crea una categoria",
      "### DELETE /documents/{id} — Elimina un documento",
      "## Schemas",
      "### DocumentResponse",
      "## Components: securitySchemes",
      "### bearer",
    ]);
    expect(body).toContain("operationId `createCategory` · tags: Categories · **deprecated**");
    expect(body).toContain("Shared by every method of `/categories`");
    expect(body).toContain("X-Item-ID");
    expect(body).toContain("Integrator API per TS Documents");
    expect(r?.operations).toBe(3);
    expect(r?.components).toBe(2);
    expect(r?.lang).toBe("it");
    expect(r?.truncated).toBeNull();
  });

  it("repairs a definition sync cut and says so", () => {
    const json = JSON.stringify(SPEC);
    const cut = json.slice(0, json.indexOf('"/documents/{id}"') + 25);
    const r = renderApiSpec(page(`${cut}\n# … truncated (${json.length} chars)`));
    expect(r?.truncated).toEqual({ kept: cut.length, total: json.length });
    expect(r?.body).toContain(CUT_NOTICE);
    expect(r?.body).toContain("### GET /categories");
    expect(r?.body).not.toContain("truncated (");
  });

  it("renders YAML definitions and GraphQL schemas", () => {
    const yaml = "openapi: 3.0.0\ninfo:\n  title: T\n  version: '1'\npaths:\n  /a:\n    get:\n      summary: Read a\n      responses:\n        '200':\n          description: ok\n";
    expect(renderApiSpec(page(yaml))?.body).toContain("### GET /a — Read a");
    const sdl = 'type Query {\n  tributi(id: ID!): [Tributo]\n}\n\ntype Mutation {\n  addTributo(input: TributoInput): Tributo\n}\n\ninput TributoInput {\n  codice: String\n}\n';
    const g = renderApiSpec(page(sdl).replace("```yaml", "```graphql"));
    expect(g?.body).toContain("### type Query");
    expect(g?.body).toContain("### input TributoInput");
    expect(g?.operations).toBe(2);
  });

  it("leaves anything else alone", () => {
    expect(renderApiSpec(page("apiVersion: teamsystem.com/v1\nkind: API\n"))).toBeNull();
    expect(renderApiSpec("# No fence here\n\nJust prose.")).toBeNull();
  });

  it("parses JSON cut mid-string, mid-key and mid-array", () => {
    const json = JSON.stringify({ a: [1, 2, { b: "long text" }], c: { d: "e", f: "gh" } });
    for (let n = 10; n < json.length; n += 3) expect(parseTruncatedJson(json.slice(0, n))).not.toBeNull();
    expect(parseTruncatedJson(json)).toEqual(JSON.parse(json));
  });
});

describe("API definitions through the loader and the chunker", () => {
  let kbDir: string;

  beforeAll(async () => {
    kbDir = await mkdtemp(path.join(tmpdir(), "ai-wiki-api-"));
    await mkdir(path.join(kbDir, "devportal", "api", "x"), { recursive: true });
    const fm = '---\nsource_id: "devportal:default/api/x#definition"\nsource_type: devportal\nkind: api\ntitle: "X (API definition)"\nlang: en\n---\n\n';
    // Big enough that sections do not all merge into one chunk: 40 operations with real descriptions.
    const big = structuredClone(SPEC) as { paths: Record<string, unknown> };
    for (let i = 0; i < 40; i++) {
      big.paths[`/items/${i}`] = {
        get: { summary: `Legge l'elemento ${i}`, description: "Restituisce l'elemento richiesto con tutti i suoi attributi. ".repeat(12), responses: { "200": { description: "OK" } } },
      };
    }
    await writeFile(path.join(kbDir, "devportal", "api", "x", "__definition.md"), fm + page(JSON.stringify(big)), "utf8");
  });

  it("gives every chunk the operation it belongs to and the spec's own language", async () => {
    const doc = await loadDocument(kbDir, "devportal/api/x/__definition.md");
    expect(doc.meta.lang).toBe("it");
    const paths = chunkDocument(doc, config.chunking).map((c) => c.headingPath);
    expect(paths.some((p) => p.endsWith("Operations > GET /items/7 — Legge l'elemento 7"))).toBe(true);
    expect(paths.some((p) => /Schemas > DocumentResponse$|Operations > GET \/items\/39/.test(p))).toBe(true);
  });
});

describe("headingText", () => {
  it.each([
    ["**Bold** heading", "Bold heading"],
    ["`code` and _emphasis_", "code and emphasis"],
    ["__Strong__", "Strong"],
    ["Schema ts_bi and X_Workspace_ID", "Schema ts_bi and X_Workspace_ID"],
    ["ADR0019_opentelemetry_adoption.md", "ADR0019_opentelemetry_adoption.md"],
    ["subject\\_token", "subject_token"],
  ])("%s → %s", (raw, text) => expect(headingText(raw)).toBe(text));
});

describe("sourceIdFromUrl", () => {
  it.each([
    ["https://development.teamsystem.com/docs/default/Component/experience-services/services/launchpad/docs/", "devportal:default/component/experience-services/services/launchpad/docs/"],
    ["https://development.teamsystem.com/docs/default/module/aml/akv2k8s", "devportal:default/module/aml/akv2k8s/"],
    ["https://development.teamsystem.com/catalog/default/api/ts-documents-integrator-api/definition", "devportal:default/api/ts-documents-integrator-api#definition"],
    ["https://teamsystem.atlassian.net/wiki/spaces/CTO/pages/1416003719/Integrazione+OpenTelemetry", "confluence:CTO:1416003719"],
    ["https://biosphere.teamsystem.com/oneplatform/adrs/-/blob/main/Platform/ADR0019_opentelemetry_adoption.md", "gitlab:oneplatform/adrs:Platform/ADR0019_opentelemetry_adoption.md"],
    ["https://biosphere.teamsystem.com/oneplatform/adrs", "gitlab:oneplatform/adrs:__project"],
  ])("%s", (url, id) => expect(sourceIdFromUrl(url)).toBe(id));
});

describe("fetch_document on a rendered definition", () => {
  let store: DocumentStore;

  beforeAll(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ai-wiki-fetch-"));
    const kbDir = path.join(root, "kb");
    await mkdir(path.join(kbDir, "devportal"), { recursive: true });
    const twice = "# Two APIs\n\n## Ricerca delle gestite\n\n### Query Parameters\n\nmanagedIds\n\n## Ricerca dei gestori\n\n### Query Parameters\n\nmanagerIds\n";
    await writeFile(path.join(kbDir, "devportal", "twice.md"), `---\nsource_id: "devportal:default/component/agyo/twice/"\ntitle: Two APIs\n---\n\n${twice}`, "utf8");
    const long = `---\nsource_id: "devportal:default/component/agyo/long/"\ntitle: Long\n---\n\n${Array.from({ length: 200 }, (_, i) => `line ${i} without any heading at all`).join("\n")}\n`;
    await writeFile(path.join(kbDir, "devportal", "long.md"), long, "utf8");
    const manifest = {
      version: 1,
      embeddingModel: "mock",
      embeddingDimensions: 8,
      chunking: { targetTokens: 450, maxTokens: 700, overlapTokens: 60 },
      docs: Object.fromEntries(
        [
          ["devportal:default/component/agyo/twice/", "devportal/twice.md"],
          ["devportal:default/component/agyo/long/", "devportal/long.md"],
        ].map(([id, rel]) => [id, { sourceId: id, relPath: rel, contentHash: "sha256:x", chunkCount: 1, indexedAt: new Date().toISOString() }]),
      ),
    };
    await writeFile(path.join(root, "manifest.json"), JSON.stringify(manifest), "utf8");
    store = await DocumentStore.open(path.join(root, "manifest.json"), kbDir);
  });

  it("reaches a repeated heading by its path and names the other one", async () => {
    const first = await store.fetch("devportal:default/component/agyo/twice/", { section: "Query Parameters" });
    expect(first.content).toContain("managedIds");
    expect(first.sectionAlternatives).toEqual(["Ricerca dei gestori > Query Parameters"]);
    const second = await store.fetch("devportal:default/component/agyo/twice/", { section: "Ricerca dei gestori > Query Parameters" });
    expect(second.content).toContain("managerIds");
    expect(second.content).not.toContain("managedIds");
  });

  it("pages through a document without headings with offset", async () => {
    const head = await store.fetch("devportal:default/component/agyo/long/", { maxChars: 500 });
    expect(head.truncated).toBe(true);
    expect(head.nextOffset).toBeGreaterThan(0);
    const next = await store.fetch("devportal:default/component/agyo/long/", { maxChars: 500, offset: head.nextOffset ?? 0 });
    expect(next.offset).toBe(head.nextOffset);
    expect(next.content.startsWith("line ")).toBe(true);
    expect(next.content).not.toContain("line 0 ");
  });

  it("accepts the page's URL as its id", async () => {
    expect(store.resolve("https://development.teamsystem.com/docs/default/component/agyo/twice")).toBe("devportal:default/component/agyo/twice/");
  });
});
