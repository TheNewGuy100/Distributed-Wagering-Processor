import { Injectable } from '@nestjs/common';

type Labels = Record<string, string>;

export const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

const labelStr = (labels?: Labels, extra?: Labels): string => {
  const all = { ...labels, ...extra };
  const parts = Object.entries(all)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
};

interface Histogram {
  bucketCounts: number[];
  sum: number;
  count: number;
}

type GaugeSample = { value: number; labels?: Labels };

/** Minimal in-process metrics registry rendered in Prometheus text exposition format. */
@Injectable()
export class MetricsService {
  private readonly help = new Map<string, string>();
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly histograms = new Map<string, Map<string, Histogram>>();
  private readonly gauges = new Map<string, () => Promise<GaugeSample[]> | GaugeSample[]>();

  describe(name: string, help: string): void {
    this.help.set(name, help);
  }

  inc(name: string, labels?: Labels, by = 1): void {
    const series = this.counters.get(name) ?? this.counters.set(name, new Map()).get(name)!;
    const k = labelStr(labels);
    series.set(k, (series.get(k) ?? 0) + by);
  }

  /** Current value of one counter series (0 when never incremented). */
  get(name: string, labels?: Labels): number {
    return this.counters.get(name)?.get(labelStr(labels)) ?? 0;
  }

  /** Sum across all label combinations of a counter. */
  total(name: string): number {
    let sum = 0;
    for (const v of this.counters.get(name)?.values() ?? []) sum += v;
    return sum;
  }

  observe(name: string, seconds: number, labels?: Labels): void {
    const series = this.histograms.get(name) ?? this.histograms.set(name, new Map()).get(name)!;
    const k = labelStr(labels);
    const h =
      series.get(k) ??
      series.set(k, { bucketCounts: new Array(LATENCY_BUCKETS.length).fill(0) as number[], sum: 0, count: 0 }).get(k)!;
    LATENCY_BUCKETS.forEach((le, i) => {
      if (seconds <= le) h.bucketCounts[i]! += 1;
    });
    h.sum += seconds;
    h.count += 1;
  }

  histogramCount(name: string, labels?: Labels): number {
    return this.histograms.get(name)?.get(labelStr(labels))?.count ?? 0;
  }

  /** Gauge computed at scrape time (e.g. outbox lag read from the database). */
  gauge(name: string, help: string, sample: () => Promise<GaugeSample[]> | GaugeSample[]): void {
    this.help.set(name, help);
    this.gauges.set(name, sample);
  }

  async render(): Promise<string> {
    const out: string[] = [];
    const header = (name: string, type: string) => {
      const h = this.help.get(name);
      if (h) out.push(`# HELP ${name} ${h}`);
      out.push(`# TYPE ${name} ${type}`);
    };
    const sorted = <T>(m: Map<string, T>) => [...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    for (const [name, series] of sorted(this.counters)) {
      header(name, 'counter');
      for (const [k, v] of sorted(series)) out.push(`${name}${k} ${v}`);
    }
    for (const [name, series] of sorted(this.histograms)) {
      header(name, 'histogram');
      for (const [k, h] of sorted(series)) {
        const base = k === '' ? {} : Object.fromEntries([...k.matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1]!, m[2]!]));
        LATENCY_BUCKETS.forEach((le, i) => out.push(`${name}_bucket${labelStr(base, { le: String(le) })} ${h.bucketCounts[i]}`));
        out.push(`${name}_bucket${labelStr(base, { le: '+Inf' })} ${h.count}`);
        out.push(`${name}_sum${k} ${h.sum}`);
        out.push(`${name}_count${k} ${h.count}`);
      }
    }
    for (const [name, fn] of sorted(this.gauges)) {
      header(name, 'gauge');
      try {
        for (const s of await fn()) out.push(`${name}${labelStr(s.labels)} ${s.value}`);
      } catch {
        out.push(`# gauge ${name} unavailable`);
      }
    }
    return out.join('\n') + '\n';
  }
}
