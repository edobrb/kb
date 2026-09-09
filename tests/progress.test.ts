import { describe, expect, it } from "vitest";
import { RateTracker, createProgressRenderer, formatDuration, formatEndTime, type IngestProgress } from "../src/ingest/progress.js";

describe("formatDuration", () => {
  it("uses at most two units", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(125_000)).toBe("2m 05s");
    expect(formatDuration(3_845_000)).toBe("1h 04m");
    expect(formatDuration(0)).toBe("0s");
  });
  it("survives nonsense input", () => {
    expect(formatDuration(Number.NaN)).toBe("?");
    expect(formatDuration(-1)).toBe("?");
  });
});

describe("formatEndTime", () => {
  it("adds the eta to the current clock", () => {
    expect(formatEndTime(90 * 60_000, new Date("2026-09-09T10:05:00"))).toBe("11:35");
  });
});

describe("RateTracker", () => {
  it("returns 0 until it has two samples", () => {
    const r = new RateTracker();
    expect(r.perSecond()).toBe(0);
    r.add(0, 1_000);
    expect(r.perSecond()).toBe(0);
    expect(r.etaMs(100)).toBeNull();
  });

  it("computes throughput and eta", () => {
    const r = new RateTracker();
    r.add(0, 0);
    r.add(100, 10_000); // 10 chunks/s
    expect(r.perSecond()).toBe(10);
    expect(r.etaMs(50)).toBe(5_000);
  });

  it("tracks the recent window, so a slow start does not skew the eta", () => {
    const r = new RateTracker(60_000);
    // A very slow first minute: 10 chunks in 60 s.
    r.add(0, 0);
    r.add(10, 60_000);
    expect(r.perSecond()).toBeCloseTo(10 / 60, 3);
    // Then it speeds up to 20 chunks/s; the old slow samples fall out of the window.
    for (let i = 1; i <= 6; i++) r.add(10 + i * 200, 60_000 + i * 10_000);
    expect(r.perSecond()).toBeCloseTo(20, 1);
  });

  it("never reports a negative or infinite rate", () => {
    const r = new RateTracker();
    r.add(50, 1_000);
    r.add(50, 2_000); // no progress
    expect(r.perSecond()).toBe(0);
    expect(r.etaMs(10)).toBeNull();
  });
});

const sample: IngestProgress = {
  phase: "embedding",
  docsDone: 250,
  docsTotal: 1_000,
  chunksDone: 2_500,
  chunksTotal: 10_000,
  elapsedMs: 125_000,
  chunksPerSec: 20,
  etaMs: 375_000,
  currentPath: "confluence/CTO/1-x.md",
};

describe("progress renderer", () => {
  it("formats percentage, counts, rate and eta", () => {
    const out: string[] = [];
    const r = createProgressRenderer({ interactive: false, write: (s) => out.push(s), minIntervalMs: 0, now: () => 0 });
    const line = r.format(sample);
    expect(line).toContain("25%");
    expect(line).toContain("2,500/10,000 chunks");
    expect(line).toContain("250/1,000 docs");
    expect(line).toContain("20.0 chunk/s");
    expect(line).toContain("elapsed 2m 05s");
    expect(line).toContain("ETA 6m 15s");
  });

  it("says measuring while there is no rate yet", () => {
    const r = createProgressRenderer({ interactive: false, write: () => {}, now: () => 0 });
    expect(r.format({ ...sample, chunksPerSec: 0, etaMs: null })).toContain("measuring");
    expect(r.format({ ...sample, chunksPerSec: 0, etaMs: null })).not.toContain("ETA");
  });

  it("rewrites one line when interactive and appends lines when piped", () => {
    const tty: string[] = [];
    const piped: string[] = [];
    const a = createProgressRenderer({ interactive: true, write: (s) => tty.push(s), minIntervalMs: 0, now: () => 0 });
    const b = createProgressRenderer({ interactive: false, write: (s) => piped.push(s), minIntervalMs: 0, now: () => 0 });
    a.update(sample);
    b.update(sample);
    expect(tty[0]?.startsWith("\r[2K")).toBe(true);
    expect(tty[0]?.endsWith("\n")).toBe(false);
    expect(piped[0]?.endsWith("\n")).toBe(true);
    expect(piped[0]?.includes("\r")).toBe(false);
  });

  it("throttles redraws but honours force", () => {
    const out: string[] = [];
    let t = 0;
    const r = createProgressRenderer({ interactive: true, write: (s) => out.push(s), minIntervalMs: 250, now: () => t });
    r.update(sample);
    expect(out).toHaveLength(1);
    t = 100;
    r.update(sample);
    expect(out).toHaveLength(1); // too soon
    t = 400;
    r.update(sample);
    expect(out).toHaveLength(2);
    t = 420;
    r.update(sample, true); // forced
    expect(out).toHaveLength(3);
  });

  it("finish closes the line only when one is pending", () => {
    const out: string[] = [];
    const r = createProgressRenderer({ interactive: true, write: (s) => out.push(s), minIntervalMs: 0, now: () => 0 });
    r.finish();
    expect(out).toHaveLength(0); // nothing drawn yet
    r.update(sample);
    r.finish();
    expect(out.at(-1)).toBe("\n");
    r.finish();
    expect(out.filter((s) => s === "\n")).toHaveLength(1); // not repeated
  });

  it("truncates to the terminal width", () => {
    const r = createProgressRenderer({ interactive: true, write: () => {}, columns: 40, now: () => 0 });
    const line = r.format(sample);
    expect(line.length).toBeLessThanOrEqual(39);
    expect(line.endsWith("…")).toBe(true);
  });
});
