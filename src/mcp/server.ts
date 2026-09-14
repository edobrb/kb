import { readFile, stat } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { config, paths } from "../config.js";
import { getGraph } from "../graph/index.js";
import { DocumentStore } from "../retrieval/documents.js";
import { Retriever } from "../retrieval/retriever.js";
import { SERVER_INSTRUCTIONS, mcpTools, runMcpTool, type McpContext } from "./tools.js";

/**
 * The MCP server: the knowledge base's retrieval layer over stdio, for Claude Code and the Claude
 * desktop app (see src/mcp/tools.ts for what it exposes and why generation is left out).
 *
 * Two rules the transport imposes:
 *  - stdout carries JSON-RPC frames, so nothing else may be written to it. `src/cli/mcp.ts` points
 *    console.* at stderr before this module is even imported.
 *  - `initialize` must answer promptly, so the index, the document store and the graph are opened
 *    on the first tool call rather than at startup (opening LanceDB and the BM25 index takes a
 *    moment, and a client that only lists tools should not pay for it).
 */

async function packageVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** True when `data/graph.json.gz` exists, which is what makes `related` worth advertising. */
async function graphOnDisk(): Promise<boolean> {
  try {
    await stat(paths.graph);
    return config.graph.enabled;
  } catch {
    return false;
  }
}

let contextPromise: Promise<McpContext> | null = null;

function kbContext(): Promise<McpContext> {
  if (!contextPromise) {
    contextPromise = (async () => {
      const [searcher, store] = await Promise.all([Retriever.open(), DocumentStore.open()]);
      const stats = await searcher.stats();
      process.stderr.write(
        `ai-wiki mcp: ${stats.chunks} chunks, ${store.size} documents, ${config.embedding.model} @ ${config.ollama.host}\n`,
      );
      return { searcher, store, graph: () => (config.graph.enabled ? getGraph() : Promise.resolve(null)) };
    })().catch((err) => {
      // Do not cache a failure: Ollama may be down, or the index not built yet, and both are fixed
      // without restarting the server.
      contextPromise = null;
      throw err;
    });
  }
  return contextPromise;
}

export async function startMcpServer(): Promise<void> {
  const server = new Server(
    { name: "ai-wiki", version: await packageVersion() },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools({ graph: await graphOnDisk() }) }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const started = Date.now();
    let ctx: McpContext;
    try {
      ctx = await kbContext();
    } catch (err) {
      const message = (err as Error).message;
      process.stderr.write(`ai-wiki mcp: cannot open the knowledge base: ${message}\n`);
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              `The ai-wiki knowledge base is not available: ${message}\n` +
              `Check that Ollama is running (${config.ollama.host}) and that the index has been built ` +
              `(\`npm run ingest\` in ${process.cwd()}).`,
          },
        ],
      };
    }

    const result = await runMcpTool(name, (args ?? {}) as Record<string, unknown>, ctx);
    process.stderr.write(
      `ai-wiki mcp: ${name}(${JSON.stringify(args ?? {}).slice(0, 160)}) → ${result.isError ? "error, " : ""}${result.text.length} chars in ${Date.now() - started}ms\n`,
    );
    return { content: [{ type: "text", text: result.text }], ...(result.isError ? { isError: true } : {}) };
  });

  await server.connect(new StdioServerTransport());
  process.stderr.write(`ai-wiki mcp: ready on stdio (kb=${config.kbDir}, data=${config.dataDir})\n`);
}
