import { describe, expect, it } from "vitest";
import {
  buildMap,
  cosineDistance,
  excerptOf,
  gridLabels,
  groupOf,
  kmeansCosine,
  nameGroups,
  normalize,
  RandomProjector,
  randomProject,
  seededRandom,
  splitWords,
  tokenizeLabel,
  type MapInputRow,
} from "../src/viz/map.js";

function row(i: number, vector: number[] | Float32Array, relPath = `confluence/SPACE/${i}.md`, title = `Doc ${Math.floor(i / 3)}`): MapInputRow {
  return {
    id: `doc${Math.floor(i / 3)}::${i % 3}`,
    source_id: `doc${Math.floor(i / 3)}`,
    source_type: "confluence",
    title,
    source_url: "https://example.test/p",
    authority: "descriptive",
    lang: "it",
    rel_path: relPath,
    ordinal: i % 3,
    heading_path: `Doc > H${i}`,
    vector,
  };
}

/** Two well-separated groups of unit vectors, plus their titles. */
function twoClusters(n = 40, dims = 32, seed = 11) {
  const rand = seededRandom(seed);
  const rows: MapInputRow[] = [];
  for (let i = 0; i < n; i++) {
    const first = i < n / 2;
    const v = Array.from({ length: dims }, (_, d) => (d < dims / 2 ? (first ? 1 : 0) : first ? 0 : 1) + (rand() - 0.5) * 0.2);
    rows.push(
      row(i, v, first ? `confluence/A/${i}.md` : `gitlab/b/x/${i}.md`, first ? "Kubernetes deploy cluster" : "Fattura elettronica SDI"),
    );
  }
  return rows;
}

describe("groupOf", () => {
  it("uses the first two path segments when there are enough", () => {
    expect(groupOf("confluence/TPAAS/80577979-senders.md", "confluence")).toBe("confluence/TPAAS");
    expect(groupOf("gitlab/paas/platform/apigateway/README.md", "git-md")).toBe("gitlab/paas");
  });
  it("falls back to the top folder or the source type", () => {
    expect(groupOf("manually-curated/glossary.md", "manually-curated")).toBe("manually-curated");
    expect(groupOf("", "adr")).toBe("adr");
  });
});

describe("excerptOf", () => {
  it("collapses whitespace and truncates with an ellipsis", () => {
    expect(excerptOf("a  b\n\nc")).toBe("a b c");
    const long = excerptOf("x".repeat(500));
    expect(long.length).toBe(200);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("vector helpers", () => {
  it("seededRandom is deterministic and in [0, 1)", () => {
    const a = seededRandom(7), b = seededRandom(7);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
  it("normalize gives unit vectors and cosineDistance is 0 for identical, ~1 for orthogonal", () => {
    const a = normalize([3, 4]);
    expect(Math.hypot(a[0] as number, a[1] as number)).toBeCloseTo(1);
    expect(cosineDistance(a, a)).toBeCloseTo(0);
    expect(cosineDistance(normalize([1, 0]), normalize([0, 1]))).toBeCloseTo(1);
  });
  it("randomProject roughly preserves cosine similarity", () => {
    const rand = seededRandom(3);
    const base = Array.from({ length: 512 }, () => rand() - 0.5);
    const near = base.map((v) => v + (rand() - 0.5) * 0.1);
    const far = Array.from({ length: 512 }, () => rand() - 0.5);
    const [pb, pn, pf] = randomProject([base, near, far], 64, 1) as [Float32Array, Float32Array, Float32Array];
    expect(pb.length).toBe(64);
    expect(cosineDistance(pb, pn)).toBeLessThan(cosineDistance(pb, pf));
    expect(cosineDistance(pb, pn)).toBeLessThan(0.2);
  });
  it("RandomProjector is reusable, deterministic per seed, and emits unit vectors", () => {
    const v = Array.from({ length: 128 }, (_, i) => Math.sin(i));
    const a = new RandomProjector(128, 32, 5);
    const b = new RandomProjector(128, 32, 5);
    const c = new RandomProjector(128, 32, 6);
    const pa = a.project(v), pb = b.project(v), pc = c.project(v);
    expect([...pa]).toEqual([...pb]);
    expect([...pa]).not.toEqual([...pc]);
    expect(Math.hypot(...pa)).toBeCloseTo(1, 5);
    // The same instance projects many rows without drifting.
    expect([...a.project(v)]).toEqual([...pa]);
  });
});

describe("kmeansCosine", () => {
  it("separates two well-formed clusters and is deterministic", () => {
    const vectors = twoClusters(60, 16).map((r) => normalize(r.vector));
    const a = kmeansCosine(vectors, 2, 42);
    const b = kmeansCosine(vectors, 2, 42);
    expect([...a.assignments]).toEqual([...b.assignments]);
    expect(a.centroids).toHaveLength(2);
    const firstHalf = new Set([...a.assignments].slice(0, 30));
    const secondHalf = new Set([...a.assignments].slice(30));
    expect(firstHalf.size).toBe(1);
    expect(secondHalf.size).toBe(1);
    expect([...firstHalf][0]).not.toBe([...secondHalf][0]);
  });
  it("never asks for more clusters than it has points", () => {
    const vectors = [normalize([1, 0]), normalize([0, 1])];
    const { assignments, centroids } = kmeansCosine(vectors, 10, 1);
    expect(centroids.length).toBeLessThanOrEqual(2);
    expect(assignments).toHaveLength(2);
  });
});

describe("label naming", () => {
  it("drops stopwords, short tokens and bare numbers", () => {
    expect(tokenizeLabel("Il nuovo Team per la Documentazione 2026")).toEqual([]);
    expect(tokenizeLabel("Configurazione Wazuh agent")).toEqual(["configurazione", "wazuh", "agent"]);
  });
  it("picks the words that distinguish a group from the others", () => {
    const texts = ["kubernetes deploy pipeline", "kubernetes deploy rollout", "fattura elettronica SDI", "fattura elettronica xml"];
    const names = nameGroups([[0, 1], [2, 3]], texts, 2);
    expect(names[0]).toMatch(/kubernetes|deploy/i);
    expect(names[1]).toMatch(/fattura|elettronica/i);
    expect(names[0]).not.toMatch(/fattura/i);
  });
  it("keeps the usual spelling of acronyms", () => {
    const texts = ["TSID authentication token", "TSID refresh token"];
    expect(nameGroups([[0, 1]], texts, 1)[0]).toBe("TSID");
  });
  it("gridLabels names dense bins and skips sparse ones", () => {
    const xs: number[] = [], ys: number[] = [], texts: string[] = [];
    for (let i = 0; i < 20; i++) { xs.push(0.01 * i); ys.push(0.01 * i); texts.push("wazuh agent configurazione"); }
    xs.push(100); ys.push(100); texts.push("lonely outlier page");   // its own bin, below minPoints
    const labels = gridLabels(xs, ys, texts, { cellsPerAxis: 4, level: 1, minPoints: 5 });
    expect(labels.length).toBe(1);
    expect(labels[0]!.text).toMatch(/wazuh|agent|configurazione/i);
    expect(labels[0]!.n).toBe(20);
    expect(labels[0]!.level).toBe(1);
  });
});

describe("buildMap", () => {
  it("projects two separated clusters apart and labels them", async () => {
    const rows = twoClusters(40, 32);
    const phases: string[] = [];
    const map = await buildMap(rows, {
      embeddingModel: "mock",
      dimensions: 32,
      params: { nEpochs: 100, projectDims: 0, nNeighbors: 5, clusters: 2 },
      onProgress: (p) => phases.push(p.phase),
    });

    expect(map.version).toBe(2);
    expect(map.chunks).toBe(40);
    expect(map.docs).toBe(14);
    expect(map.points.x).toHaveLength(40);
    expect(map.points.cl).toHaveLength(40);
    expect(phases[0]).toBe("project");
    expect(phases).toContain("cluster");
    expect(phases).toContain("umap");
    expect(phases).toContain("labels");

    // Metadata is stored once per document and referenced by index, not repeated per chunk.
    expect(map.documents).toHaveLength(14);
    expect(map.dict.groups.sort()).toEqual(["confluence/A", "gitlab/b"]);
    expect(map.documents.every((d) => d.g >= 0 && d.g < map.dict.groups.length)).toBe(true);
    expect(JSON.stringify(map)).not.toContain("excerpt");

    // The two semantic clusters line up with the two vector groups.
    expect(map.clusters).toHaveLength(2);
    const clusterOfFirst = new Set(map.points.cl.slice(0, 20));
    const clusterOfSecond = new Set(map.points.cl.slice(20));
    expect(clusterOfFirst.size).toBe(1);
    expect(clusterOfSecond.size).toBe(1);
    expect([...clusterOfFirst][0]).not.toBe([...clusterOfSecond][0]);
    expect(map.clusters.map((c) => c.name).join(" ")).toMatch(/Kubernetes|Fattura/i);
    expect(map.clusters.reduce((s, c) => s + c.n, 0)).toBe(40);

    // Every cluster gets a level-0 label at its centroid.
    expect(map.labels.filter((l) => l.level === 0)).toHaveLength(2);

    // 2-D layout: within-cluster spread is much smaller than the gap between the clusters.
    const pts = map.points.x.map((x, i) => ({ x, y: map.points.y[i] as number }));
    const centre = (ps: typeof pts) => ({ x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: ps.reduce((s, p) => s + p.y, 0) / ps.length });
    const spread = (ps: typeof pts, c: { x: number; y: number }) => ps.reduce((s, p) => s + Math.hypot(p.x - c.x, p.y - c.y), 0) / ps.length;
    const a = pts.slice(0, 20), b = pts.slice(20);
    const ca = centre(a), cb = centre(b);
    expect(Math.hypot(ca.x - cb.x, ca.y - cb.y)).toBeGreaterThan(Math.max(spread(a, ca), spread(b, cb)) * 2);
  });

  it("accepts vectors the caller already projected", async () => {
    const rows = twoClusters(24, 64);
    const p = new RandomProjector(64, 16, 42);
    const pre = rows.map((r) => ({ ...r, vector: p.project(r.vector) }));
    const map = await buildMap(pre, {
      embeddingModel: "m",
      dimensions: 64,
      preProjected: true,
      params: { nEpochs: 40, nNeighbors: 5, clusters: 2, projectDims: 16 },
    });
    expect(map.points.x).toHaveLength(24);
    // The reported params still describe how the vectors were prepared.
    expect(map.params.projectDims).toBe(16);
  });

  it("ignores undefined param overrides", async () => {
    const rows = twoClusters(12, 8);
    const map = await buildMap(rows, {
      embeddingModel: "m",
      dimensions: 8,
      params: { nNeighbors: undefined, nEpochs: 20, projectDims: undefined, seed: undefined, clusters: undefined },
    });
    expect(map.params.seed).toBe(42);
    expect(map.params.projectDims).toBe(256);
    expect(map.params.clusters).toBe(8);
  });

  it("clamps nNeighbors for tiny inputs and rejects fewer than 4 rows", async () => {
    await expect(buildMap([row(0, [1, 0])], { embeddingModel: "m", dimensions: 2 })).rejects.toThrow(/at least 4/);
    const rows = [row(0, [1, 0, 0]), row(1, [0, 1, 0]), row(2, [0, 0, 1]), row(3, [1, 1, 0]), row(4, [0, 1, 1])];
    const map = await buildMap(rows, { embeddingModel: "m", dimensions: 3, params: { nEpochs: 20, clusters: 2 } });
    expect(map.params.nNeighbors).toBe(4);
    expect(map.points.x).toHaveLength(5);
  });
});

describe("token filtering", () => {
  it("splits glued words and acronym-plus-word", () => {
    expect(splitWords("VEICRequisiti")).toBe("VEIC Requisiti");
    expect(splitWords("openTelemetryTrace")).toBe("open Telemetry Trace");
    expect(splitWords("Analisi Funzionale")).toBe("Analisi Funzionale");
  });
  it("rejects internal identifiers but keeps versioned technical terms", () => {
    expect(tokenizeLabel("WI7EBDETTGRPMEN")).toEqual([]);
    expect(tokenizeLabel("WI7_EBDETTGRPMEN")).toEqual([]);
    expect(tokenizeLabel("WI45 x1 cg4")).toEqual([]);
    // "s3" is already below the three-character minimum; longer versioned terms survive.
    expect(tokenizeLabel("bucket s3 oauth2 rfc9457 Outlook365")).toEqual(["bucket", "oauth2", "rfc9457", "outlook365"]);
    expect(tokenizeLabel("AKS TSC Terraform istanze")).toEqual(["aks", "tsc", "terraform", "istanze"]);
  });
});
