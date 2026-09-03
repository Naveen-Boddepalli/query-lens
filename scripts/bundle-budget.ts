/**
 * A gzip budget for `dist/`, checked in CI (plan.md §14.2).
 *
 * The point is not the numbers, it is that they cannot drift silently. A bundle
 * grows one import at a time and nobody notices until the lecture-hall laptop
 * on hotel wifi does — which is the audience §14 question 7 is about.
 *
 * Budgets are set a little above the current size: tight enough that adding a
 * dependency shows up here, loose enough that a normal change does not fail the
 * build. Raising one is a deliberate act with a diff, which is the whole idea.
 *
 * Run: pnpm budget   (after pnpm build)
 */
import { gzipSync } from 'node:zlib';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = 'dist/assets';

/** Matched against the chunk name; the first match wins. */
const BUDGETS: { name: string; test: RegExp; kb: number; note: string }[] = [
  { name: 'codemirror', test: /^codemirror-/, kb: 128, note: 'SQL editor, needed at first paint' },
  { name: 'flow', test: /^flow-.*\.js$/, kb: 70, note: 'React Flow + d3-hierarchy' },
  { name: 'react', test: /^react-/, kb: 62, note: 'react + react-dom' },
  { name: 'app', test: /^index-.*\.js$/, kb: 34, note: 'engine + UI — the only chunk most commits touch' },
  { name: 'css', test: /\.css$/, kb: 14, note: "Tailwind's output plus React Flow's stylesheet" },
  { name: 'runtime', test: /^rolldown-runtime-/, kb: 2, note: 'module loader emitted by rolldown' },
];

/** Everything together, so a chunk moving between groups cannot hide growth. */
const TOTAL_KB = 300;

const gzipKb = (bytes: Buffer): number => gzipSync(bytes, { level: 9 }).length / 1024;

let total = 0;
const failures: string[] = [];
const unbudgeted: string[] = [];

// Summed per group, not per file: two stylesheets that each fit the CSS budget
// but together do not is exactly the drift this is meant to catch.
const measured = new Map<string, number>(BUDGETS.map((b) => [b.name, 0]));

for (const file of readdirSync(DIST).sort()) {
  const size = gzipKb(readFileSync(join(DIST, file)));
  total += size;

  const budget = BUDGETS.find((b) => b.test.test(file));
  if (!budget) {
    // A new chunk with no budget is not a pass — it is a gap in this file.
    if (size > 1) unbudgeted.push(`${file} (${size.toFixed(1)} kB)`);
    continue;
  }
  measured.set(budget.name, (measured.get(budget.name) ?? 0) + size);
}

for (const budget of BUDGETS) {
  const size = measured.get(budget.name) ?? 0;
  const over = size > budget.kb;
  console.log(
    `${over ? '✗' : '✓'} ${budget.name.padEnd(11)} ${size.toFixed(1).padStart(7)} kB / ${String(budget.kb).padStart(4)} kB  ${budget.note}`,
  );
  if (over) {
    failures.push(
      `${budget.name} is ${size.toFixed(1)} kB gzip, over its ${String(budget.kb)} kB budget`,
    );
  }
}
console.log(
  `${total > TOTAL_KB ? '✗' : '✓'} ${'total'.padEnd(11)} ${total.toFixed(1).padStart(7)} kB / ${String(TOTAL_KB).padStart(4)} kB`,
);

if (total > TOTAL_KB) {
  failures.push(`total is ${total.toFixed(1)} kB gzip, over the ${String(TOTAL_KB)} kB budget`);
}
if (unbudgeted.length > 0) {
  failures.push(`unbudgeted chunk(s): ${unbudgeted.join(', ')} — add them to scripts/bundle-budget.ts`);
}

if (failures.length > 0) {
  console.error(`\nBundle budget exceeded:\n${failures.map((f) => `  - ${f}`).join('\n')}`);
  console.error('\nEither shrink it or raise the budget deliberately, in a commit that says why.');
  process.exit(1);
}

console.log('\nWithin budget.');
