import { mkdir, rm } from "node:fs/promises";
import * as lancedb from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from "apache-arrow";
import type { RetrievalFilters, StoredChunk } from "../types.js";

const TABLE = "chunks";

export interface VectorHit {
  row: Omit<StoredChunk, "vector">;
  /** Cosine distance in [0, 2]; smaller is closer. */
  distance: number;
}

function schemaFor(dimensions: number): Schema {
  return new Schema([
    new Field("id", new Utf8(), false),
    new Field("source_id", new Utf8(), false),
    new Field("source_type", new Utf8(), false),
    new Field("title", new Utf8(), false),
    new Field("source_url", new Utf8(), false),
    new Field("authority", new Utf8(), false),
    new Field("lang", new Utf8(), false),
    new Field("last_modified", new Utf8(), false),
    new Field("rel_path", new Utf8(), false),
    new Field("ordinal", new Int32(), false),
    new Field("heading_path", new Utf8(), false),
    new Field("content", new Utf8(), false),
    new Field("text", new Utf8(), false),
    new Field("vector", new FixedSizeList(dimensions, new Field("item", new Float32(), true)), false),
  ]);
}

/** Escape a string for use inside a single-quoted SQL literal in LanceDB predicates. */
export function sqlString(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

export function buildWhere(filters?: RetrievalFilters): string | undefined {
  if (!filters) return undefined;
  const clauses: string[] = [];
  if (filters.sourceTypes?.length) clauses.push(`source_type IN (${filters.sourceTypes.map(sqlString).join(", ")})`);
  if (filters.authorities?.length) clauses.push(`authority IN (${filters.authorities.map(sqlString).join(", ")})`);
  if (filters.langs?.length) clauses.push(`lang IN (${filters.langs.map(sqlString).join(", ")})`);
  return clauses.length ? clauses.join(" AND ") : undefined;
}

/**
 * Thin wrapper over a LanceDB table. LanceDB is an embedded, file-based vector database:
 * nothing to run, the index is just a folder under DATA_DIR.
 */
export class VectorStore {
  private constructor(
    private readonly db: lancedb.Connection,
    private table: lancedb.Table | null,
    readonly dimensions: number,
    readonly dir: string,
  ) {}

  static async open(dir: string, dimensions: number): Promise<VectorStore> {
    await mkdir(dir, { recursive: true });
    const db = await lancedb.connect(dir);
    const names = await db.tableNames();
    const table = names.includes(TABLE) ? await db.openTable(TABLE) : null;
    return new VectorStore(db, table, dimensions, dir);
  }

  get isEmpty(): boolean {
    return this.table === null;
  }

  async count(): Promise<number> {
    return this.table ? this.table.countRows() : 0;
  }

  /** Delete everything (used by `ingest --reset` or when the embedding model changes). */
  async reset(): Promise<void> {
    if (this.table) {
      await this.db.dropTable(TABLE);
      this.table = null;
    }
    await rm(this.dir, { recursive: true, force: true });
    await mkdir(this.dir, { recursive: true });
  }

  private async ensureTable(): Promise<lancedb.Table> {
    if (this.table) return this.table;
    this.table = await this.db.createEmptyTable(TABLE, schemaFor(this.dimensions), { mode: "overwrite" });
    return this.table;
  }

  async add(rows: StoredChunk[]): Promise<void> {
    if (!rows.length) return;
    const table = await this.ensureTable();
    for (const r of rows) {
      if (r.vector.length !== this.dimensions) {
        throw new Error(`Chunk ${r.id} has ${r.vector.length} dims, expected ${this.dimensions}`);
      }
    }
    await table.add(rows.map((r) => ({ ...r })));
  }

  async deleteBySourceIds(sourceIds: string[]): Promise<void> {
    if (!this.table || !sourceIds.length) return;
    // Batch the IN list to keep predicates reasonably sized.
    for (let i = 0; i < sourceIds.length; i += 200) {
      const slice = sourceIds.slice(i, i + 200);
      await this.table.delete(`source_id IN (${slice.map(sqlString).join(", ")})`);
    }
  }

  /** Compact fragments after a bulk ingest so queries stay fast. */
  async optimize(): Promise<void> {
    if (!this.table) return;
    try {
      await this.table.optimize();
    } catch {
      // Best effort; optimize is not critical for correctness.
    }
  }

  async search(vector: number[], k: number, filters?: RetrievalFilters): Promise<VectorHit[]> {
    if (!this.table) return [];
    let q = this.table.vectorSearch(vector).distanceType("cosine").limit(k);
    const where = buildWhere(filters);
    if (where) q = q.where(where);
    const rows = (await q.toArray()) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      distance: Number(r["_distance"]),
      row: {
        id: String(r["id"]),
        source_id: String(r["source_id"]),
        source_type: String(r["source_type"]),
        title: String(r["title"]),
        source_url: String(r["source_url"] ?? ""),
        authority: String(r["authority"]),
        lang: String(r["lang"]),
        last_modified: String(r["last_modified"] ?? ""),
        rel_path: String(r["rel_path"]),
        ordinal: Number(r["ordinal"]),
        heading_path: String(r["heading_path"]),
        content: String(r["content"]),
        text: String(r["text"]),
      },
    }));
  }

  /** Fetch rows by chunk id (used to hydrate BM25 hits that the vector search did not return). */
  async getByIds(ids: string[]): Promise<Map<string, Omit<StoredChunk, "vector">>> {
    const out = new Map<string, Omit<StoredChunk, "vector">>();
    if (!this.table || !ids.length) return out;
    for (let i = 0; i < ids.length; i += 200) {
      const slice = ids.slice(i, i + 200);
      const rows = (await this.table
        .query()
        .where(`id IN (${slice.map(sqlString).join(", ")})`)
        .select([
          "id",
          "source_id",
          "source_type",
          "title",
          "source_url",
          "authority",
          "lang",
          "last_modified",
          "rel_path",
          "ordinal",
          "heading_path",
          "content",
          "text",
        ])
        .limit(slice.length)
        .toArray()) as Array<Record<string, unknown>>;
      for (const r of rows) {
        out.set(String(r["id"]), {
          id: String(r["id"]),
          source_id: String(r["source_id"]),
          source_type: String(r["source_type"]),
          title: String(r["title"]),
          source_url: String(r["source_url"] ?? ""),
          authority: String(r["authority"]),
          lang: String(r["lang"]),
          last_modified: String(r["last_modified"] ?? ""),
          rel_path: String(r["rel_path"]),
          ordinal: Number(r["ordinal"]),
          heading_path: String(r["heading_path"]),
          content: String(r["content"]),
          text: String(r["text"]),
        });
      }
    }
    return out;
  }

  /** Stream every row's index text (used to rebuild the BM25 index after ingest). */
  async *scanForKeywordIndex(): AsyncGenerator<{
    id: string;
    text: string;
    source_type: string;
    authority: string;
    lang: string;
  }> {
    if (!this.table) return;
    const batches = this.table.query().select(["id", "text", "source_type", "authority", "lang"]);
    for await (const batch of batches) {
      for (const r of batch.toArray() as Array<Record<string, unknown>>) {
        yield {
          id: String(r["id"]),
          text: String(r["text"]),
          source_type: String(r["source_type"]),
          authority: String(r["authority"]),
          lang: String(r["lang"]),
        };
      }
    }
  }

  /** Stream every row with its vector and display metadata (used by `npm run map`). */
  async *scanForMap(): AsyncGenerator<{
    id: string;
    source_id: string;
    source_type: string;
    title: string;
    source_url: string;
    authority: string;
    lang: string;
    rel_path: string;
    ordinal: number;
    heading_path: string;
    vector: Float32Array;
  }> {
    if (!this.table) return;
    const batches = this.table
      .query()
      .select(["id", "source_id", "source_type", "title", "source_url", "authority", "lang", "rel_path", "ordinal", "heading_path", "vector"]);
    for await (const batch of batches) {
      for (const r of batch.toArray() as Array<Record<string, unknown>>) {
        const vec = r["vector"] as { toArray?: () => ArrayLike<number> } | ArrayLike<number>;
        const arr = typeof (vec as { toArray?: unknown }).toArray === "function" ? (vec as { toArray: () => ArrayLike<number> }).toArray() : (vec as ArrayLike<number>);
        yield {
          id: String(r["id"]),
          source_id: String(r["source_id"]),
          source_type: String(r["source_type"]),
          title: String(r["title"]),
          source_url: String(r["source_url"] ?? ""),
          authority: String(r["authority"]),
          lang: String(r["lang"]),
          rel_path: String(r["rel_path"]),
          ordinal: Number(r["ordinal"]),
          heading_path: String(r["heading_path"]),
          vector: arr instanceof Float32Array ? arr : Float32Array.from(arr as ArrayLike<number>),
        };
      }
    }
  }

  /** Distinct values for a column (used by the UI filter dropdowns and `doctor`). */
  async distinct(column: "source_type" | "authority" | "lang"): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    if (!this.table) return counts;
    const rows = (await this.table.query().select([column]).toArray()) as Array<Record<string, unknown>>;
    for (const r of rows) {
      const v = String(r[column]);
      counts[v] = (counts[v] ?? 0) + 1;
    }
    return counts;
  }
}
