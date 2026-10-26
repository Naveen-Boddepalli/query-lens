import { describe, expect, it } from 'vitest';
import { createJoinDemoDatabase } from '../../engine/index.ts';
import type { Database } from '../../engine/index.ts';
import {
  parseWorkspaceFile,
  WORKSPACE_FORMAT,
  WORKSPACE_VERSION,
  workspaceFileText,
  workspaceNameProblem,
} from '../workspaces.ts';

describe('workspaceNameProblem', () => {
  it('asks for a name when there is none', () => {
    expect(workspaceNameProblem('')).toBe('Name the workspace.');
    expect(workspaceNameProblem('   ')).toBe('Name the workspace.');
  });

  it('accepts a name up to sixty characters, counted after trimming', () => {
    expect(workspaceNameProblem(`  ${'x'.repeat(60)}  `)).toBeNull();
    expect(workspaceNameProblem('x'.repeat(61))).toBe('Keep the name to 60 characters.');
  });
});

describe('workspace files', () => {
  it('round-trips a database and its trimmed name', () => {
    const db = createJoinDemoDatabase();
    expect(parseWorkspaceFile(workspaceFileText('  Lab  ', db))).toEqual({ ok: true, name: 'Lab', database: db });
  });

  it('refuses text that is not JSON', () => {
    const parsed = parseWorkspaceFile('{ not json');
    expect(parsed).toMatchObject({ ok: false });
    expect(parsed.ok === false && parsed.problem).toContain('not JSON');
  });

  it('refuses a file of another format', () => {
    const parsed = parseWorkspaceFile(JSON.stringify({ format: 'something-else', version: WORKSPACE_VERSION }));
    expect(parsed).toMatchObject({ ok: false });
    expect(parsed.ok === false && parsed.problem).toContain('not a QueryLens workspace');
  });

  it('refuses a version it does not read, and says which it does', () => {
    const file = JSON.parse(workspaceFileText('Lab', createJoinDemoDatabase())) as { version: number };
    const parsed = parseWorkspaceFile(JSON.stringify({ ...file, version: WORKSPACE_VERSION + 1 }));
    expect(parsed.ok === false && parsed.problem).toContain(`reads version ${String(WORKSPACE_VERSION)}`);
  });

  it('refuses a file with no usable name', () => {
    const file = JSON.parse(workspaceFileText('Lab', createJoinDemoDatabase())) as Record<string, unknown>;
    expect(parseWorkspaceFile(JSON.stringify({ ...file, name: '   ' }))).toMatchObject({ ok: false });
    expect(parseWorkspaceFile(JSON.stringify({ ...file, name: undefined }))).toMatchObject({ ok: false });
  });

  it('refuses the whole file when one table does not check out, rather than loading part of it', () => {
    const db = createJoinDemoDatabase();
    const broken: Database = {
      tables: { ...db.tables, authors: { ...db.tables.authors!, name: 'not-authors' } },
    };
    const parsed = parseWorkspaceFile(workspaceFileText('Lab', broken));
    expect(parsed.ok === false && parsed.problem).toContain('do not check out');
  });

  it('writes the format and version it reads back', () => {
    const file = JSON.parse(workspaceFileText('Lab', createJoinDemoDatabase())) as { format: string; version: number };
    expect(file).toMatchObject({ format: WORKSPACE_FORMAT, version: WORKSPACE_VERSION });
  });
});
