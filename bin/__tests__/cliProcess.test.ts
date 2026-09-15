import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface JsonTrace {
  dataset: string;
  summary?: { rows: number };
  events?: unknown[];
}

describe('QueryLens CLI process execution (bin/querylens.ts)', () => {
  const root = resolve(import.meta.dirname, '../..');
  const cliPath = resolve(root, 'bin/querylens.ts');

  function runCli(args: string[]) {
    return spawnSync(
      process.execPath,
      ['--experimental-strip-types', cliPath, ...args],
      {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1' },
      }
    );
  }

  it('prints usage instructions and exits with 0 on --help', () => {
    const res = runCli(['--help']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Usage:');
    expect(res.stdout).toContain('querylens "<SQL>"');
    expect(res.stdout).toContain('--policy');
    expect(res.stdout).toContain('--dataset');
    expect(res.stdout).toContain('--json');
  });

  it('prints usage instructions and exits with 0 on -h', () => {
    const res = runCli(['-h']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('Usage:');
    expect(res.stdout).toContain('querylens "<SQL>"');
  });

  it('executes a point lookup query and returns human-readable trace', () => {
    const res = runCli(['SELECT * FROM users WHERE id = 5']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('index-selection');
    expect(res.stdout).toContain('1 row returned');
    expect(res.stdout).toContain('stages');
  });

  it('supports the --policy clock option', () => {
    const res = runCli(['SELECT * FROM users WHERE id = 5', '--policy', 'clock']);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('clock');
  });

  it('outputs valid JSON formatted traces when --json flag is provided', () => {
    const res = runCli(['SELECT * FROM orders WHERE id = 1', '--dataset', 'orders', '--json']);
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout) as JsonTrace;
    expect(parsed.dataset).toBe('orders');
    expect(parsed.summary?.rows).toBe(1);
    expect(Array.isArray(parsed.events)).toBe(true);
    expect(parsed.events?.length).toBeGreaterThan(0);
  });


  it('exits with code 1 when the SQL query fails validation', () => {
    const res = runCli(['SELECT * FROM users WHERE invalid_column = 999']);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/error\s+`users` has no column/);
  });

  it('exits with code 2 on invalid CLI arguments', () => {
    const res = runCli(['SELECT 1', '--unknown-option']);
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('Unknown option');
  });
});
