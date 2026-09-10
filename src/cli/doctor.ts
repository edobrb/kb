import { stat } from "node:fs/promises";
import { config, paths } from "../config.js";
import { listModels } from "../llm/ollama.js";
import { readManifest } from "../ingest/manifest.js";
import { Retriever } from "../retrieval/retriever.js";
import { builtinDefinitions, builtinEnrichers } from "../sync/index.js";
import { loadTaxonomy } from "../citymap.js";
import { loadSourcesConfig } from "../sync/sources-config.js";
import { readState } from "../sync/state.js";

/** Checks the environment: Ollama reachable, models pulled, kb folder present, index state. */

const ok = (m: string) => console.log(`  ✓ ${m}`);
const warn = (m: string) => console.log(`  ! ${m}`);
const bad = (m: string) => console.log(`  ✗ ${m}`);
let failures = 0;

console.log(`ai-wiki-rag doctor\n`);
console.log(`Config`);
console.log(`  KB_DIR            ${config.kbDir}`);
console.log(`  DATA_DIR          ${config.dataDir}`);
console.log(`  OLLAMA_HOST       ${config.ollama.host}`);
console.log(`  EMBEDDING_MODEL   ${config.embedding.model} (${config.embedding.dimensions} dims, provider=${config.embedding.provider})`);
console.log(`  CHAT_MODEL        ${config.chat.model} (think=${config.chat.think}, provider=${config.chat.provider})\n`);

console.log(`Knowledge base`);
try {
  if (!(await stat(config.kbDir)).isDirectory()) throw new Error();
  ok(`folder exists`);
} catch {
  bad(`folder not found: ${config.kbDir}`);
  failures++;
}

console.log(`\nSync sources (npm run sync; scope in ${config.sync.sourcesFile})`);
try {
  const sources = await loadSourcesConfig(config.sync.sourcesFile);
  for (const [name, def] of Object.entries(builtinDefinitions(sources))) {
    if (!def.enabled) {
      warn(`${name}: disabled in sources.yaml`);
      continue;
    }
    if (!def.hasCredentials) {
      warn(`${name}: ${def.credentialsHint}`);
    } else {
      try {
        ok(`${name}: ${await def.probe(def.http())} (${def.baseUrl})`);
      } catch (err) {
        bad(`${name}: ${(err as Error).message}`);
        failures++;
      }
    }
    const st = await readState(paths.syncState, name);
    if (st) console.log(`      last sync ${st.lastRunAt ?? "?"}, ${Object.keys(st.items).length} documents in kb/${def.folder}/`);
    else console.log(`      never synced → npm run sync -- --source ${name}`);
  }
  for (const [name, def] of Object.entries(builtinEnrichers(sources))) {
    if (!def.enabled) {
      warn(`${name} (project-card enrichment): disabled in sources.yaml — project cards will have no related Confluence pages`);
      continue;
    }
    if (!def.hasCredentials) {
      warn(`${name} (project-card enrichment): ${def.credentialsHint}`);
      continue;
    }
    try {
      ok(`${name} (project-card enrichment): ${await def.probe(def.http())} (${def.baseUrl})`);
    } catch (err) {
      bad(`${name} (project-card enrichment): ${(err as Error).message}`);
      failures++;
    }
  }
} catch (err) {
  bad(`sources.yaml: ${(err as Error).message}`);
  failures++;
}
try {
  const tax = await loadTaxonomy(config.sync.taxonomyFile);
  ok(`taxonomy.yaml: ${tax.rules.length} City Map placement rules, ${Object.keys(tax.nodes).length} extra nodes (${config.sync.taxonomyFile})`);
} catch (err) {
  bad(`taxonomy.yaml: ${(err as Error).message}`);
  failures++;
}

console.log(`\nOllama`);
if (config.embedding.provider === "ollama" || config.chat.provider === "ollama") {
  try {
    const models = await listModels();
    ok(`reachable at ${config.ollama.host} (${models.length} models)`);
    const has = (name: string) => models.some((m) => m === name || m.split(":")[0] === name.split(":")[0]);
    if (config.embedding.provider === "ollama") {
      if (models.includes(config.embedding.model)) ok(`embedding model ${config.embedding.model} is pulled`);
      else if (has(config.embedding.model)) warn(`a different tag of ${config.embedding.model.split(":")[0]} is pulled; set EMBEDDING_MODEL to one of: ${models.filter((m) => has(m) && m.startsWith(config.embedding.model.split(":")[0] as string)).join(", ")}`);
      else {
        bad(`embedding model missing → run: ollama pull ${config.embedding.model}`);
        failures++;
      }
    }
    if (config.chat.provider === "ollama") {
      if (models.includes(config.chat.model)) ok(`chat model ${config.chat.model} is pulled`);
      else {
        bad(`chat model missing → run: ollama pull ${config.chat.model}`);
        failures++;
      }
    }
  } catch (err) {
    bad((err as Error).message);
    bad(`start it with: ollama serve   (or open the Ollama app)`);
    failures++;
  }
} else {
  warn(`mock providers in use (EMBEDDING_PROVIDER/CHAT_PROVIDER=mock) — fine for tests, not for real answers`);
}

console.log(`\nIndex`);
const manifest = await readManifest(paths.manifest);
if (!manifest) {
  warn(`no index yet → run: npm run ingest`);
} else {
  const docs = Object.keys(manifest.docs).length;
  ok(`manifest: ${docs} documents, model ${manifest.embeddingModel} @ ${manifest.embeddingDimensions} dims`);
  try {
    const r = await Retriever.open();
    const s = await r.stats();
    ok(`LanceDB: ${s.chunks} chunks · BM25: ${s.bm25Docs} chunks`);
    if (s.chunks !== s.bm25Docs) warn(`vector and keyword index sizes differ; re-run npm run ingest`);
    // The map is derived from the vectors but survives a rebuild, so it can outlive the index it describes
    // (its chunk ids then point at rows that no longer exist). Compare timestamps rather than open it: the
    // payload is tens of megabytes once the whole KB is indexed.
    try {
      const [mapStat, manifestStat] = await Promise.all([stat(paths.kbMap), stat(paths.manifest)]);
      if (mapStat.mtimeMs < manifestStat.mtimeMs) warn(`map at ${paths.kbMap} predates the last ingest → re-run: npm run map`);
    } catch {
      /* no map yet: /map.html says so itself */
    }
    const f = await r.facets();
    console.log(`  source types      ${Object.entries(f.sourceTypes).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    console.log(`  kinds             ${Object.entries(f.kinds).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    console.log(`  authorities       ${Object.entries(f.authorities).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    console.log(`  languages         ${Object.entries(f.langs).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  } catch (err) {
    bad(`cannot open index: ${(err as Error).message}`);
    failures++;
  }
}

console.log(failures ? `\n${failures} problem(s) found.` : `\nAll good.`);
process.exit(failures ? 1 : 0);
