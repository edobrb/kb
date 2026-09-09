/** Progress reporting for long ingest runs: throughput, percentage and ETA. */

export interface IngestProgress {
  /** embedding = vectors for the chunk batches; indexing = BM25 rebuild over the whole table. */
  phase: "embedding" | "indexing";
  docsDone: number;
  docsTotal: number;
  chunksDone: number;
  chunksTotal: number;
  elapsedMs: number;
  /** Chunks per second over a recent window (not the whole run). */
  chunksPerSec: number;
  /** null until there is enough signal to extrapolate. */
  etaMs: number | null;
  /** Path of the document just finished, for context. */
  currentPath: string;
}

/** "1h 04m", "3m 20s", "45s". Always two significant units at most. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** Clock time when the run is expected to end, e.g. "18:42". */
export function formatEndTime(etaMs: number, now = new Date()): string {
  const end = new Date(now.getTime() + etaMs);
  return `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
}

/**
 * Tracks throughput over a sliding window so the ETA reacts to the actual current speed
 * instead of being dragged down by a slow start (model load, cold cache).
 */
export class RateTracker {
  private samples: { t: number; units: number }[] = [];

  constructor(
    private readonly windowMs = 60_000,
    private readonly minSamples = 2,
  ) {}

  add(units: number, now: number): void {
    this.samples.push({ t: now, units });
    const cutoff = now - this.windowMs;
    let drop = 0;
    while (drop < this.samples.length && (this.samples[drop] as { t: number }).t < cutoff) drop++;
    // Always keep two samples, otherwise a slow stream would have no interval to measure over.
    drop = Math.min(drop, Math.max(0, this.samples.length - 2));
    if (drop) this.samples.splice(0, drop);
  }

  /** Units per second, or 0 when not enough data. */
  perSecond(): number {
    if (this.samples.length < this.minSamples) return 0;
    const first = this.samples[0] as { t: number; units: number };
    const last = this.samples[this.samples.length - 1] as { t: number; units: number };
    const dt = last.t - first.t;
    const du = last.units - first.units;
    if (dt <= 0 || du <= 0) return 0;
    return (du / dt) * 1000;
  }

  etaMs(remaining: number): number | null {
    const rate = this.perSecond();
    if (rate <= 0 || remaining <= 0) return null;
    return (remaining / rate) * 1000;
  }
}

export interface RendererOptions {
  /** Overwrite one line with \r (interactive) instead of appending lines (piped/CI). */
  interactive: boolean;
  write: (s: string) => void;
  /** Minimum gap between redraws. Interactive default 250 ms, piped 15 s. */
  minIntervalMs?: number;
  /** Terminal width used to truncate the line; 0 disables truncation. */
  columns?: number;
  now?: () => number;
}

/** Renders `IngestProgress` as a single status line. */
export function createProgressRenderer(opts: RendererOptions) {
  const minInterval = opts.minIntervalMs ?? (opts.interactive ? 250 : 15_000);
  const now = opts.now ?? Date.now;
  let lastDraw = Number.NEGATIVE_INFINITY; // the first update must always draw
  let dirty = false;

  function format(p: IngestProgress): string {
    const pct = p.chunksTotal ? Math.floor((p.chunksDone / p.chunksTotal) * 100) : 100;
    const parts = [
      p.phase,
      `${String(pct).padStart(3)}%`,
      `${p.chunksDone.toLocaleString("en-US")}/${p.chunksTotal.toLocaleString("en-US")} chunks`,
      `${p.docsDone.toLocaleString("en-US")}/${p.docsTotal.toLocaleString("en-US")} docs`,
      p.chunksPerSec > 0 ? `${p.chunksPerSec.toFixed(1)} chunk/s` : "measuring…",
      `elapsed ${formatDuration(p.elapsedMs)}`,
    ];
    if (p.etaMs !== null) parts.push(`ETA ${formatDuration(p.etaMs)} (~${formatEndTime(p.etaMs, new Date(now()))})`);
    let line = `  ${parts.join(" · ")}`;
    const cols = opts.columns ?? 0;
    if (cols > 1 && line.length > cols - 1) line = `${line.slice(0, cols - 2)}…`;
    return line;
  }

  return {
    /** Draw unless the last draw was too recent; `force` bypasses the throttle. */
    update(p: IngestProgress, force = false): void {
      const t = now();
      if (!force && t - lastDraw < minInterval) return;
      lastDraw = t;
      const line = format(p);
      opts.write(opts.interactive ? `\r[2K${line}` : `${line}\n`);
      dirty = opts.interactive;
    },
    /** Terminate the status line so following output starts on a fresh row. */
    finish(): void {
      if (dirty) {
        opts.write("\n");
        dirty = false;
      }
    },
    format,
  };
}
