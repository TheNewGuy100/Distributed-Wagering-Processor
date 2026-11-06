// Checks every query of the provisioned Grafana dashboard, so a typo shows up here and not as a blank panel:
//
//   1. each metric a query mentions must exist in the application source (catches typos even where the query
//      falls back to zero with `or vector(0)`, which would otherwise hide them behind a flat line);
//   2. each query must be accepted by Prometheus, and, unless it has the zero fallback (counters that have not fired
//      yet have no series), must return data.
//
//   node docker/grafana/check-queries.mjs            (Prometheus on http://localhost:9090, i.e. the compose stack)
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const prometheus = process.env.PROMETHEUS_URL ?? 'http://localhost:9090';
const root = fileURLToPath(new URL('../../', import.meta.url));
const dashboard = JSON.parse(readFileSync(new URL('./dashboards/wagering.json', import.meta.url), 'utf8'));

// Every snake_case string literal in src/ is a candidate metric name (they are all passed as literals to inc/observe/gauge).
const known = new Set();
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) {
      for (const m of readFileSync(path, 'utf8').matchAll(/['"]([a-z][a-z0-9]*(?:_[a-z0-9]+)+)['"]/g)) known.add(m[1]);
    }
  }
};
walk(join(root, 'src'));

const PROMQL_WORDS = new Set(['sum', 'max', 'min', 'avg', 'rate', 'increase', 'by', 'without', 'or', 'on', 'vector', 'histogram_quantile', 'le']);
const metricsIn = (expr) =>
  [...expr.replace(/"[^"]*"/g, '').replace(/\{[^}]*\}/g, '').replace(/by\s*\([^)]*\)/g, '').matchAll(/[a-zA-Z_:][a-zA-Z0-9_:]*/g)]
    .map((m) => m[0])
    .filter((w) => w.includes('_') && !PROMQL_WORDS.has(w));

const failures = [];
let checked = 0;
for (const panel of dashboard.panels) {
  for (const target of panel.targets) {
    checked++;
    for (const word of metricsIn(target.expr)) {
      const name = word.replace(/_(bucket|sum|count)$/, '');
      if (!known.has(name)) failures.push(`${panel.title}: unknown metric "${word}" (not found in src/)`);
    }
    const res = await fetch(`${prometheus}/api/v1/query?query=${encodeURIComponent(target.expr)}`);
    const body = await res.json();
    if (body.status !== 'success') failures.push(`${panel.title}: rejected by Prometheus (${body.error})`);
    else if (body.data.result.length === 0 && !target.expr.includes('vector(0)')) {
      failures.push(`${panel.title}: no data yet for ${target.expr}`);
    }
  }
}

console.log(`${checked} dashboard queries checked`);
if (failures.length > 0) {
  console.error(failures.map((f) => `  FAIL ${f}`).join('\n'));
  process.exit(1);
}
