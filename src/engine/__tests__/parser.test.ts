import { describe, expect, it } from 'vitest';
import { parse, parseStatement } from '../parser/parser.ts';
import {
  deleteDisplayTree,
  insertDisplayTree,
  toDisplayTree,
  updateDisplayTree,
} from '../parser/display.ts';
import type { DeleteStatement, InsertStatement, SelectStatement, UpdateStatement } from '../parser/ast.ts';

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

function okInsert(sql: string): InsertStatement {
  const ast = okStatement(sql);
  if (ast.kind !== 'insert') throw new Error(`expected an insert, got ${ast.kind}`);
  return ast;
}

function okUpdate(sql: string): UpdateStatement {
  const ast = okStatement(sql);
  if (ast.kind !== 'update') throw new Error(`expected an update, got ${ast.kind}`);
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
    expect(
      ast.select.kind === 'columns' &&
        ast.select.items.map((item) => item.kind === 'column' && item.name),
    ).toEqual(['id', 'name']);
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

describe('parse — GROUP BY and aggregates', () => {
  it('parses a plain aggregate with no GROUP BY', () => {
    const ast = ok('SELECT COUNT(*) FROM users');
    expect(ast.select.kind).toBe('columns');
    const item = ast.select.kind === 'columns' ? ast.select.items[0] : null;
    expect(item).toMatchObject({ kind: 'aggregate', fn: 'COUNT', arg: { kind: 'star' } });
    expect(ast.groupBy).toBeUndefined();
  });

  it('parses every aggregate function over a column', () => {
    const ast = ok('SELECT SUM(age), AVG(age), MIN(age), MAX(age), COUNT(age) FROM users');
    expect(ast.select.kind === 'columns' && ast.select.items.map((i) => i.kind === 'aggregate' && i.fn)).toEqual([
      'SUM',
      'AVG',
      'MIN',
      'MAX',
      'COUNT',
    ]);
  });

  it('parses a GROUP BY on one column', () => {
    const ast = ok('SELECT age, COUNT(*) FROM users GROUP BY age');
    expect(ast.groupBy?.columns.map((c) => c.name)).toEqual(['age']);
  });

  it('parses a GROUP BY on multiple columns', () => {
    const ast = ok('SELECT age, name, COUNT(*) FROM users GROUP BY age, name');
    expect(ast.groupBy?.columns.map((c) => c.name)).toEqual(['age', 'name']);
  });

  it('parses GROUP BY with no aggregate function at all — plain deduplication', () => {
    const ast = ok('SELECT age FROM users GROUP BY age');
    expect(ast.groupBy?.columns.map((c) => c.name)).toEqual(['age']);
  });

  it('treats a bare identifier named like an aggregate function as a plain column', () => {
    const ast = ok('SELECT count FROM users');
    expect(ast.select.kind === 'columns' && ast.select.items[0]).toMatchObject({ kind: 'column', name: 'count' });
  });

  it('is case-insensitive on the function name', () => {
    const ast = ok('SELECT count(*) FROM users');
    expect(ast.select.kind === 'columns' && ast.select.items[0]).toMatchObject({ fn: 'COUNT' });
  });

  it('rejects `*` for anything but COUNT', () => {
    const e = err('SELECT SUM(*) FROM users');
    expect(e.message).toMatch(/SUM\(\*\).*not supported/);
    expect(e.hint).toMatch(/SUM\(age\)/);
  });

  it('rejects a missing closing paren', () => {
    expect(err('SELECT COUNT(* FROM users').message).toMatch(/expected `\)`/i);
  });

  it('rejects a missing GROUP BY column', () => {
    expect(err('SELECT COUNT(*) FROM users GROUP BY').message).toMatch(/a column name to group by/i);
  });

  it('rejects a missing BY after GROUP', () => {
    expect(err('SELECT COUNT(*) FROM users GROUP age').message).toMatch(/expected `by`/i);
  });

  it('rejects a plain column mixed with an aggregate, with no GROUP BY', () => {
    const e = err('SELECT name, COUNT(*) FROM users');
    expect(e.message).toMatch(/`name` is not aggregated/);
    expect(e.hint).toMatch(/GROUP BY/);
  });

  it('rejects a plain column not covered by GROUP BY', () => {
    const e = err('SELECT name, age, COUNT(*) FROM users GROUP BY name');
    expect(e.message).toMatch(/`age` is not aggregated and is not in the GROUP BY list/);
  });

  it('rejects SELECT * with GROUP BY', () => {
    const e = err('SELECT * FROM users GROUP BY age');
    expect(e.message).toMatch(/SELECT \*.*GROUP BY/);
  });

  it('rejects ORDER BY combined with GROUP BY', () => {
    const e = err('SELECT age, COUNT(*) FROM users GROUP BY age ORDER BY age');
    expect(e.message).toMatch(/ORDER BY with GROUP BY/);
  });

  it('still allows LIMIT with GROUP BY', () => {
    const ast = ok('SELECT age, COUNT(*) FROM users GROUP BY age LIMIT 3');
    expect(ast.limit).toMatchObject({ value: 3 });
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

  it('rejects an empty query the same way SELECT does', () => {
    expect(errStatement('').message).toMatch(/empty/i);
  });
});

describe('parseStatement — INSERT', () => {
  it('parses INSERT with an explicit column list', () => {
    const ast = okInsert("INSERT INTO users (id, name) VALUES (1, 'ada')");
    expect(ast).toMatchObject({ kind: 'insert', into: { name: 'users' } });
    expect(ast.columns?.names.map((c) => c.name)).toEqual(['id', 'name']);
    expect(ast.values.items.map((v) => v.value)).toEqual([1, 'ada']);
  });

  it('parses INSERT with no column list — every value, in table order', () => {
    const ast = okInsert("INSERT INTO users VALUES (1, 'ada', 30)");
    expect(ast.columns).toBeUndefined();
    expect(ast.values.items.map((v) => v.value)).toEqual([1, 'ada', 30]);
  });

  it('parses every literal kind a VALUES list can hold', () => {
    const ast = okInsert('INSERT INTO t (a, b, c, d) VALUES (1, NULL, TRUE, FALSE)');
    expect(ast.values.items.map((v) => v.value)).toEqual([1, null, true, false]);
  });

  it('is case-insensitive and tolerates a trailing semicolon', () => {
    expect(okInsert("insert into users values (1, 'a');").into.name).toBe('users');
  });

  it('spans the whole statement, from INSERT to the closing paren', () => {
    const sql = "INSERT INTO users VALUES (1, 'a')";
    expect(okInsert(sql).span).toEqual({ from: 0, to: sql.length });
  });

  it('rejects a missing INTO', () => {
    expect(errStatement('INSERT users VALUES (1)').message).toMatch(/expected `into`/i);
  });

  it('rejects a missing table name', () => {
    expect(errStatement('INSERT INTO').message).toMatch(/expected a table name/i);
  });

  it('rejects a missing VALUES', () => {
    expect(errStatement('INSERT INTO users (id)').message).toMatch(/expected `values`/i);
  });

  it('rejects an empty VALUES list', () => {
    expect(errStatement('INSERT INTO users VALUES ()').message).toMatch(/expected a value/i);
  });

  it('rejects a column name written where a value belongs, with a hint', () => {
    const e = errStatement('INSERT INTO users (id) VALUES (age)');
    expect(e.message).toMatch(/expected a value/i);
    expect(e.hint).toMatch(/literal values/);
  });

  it('rejects a column count that does not match the value count', () => {
    const e = errStatement('INSERT INTO users (id, name) VALUES (1)');
    expect(e.message).toMatch(/2 columns but 1 value/);
  });

  it('rejects trailing junk, same as SELECT and DELETE', () => {
    expect(errStatement("INSERT INTO users VALUES (1) garbage").message).toMatch(/unexpected/i);
  });
});

describe('parseStatement — UPDATE', () => {
  it('parses a single assignment', () => {
    const ast = okUpdate('UPDATE users SET age = 30');
    expect(ast).toMatchObject({ kind: 'update', table: { name: 'users' } });
    expect(ast.set.assignments).toHaveLength(1);
    expect(ast.set.assignments[0]).toMatchObject({ column: 'age', value: { kind: 'literal', value: 30 } });
    expect(ast.where).toBeUndefined();
  });

  it('parses multiple assignments, comma-separated', () => {
    const ast = okUpdate("UPDATE users SET name = 'ada', age = 30");
    expect(ast.set.assignments.map((a) => a.column)).toEqual(['name', 'age']);
    expect(ast.set.assignments.map((a) => a.value.value)).toEqual(['ada', 30]);
  });

  it('parses a WHERE after SET, same grammar as SELECT and DELETE', () => {
    const ast = okUpdate('UPDATE users SET age = 30 WHERE id = 5');
    expect(ast.where).toMatchObject({ kind: 'compare', op: '=' });
  });

  it('parses every literal kind an assignment can hold', () => {
    const ast = okUpdate('UPDATE t SET a = 1, b = NULL, c = TRUE, d = FALSE');
    expect(ast.set.assignments.map((a) => a.value.value)).toEqual([1, null, true, false]);
  });

  it('is case-insensitive and tolerates a trailing semicolon', () => {
    expect(okUpdate('update users set age = 30;').table.name).toBe('users');
  });

  it('spans the whole statement, from UPDATE to the end of the WHERE', () => {
    const sql = 'UPDATE users SET age = 30 WHERE id = 5';
    expect(okUpdate(sql).span).toEqual({ from: 0, to: sql.length });
  });

  it('rejects a missing table name', () => {
    expect(errStatement('UPDATE SET age = 30').message).toMatch(/expected a table name/i);
  });

  it('rejects a missing SET', () => {
    expect(errStatement('UPDATE users age = 30').message).toMatch(/expected `set`/i);
  });

  it('rejects a missing `=` in an assignment', () => {
    expect(errStatement('UPDATE users SET age 30').message).toMatch(/expected `=`/i);
  });

  it('rejects a column name written where a value belongs, with a hint', () => {
    const e = errStatement('UPDATE users SET age = name');
    expect(e.message).toMatch(/expected a value/i);
    expect(e.hint).toMatch(/literal values/);
  });

  it('rejects trailing junk, same as SELECT, DELETE and INSERT', () => {
    expect(errStatement('UPDATE users SET age = 30 garbage').message).toMatch(/unexpected/i);
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
    ['SELECT dept, COUNT(*) FROM users GROUP BY dept HAVING COUNT(*) > 1', /HAVING/, /WHERE instead/],
    ['SELECT * FROM users LIMIT 5 OFFSET 10', /OFFSET/, /LIMIT on its own is/],
  ])('explains out-of-scope SQL: %s', (sql, message, hint) => {
    const e = err(sql);
    expect(e.message).toMatch(message);
    expect(e.hint).toMatch(hint);
  });

  it('rejects DELETE, INSERT and UPDATE too — parse() is the SELECT-only entry point; parseStatement() is where they live', () => {
    expect(err('DELETE FROM users').message).toMatch(/expected `select`/i);
    expect(err('INSERT INTO users VALUES (1)').message).toMatch(/expected `select`/i);
    expect(err('UPDATE users SET age = 1').message).toMatch(/expected `select`/i);
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

  it('insertDisplayTree mirrors INSERT — Into, then ColumnList when present, then Values', () => {
    const bare = insertDisplayTree(okInsert("INSERT INTO users VALUES (1, 'ada')"));
    expect(bare.label).toBe('INSERT');
    expect(bare.children?.map((c) => c.kind)).toEqual(['Into', 'Values']);

    const withColumns = insertDisplayTree(okInsert("INSERT INTO users (id, name) VALUES (1, 'ada')"));
    expect(withColumns.children?.map((c) => c.kind)).toEqual(['Into', 'ColumnList', 'Values']);
  });

  it('updateDisplayTree mirrors UPDATE — Table, Set, then Where when present', () => {
    const bare = updateDisplayTree(okUpdate('UPDATE users SET age = 30'));
    expect(bare.label).toBe('UPDATE');
    expect(bare.children?.map((c) => c.kind)).toEqual(['Table', 'Set']);

    const withWhere = updateDisplayTree(okUpdate('UPDATE users SET age = 30 WHERE id = 5'));
    expect(withWhere.children?.map((c) => c.kind)).toEqual(['Table', 'Set', 'Where']);
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
