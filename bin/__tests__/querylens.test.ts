import { describe, expect, it } from 'vitest';
import { main, parseArgs, renderJson } from '../querylens.ts';
import { runQuery, DATASETS, DEFAULT_ENGINE_OPTIONS } from '../../src/engine/index.ts';

interface JsonOut {
  dataset: string;
  summary?: { rows: number };
  events?: unknown[];
  error?: { message: string };
}
const parse = (s: string): JsonOut => JSON.parse(s) as JsonOut;

describe('parseArgs', () => {
  it('takes the query as a single positional and defaults the rest', () => {
    const r = parseArgs(['SELECT * FROM users']);
    expect(r).toEqual({
      kind: 'run',
      options: { sql: 'SELECT * FROM users', policy: 'lru', dataset: 'users', json: false, color: false },
    });
  });

  it('reads --policy, --dataset and --json', () => {
    const r = parseArgs(['SELECT 1', '--policy', 'clock', '--dataset', 'orders', '--json']);
    expect(r.kind).toBe('run');
    if (r.kind === 'run') {
      expect(r.options.policy).toBe('clock');
      expect(r.options.dataset).toBe('orders');
      expect(r.options.json).toBe(true);
    }
  });

  it('shows help for --help or no args', () => {
    expect(parseArgs([]).kind).toBe('help');
    expect(parseArgs(['-h']).kind).toBe('help');
    expect(parseArgs(['SELECT 1', '--help']).kind).toBe('help');
  });

  it('rejects an unknown policy, dataset, flag or a second positional', () => {
    expect(parseArgs(['q', '--policy', 'mru']).kind).toBe('error');
    expect(parseArgs(['q', '--dataset', 'lineitem']).kind).toBe('error');
    expect(parseArgs(['q', '--wat']).kind).toBe('error');
    expect(parseArgs(['one', 'two']).kind).toBe('error');
    expect(parseArgs(['q', '--policy']).kind).toBe('error');
  });

  it('colours only for a TTY without NO_COLOR', () => {
    const opts = (isTTY: boolean, env: Record<string, string | undefined>) => {
      const r = parseArgs(['q'], env, isTTY);
      return r.kind === 'run' && r.options.color;
    };
    expect(opts(true, {})).toBe(true);
    expect(opts(true, { NO_COLOR: '1' })).toBe(false);
    expect(opts(false, {})).toBe(false);
  });
});

describe('renderJson', () => {
  it('carries the run and a summary for a good query', () => {
    const opts = { sql: 'SELECT * FROM users WHERE id = 5', policy: 'lru' as const, dataset: 'users' as const, json: true, color: false };
    const result = runQuery(opts.sql, DATASETS.users.make(), { ...DEFAULT_ENGINE_OPTIONS });
    const parsed = parse(renderJson(opts, result));
    expect(parsed.dataset).toBe('users');
    expect(parsed.summary?.rows).toBe(1);
    expect(parsed.events?.length).toBe(result.events.length);
    expect(parsed).not.toHaveProperty('error');
  });

  it('carries the error and nothing else for a bad query', () => {
    const opts = { sql: 'SELECT * FROM users WHERE nope = 1', policy: 'lru' as const, dataset: 'users' as const, json: true, color: false };
    const result = runQuery(opts.sql, DATASETS.users.make(), { ...DEFAULT_ENGINE_OPTIONS });
    const parsed = parse(renderJson(opts, result));
    expect(parsed.error?.message).toMatch(/no column called/);
    expect(parsed).not.toHaveProperty('events');
  });
});

describe('main', () => {
  const capture = (argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = main(argv, (s) => out.push(s), (s) => err.push(s));
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('exits 0 and prints a text trace for a good query', () => {
    const { code, out } = capture(['SELECT * FROM users WHERE id = 5']);
    expect(code).toBe(0);
    expect(out).toContain('8 stages');
    expect(out).toContain('index-selection');
    expect(out).not.toContain('\x1b['); // no colour off a non-TTY test stream
  });

  it('exits 1 on a query error but still prints', () => {
    const { code, out } = capture(['SELECT * FROM users WHERE nope = 1']);
    expect(code).toBe(1);
    expect(out).toMatch(/error\s+`users` has no column/);
  });

  it('exits 2 on a usage error, writing to stderr', () => {
    const { code, out, err } = capture(['q', '--policy', 'nope']);
    expect(code).toBe(2);
    expect(out).toBe('');
    expect(err).toMatch(/Unknown policy/);
  });

  it('runs the orders dataset with a JSON body', () => {
    const { code, out } = capture(['SELECT * FROM orders WHERE id = 1', '--dataset', 'orders', '--json']);
    expect(code).toBe(0);
    const parsed = parse(out);
    expect(parsed.dataset).toBe('orders');
    expect(parsed.summary?.rows).toBe(1);
  });
});
