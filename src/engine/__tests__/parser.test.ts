import { describe, expect, it } from 'vitest';
import { parse, parseStatement } from '../parser/parser.ts';
import { deleteDisplayTree, toDisplayTree } from '../parser/display.ts';
import type { DeleteStatement, SelectStatement } from '../parser/ast.ts';

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

function okStatement(sql: string) {
  const out = parseStatement(sql);
  if (!out.ok) throw new Error(`expected a parse, got: ${out.error.message}`);
  return out.ast;
}

function okDelete(sql: string): DeleteStatement {
  const ast = okStatement(sql);
  if (ast.kind !== 'delete') throw new Error(`expected a delete, got ${ast.kind}`);
  return ast;
}

function errStatement(sql: string) {
  const out = parseStatement(sql);
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

describe('parse — ORDER BY', () => {
  it('parses a bare column, defaulting to ascending', () => {
    const ast = ok('SELECT * FROM users ORDER BY age');
    expect(ast.orderBy).toMatchObject({ column: 'age', direction: 'asc' });
  });

  it('parses an explicit ASC or DESC', () => {
    expect(ok('SELECT * FROM users ORDER BY age ASC').orderBy).toMatchObject({ direction: 'asc' });
    expect(ok('SELECT * FROM users ORDER BY age DESC').orderBy).toMatchObject({ direction: 'desc' });
  });

  it('is case-insensitive', () => {
    expect(ok('select * from users order by age desc').orderBy).toMatchObject({
      column: 'age',
      direction: 'desc',
    });
  });

  it('composes with WHERE and LIMIT, in clause order', () => {
    const ast = ok('SELECT * FROM users WHERE age > 30 ORDER BY age DESC LIMIT 3');
    expect(ast.where).toBeDefined();
    expect(ast.orderBy).toMatchObject({ column: 'age', direction: 'desc' });
    expect(ast.limit).toMatchObject({ value: 3 });
  });

  it('omits orderBy when there is none', () => {
    expect(ok('SELECT * FROM users').orderBy).toBeUndefined();
  });

  it('spans the whole clause, like LIMIT — from ORDER through the column and direction', () => {
    const bare = 'SELECT * FROM users ORDER BY age';
    const withDir = 'SELECT * FROM users ORDER BY age DESC';
    expect(bare.slice(ok(bare).orderBy!.span.from, ok(bare).orderBy!.span.to)).toBe('ORDER BY age');
    expect(withDir.slice(ok(withDir).orderBy!.span.from, ok(withDir).orderBy!.span.to)).toBe(
      'ORDER BY age DESC',
    );
  });

  it('rejects ORDER without BY', () => {
    const e = err('SELECT * FROM users ORDER age');
    expect(e.message).toMatch(/expected `by`/i);
  });

  it('rejects a missing column after BY', () => {
    expect(err('SELECT * FROM users ORDER BY').message).toMatch(/expected a column name/i);
  });

  it('rejects ordering by more than one column — v0 sorts on one', () => {
    const e = err('SELECT * FROM users ORDER BY age, name');
    expect(e.message).toMatch(/unexpected/i);
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

describe('parseStatement — DELETE', () => {
  it('parses a bare DELETE FROM', () => {
    const ast = okDelete('DELETE FROM users');
    expect(ast).toMatchObject({ kind: 'delete', from: { name: 'users' } });
    expect(ast.where).toBeUndefined();
  });

  it('parses a DELETE with a WHERE', () => {
    const ast = okDelete('DELETE FROM users WHERE age > 30');
    expect(ast.where).toMatchObject({ kind: 'compare', op: '>' });
  });

  it('parses a compound WHERE, same grammar as SELECT', () => {
    const ast = okDelete('DELETE FROM users WHERE id = 5 AND age > 0');
    expect(ast.where).toMatchObject({ kind: 'and' });
  });

  it('is case-insensitive and tolerates a trailing semicolon', () => {
    expect(okDelete('delete from users;').from.name).toBe('users');
  });

  it('still parses ordinary SELECT queries through the same entry point', () => {
    const ast = okStatement('SELECT * FROM users WHERE id = 5');
    expect(ast.kind).toBe('select');
  });

  it('spans the whole statement, from DELETE to the end of the WHERE', () => {
    const sql = 'DELETE FROM users WHERE id = 5';
    expect(okDelete(sql).span).toEqual({ from: 0, to: sql.length });
  });

  it('rejects a missing table name', () => {
    expect(errStatement('DELETE FROM').message).toMatch(/expected a table name/i);
  });

  it('rejects a missing FROM', () => {
    const e = errStatement('DELETE users');
    expect(e.message).toMatch(/expected `from`/i);
  });

  it('rejects trailing junk, same as SELECT', () => {
    const e = errStatement('DELETE FROM users garbage');
    expect(e.message).toMatch(/unexpected/i);
  });

  it('still rejects INSERT and UPDATE, naming DELETE as what does work', () => {
    expect(errStatement('INSERT INTO users VALUES (1)').hint).toMatch(/DELETE is/);
    expect(errStatement('UPDATE users SET age = 1').hint).toMatch(/DELETE is/);
  });

  it('rejects an empty query the same way SELECT does', () => {
    expect(errStatement('').message).toMatch(/empty/i);
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
    ['SELECT * FROM users LIMIT 5 OFFSET 10', /OFFSET/, /LIMIT on its own is/],
    ['INSERT INTO users VALUES (1)', /INSERT/, /DELETE is/],
    ['UPDATE users SET age = 1', /UPDATE/, /DELETE is/],
  ])('explains out-of-scope SQL: %s', (sql, message, hint) => {
    const e = err(sql);
    expect(e.message).toMatch(message);
    expect(e.hint).toMatch(hint);
  });

  it('rejects DELETE too — parse() is the SELECT-only entry point; parseStatement() is where DELETE lives', () => {
    const e = err('DELETE FROM users');
    expect(e.message).toMatch(/expected `select`/i);
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

  it('includes an OrderBy node, before Limit, when ORDER BY is present', () => {
    const tree = toDisplayTree(ok('SELECT * FROM users WHERE id = 5 ORDER BY age DESC LIMIT 5'));
    expect(tree.children?.map((c) => c.kind)).toEqual(['SelectList', 'From', 'Where', 'OrderBy', 'Limit']);
    const orderBy = tree.children?.[3];
    expect(orderBy).toMatchObject({ label: 'ORDER BY', detail: 'age DESC' });
  });

  it('deleteDisplayTree mirrors DELETE — From, then Where when present, no SelectList', () => {
    const bare = deleteDisplayTree(okDelete('DELETE FROM users'));
    expect(bare.label).toBe('DELETE');
    expect(bare.children?.map((c) => c.kind)).toEqual(['From']);

    const withWhere = deleteDisplayTree(okDelete('DELETE FROM users WHERE id = 5'));
    expect(withWhere.children?.map((c) => c.kind)).toEqual(['From', 'Where']);
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
