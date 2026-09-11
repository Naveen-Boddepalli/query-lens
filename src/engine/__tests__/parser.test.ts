import { describe, expect, it } from 'vitest';
import { parse } from '../parser/parser.ts';
import { toDisplayTree } from '../parser/display.ts';
import type { SelectStatement } from '../parser/ast.ts';

function ok(sql: string): SelectStatement {
  const out = parse(sql);
  if (!out.ok) throw new Error(`expected a parse, got: ${out.error.message}`);
  return out.ast;
}

function err(sql: string) {
  const out = parse(sql);
  if (out.ok) throw new Error('expected a parse error');
  return out.error;
}

describe('parse — the v0 subset', () => {
  it('parses SELECT * FROM t', () => {
    const ast = ok('SELECT * FROM users');
    expect(ast.select.kind).toBe('star');
    expect(ast.from.name).toBe('users');
    expect(ast.where).toBeUndefined();
  });

  it('parses a named column list', () => {
    const ast = ok('SELECT id, name FROM users');
    expect(ast.select.kind === 'columns' && ast.select.names.map((c) => c.name)).toEqual([
      'id',
      'name',
    ]);
  });

  it('parses a comparison predicate', () => {
    const ast = ok('SELECT * FROM users WHERE id = 5');
    expect(ast.where).toMatchObject({
      kind: 'compare',
      op: '=',
      left: { kind: 'column', name: 'id' },
      right: { kind: 'literal', value: 5 },
    });
  });

  it('accepts each supported operator', () => {
    for (const op of ['=', '<', '>']) {
      expect(ok(`SELECT * FROM users WHERE age ${op} 30`).where).toMatchObject({ op });
    }
  });

  it('chains AND left-associatively', () => {
    const ast = ok('SELECT * FROM users WHERE a = 1 AND b = 2 AND c = 3');
    // ((a AND b) AND c)
    expect(ast.where).toMatchObject({
      kind: 'and',
      left: { kind: 'and', left: { kind: 'compare' }, right: { kind: 'compare' } },
      right: { kind: 'compare', left: { name: 'c' } },
    });
  });

  it('reads string, boolean and null literals', () => {
    expect(ok("SELECT * FROM t WHERE name = 'ada'").where).toMatchObject({
      right: { value: 'ada', raw: "'ada'" },
    });
    expect(ok('SELECT * FROM t WHERE ok = TRUE').where).toMatchObject({
      right: { value: true },
    });
    expect(ok('SELECT * FROM t WHERE x = NULL').where).toMatchObject({
      right: { value: null },
    });
  });

  it('tolerates a trailing semicolon, newlines and comments', () => {
    expect(ok('SELECT *\n  FROM users -- go\n  WHERE id = 5;').from.name).toBe('users');
  });

  it('is case-insensitive on keywords', () => {
    expect(ok('select * from users where id = 5').from.name).toBe('users');
  });

  it('spans the whole statement', () => {
    const sql = 'SELECT * FROM users WHERE id = 5';
    expect(ok(sql).span).toEqual({ from: 0, to: sql.length });
  });
});

describe('parse — LIMIT', () => {
  it('parses a bare LIMIT', () => {
    const ast = ok('SELECT * FROM users LIMIT 5');
    expect(ast.limit).toMatchObject({ value: 5 });
  });

  it('parses LIMIT after a WHERE', () => {
    const ast = ok('SELECT * FROM users WHERE age > 30 LIMIT 5');
    expect(ast.where).toBeDefined();
    expect(ast.limit).toMatchObject({ value: 5 });
  });

  it('accepts LIMIT 0', () => {
    expect(ok('SELECT * FROM users LIMIT 0').limit).toMatchObject({ value: 0 });
  });

  it('omits limit when there is none', () => {
    expect(ok('SELECT * FROM users').limit).toBeUndefined();
  });

  it('is case-insensitive and tolerates a trailing semicolon', () => {
    expect(ok('select * from users limit 3;').limit).toMatchObject({ value: 3 });
  });

  it('spans exactly the LIMIT clause, and the statement span includes it', () => {
    const sql = 'SELECT * FROM users LIMIT 5';
    const ast = ok(sql);
    expect(sql.slice(ast.limit!.span.from, ast.limit!.span.to)).toBe('LIMIT 5');
    expect(ast.span).toEqual({ from: 0, to: sql.length });
  });

  it('rejects a non-numeric LIMIT, pointing at the bad token', () => {
    const e = err('SELECT * FROM users LIMIT ada');
    expect(e.message).toMatch(/expected a whole number after limit/i);
    expect(e.from).toBe(26);
  });

  it('rejects a fractional LIMIT', () => {
    const e = err('SELECT * FROM users LIMIT 5.5');
    expect(e.message).toMatch(/whole number/i);
  });

  it('rejects a missing LIMIT count', () => {
    expect(err('SELECT * FROM users LIMIT').message).toMatch(/expected a whole number/i);
  });
});

describe('parse — errors point at the right text', () => {
  it('rejects an empty query', () => {
    expect(err('').message).toMatch(/empty/i);
  });

  it('rejects a missing FROM', () => {
    const e = err('SELECT *');
    expect(e.message).toMatch(/expected `FROM`/i);
    expect(e.from).toBe(8);
  });

  it('rejects a missing table name', () => {
    expect(err('SELECT * FROM').message).toMatch(/expected a table name/i);
  });

  it('rejects trailing junk', () => {
    const e = err('SELECT * FROM users garbage');
    expect(e.message).toMatch(/unexpected/i);
    expect(e.from).toBe(20);
  });

  it('names the v0 scope for unsupported operators', () => {
    const e = err('SELECT * FROM users WHERE id >= 5');
    expect(e.message).toMatch(/`>=` is not supported yet/);
    expect(e.hint).toMatch(/`=`, `<` and `>`/);
    expect(e.from).toBe(29);
    expect(e.to).toBe(31);
  });

  it('explains OR rather than blaming the token', () => {
    const e = err('SELECT * FROM users WHERE a = 1 OR b = 2');
    expect(e.message).toMatch(/`OR` is not supported yet/);
    expect(e.hint).toMatch(/AND/);
  });

  it.each([
    ['SELECT * FROM a JOIN b ON a.id = b.id', /JOIN/, /v1/],
    ['SELECT * FROM users GROUP BY id', /GROUP/, /v0 subset/],
    ['SELECT * FROM users ORDER BY id', /ORDER/, /v0 subset/],
    ['SELECT * FROM users LIMIT 5 OFFSET 10', /OFFSET/, /LIMIT on its own is/],
    ['INSERT INTO users VALUES (1)', /INSERT/, /only runs SELECT/],
    ['DELETE FROM users', /DELETE/, /only runs SELECT/],
  ])('explains out-of-scope SQL: %s', (sql, message, hint) => {
    const e = err(sql);
    expect(e.message).toMatch(message);
    expect(e.hint).toMatch(hint);
  });

  it('rejects parentheses with a scope explanation', () => {
    const e = err('SELECT * FROM users WHERE (id = 5)');
    expect(e.message).toMatch(/parenthesised/i);
    expect(e.hint).toMatch(/flat chain/i);
  });

  it('every error span is inside the query and non-empty', () => {
    for (const sql of [
      'SELECT',
      'SELECT * FROM',
      'SELECT * FROM users WHERE',
      'SELECT * FROM users WHERE id',
      'SELECT * FROM users WHERE id =',
      'SELECT , FROM users',
      'FROM users',
    ]) {
      const e = err(sql);
      expect(e.from, sql).toBeGreaterThanOrEqual(0);
      expect(e.to!, sql).toBeGreaterThan(e.from!);
      expect(e.from!, sql).toBeLessThanOrEqual(sql.length);
    }
  });
});

describe('toDisplayTree', () => {
  it('mirrors the clauses present', () => {
    const tree = toDisplayTree(ok('SELECT id FROM users WHERE id = 5'));
    expect(tree.children?.map((c) => c.kind)).toEqual(['SelectList', 'From', 'Where']);
  });

  it('omits WHERE when there is no predicate', () => {
    const tree = toDisplayTree(ok('SELECT * FROM users'));
    expect(tree.children?.map((c) => c.kind)).toEqual(['SelectList', 'From']);
  });

  it('includes a Limit node, in clause order, when LIMIT is present', () => {
    const tree = toDisplayTree(ok('SELECT * FROM users WHERE id = 5 LIMIT 5'));
    expect(tree.children?.map((c) => c.kind)).toEqual(['SelectList', 'From', 'Where', 'Limit']);
    expect(tree.children?.at(-1)).toMatchObject({ label: 'LIMIT', detail: '5' });
  });

  it('gives every node a unique id, so a progressive reveal can animate', () => {
    const tree = toDisplayTree(ok('SELECT a, b FROM t WHERE x = 1 AND y = 2'));
    const ids: string[] = [];
    const walk = (n: typeof tree) => {
      ids.push(n.id);
      n.children?.forEach(walk);
    };
    walk(tree);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
