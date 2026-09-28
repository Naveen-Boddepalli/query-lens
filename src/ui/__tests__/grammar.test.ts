import { describe, expect, it } from 'vitest';
import { GRAMMAR, ruleNamed } from '../grammar.ts';
import type { GrammarPart } from '../grammar.ts';
import { KEYWORDS } from '../../engine/parser/tokenizer.ts';
import { AGGREGATE_FNS, parseStatement } from '../../engine/parser/parser.ts';

/** Every literal and rule-reference part, anywhere in the grammar, depth-first. */
function walk(parts: GrammarPart[], visit: (part: GrammarPart) => void): void {
  for (const part of parts) {
    visit(part);
    if (part.kind === 'optional') walk(part.parts, visit);
    else if (part.kind === 'repeat') walk([part.separator, ...part.parts], visit);
    else if (part.kind === 'choice') for (const option of part.options) walk(option, visit);
  }
}

describe('grammar data — structural consistency', () => {
  it('every rule reference points at a rule that actually exists', () => {
    for (const r of GRAMMAR) {
      walk(r.parts, (part) => {
        if (part.kind === 'rule') {
          expect(ruleNamed(part.name), `${r.name} references undefined rule "${part.name}"`).toBeDefined();
        }
      });
    }
  });

  it('every all-caps literal is either a real keyword or a real aggregate function name', () => {
    for (const r of GRAMMAR) {
      walk(r.parts, (part) => {
        if (part.kind === 'literal' && /^[A-Z]+$/.test(part.text)) {
          expect(
            KEYWORDS.has(part.text) || AGGREGATE_FNS.has(part.text),
            `${r.name} claims "${part.text}" is a keyword or aggregate function`,
          ).toBe(true);
        }
      });
    }
  });

  it('no rule is defined twice', () => {
    const names = GRAMMAR.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

/**
 * The real guard against drift: one representative query per rule, each
 * exercising the part of the grammar that rule names, run through the real
 * parser. If a rule stops being true — a keyword renamed, a clause dropped —
 * one of these fails, rather than the diagram quietly going on claiming
 * something the parser no longer does.
 */
describe('grammar data — every rule is demonstrated by a query the real parser accepts', () => {
  it.each([
    ['statement (select)', 'SELECT * FROM users'],
    ['statement (explain)', 'EXPLAIN SELECT * FROM users'],
    ['explain — with ANALYZE', 'EXPLAIN ANALYZE SELECT * FROM users WHERE id = 5'],
    ['statement (analyze)', 'ANALYZE users'],
    ['analyze — with a trailing semicolon', 'ANALYZE users;'],
    ['statement (delete)', 'DELETE FROM users'],
    ['statement (insert)', "INSERT INTO users VALUES (1, 'a')"],
    ['statement (update)', 'UPDATE users SET age = 1'],
    ['select — every optional clause at once', 'SELECT age, COUNT(*) FROM users WHERE age > 30 GROUP BY age HAVING COUNT(*) > 1 LIMIT 5'],
    ['primary — an aggregateCall (inside HAVING)', 'SELECT age FROM users GROUP BY age HAVING SUM(id) > 10 AND COUNT(*) < 5'],
    ['select — ORDER BY with ASC/DESC', 'SELECT * FROM users ORDER BY age DESC'],
    ['select — DISTINCT', 'SELECT DISTINCT age, name FROM users ORDER BY age'],
    ['select — LIMIT with OFFSET', 'SELECT * FROM users ORDER BY id LIMIT 5 OFFSET 10'],
    ['select — with a join', 'SELECT * FROM authors JOIN posts ON authors.id = posts.authorId'],
    ['join', 'SELECT * FROM authors JOIN posts ON authors.id = posts.authorId'],
    ['delete — with WHERE', 'DELETE FROM users WHERE id = 5'],
    ['insert — with an explicit columnList', "INSERT INTO users (id, name) VALUES (1, 'a')"],
    ['insert — valueList with more than one value', 'INSERT INTO users VALUES (1, 2, 3)'],
    ['update — assignment repeated', "UPDATE users SET age = 1, name = 'a'"],
    ['value — every literal kind', "INSERT INTO t VALUES (1, 'a', NULL, TRUE, FALSE)"],
    ['selectList — star', 'SELECT * FROM users'],
    ['selectList — repeated selectItem', 'SELECT id, name, age FROM users'],
    ['selectItem — aggregateCall', 'SELECT COUNT(*) FROM users'],
    ['aggregateCall — every function', 'SELECT COUNT(id), SUM(age), AVG(age), MIN(age), MAX(age) FROM users'],
    ['expr', 'SELECT * FROM users WHERE id = 5'],
    ['orExpr — OR repeated', 'SELECT * FROM users WHERE id = 1 OR id = 2 OR id = 3'],
    ['andExpr — AND repeated', 'SELECT * FROM users WHERE id = 5 AND age > 1 AND age < 99'],
    ['notExpr — NOT, nested', 'SELECT * FROM users WHERE NOT NOT id = 5'],
    ['notExpr — a plain predicate', 'SELECT * FROM users WHERE id = 5'],
    ['predicate — a comparison', 'SELECT * FROM users WHERE id = 1'],
    ['predicate — BETWEEN and NOT BETWEEN', 'SELECT * FROM users WHERE id BETWEEN 1 AND 5 AND age NOT BETWEEN 30 AND 40'],
    ['predicate — IS NULL and IS NOT NULL', 'SELECT * FROM users WHERE age IS NULL OR name IS NOT NULL'],
    ['predicate — IN and NOT IN, several values', 'SELECT * FROM users WHERE id IN (1, 2, 3) AND age NOT IN (30)'],
    ['predicate — LIKE and NOT LIKE', "SELECT * FROM users WHERE name LIKE 'a%' AND name NOT LIKE '%z'"],
    ['compareOp — every operator', 'SELECT * FROM users WHERE id = 1 OR id <> 2 OR id != 3 OR id < 4 OR id > 5 OR id <= 6 OR id >= 7'],
    ['primary — a parenthesised expr', 'SELECT * FROM users WHERE (id = 1 OR id = 2) AND age > 3'],
    ['operand — + and - repeated', 'SELECT * FROM users WHERE age + 1 - 2 > 3'],
    ['multiplicative — * / % repeated', 'SELECT * FROM users WHERE age * 2 / 3 % 4 = 1'],
    ['unary — minus, nested', 'SELECT * FROM users WHERE age > - -5'],
    ['selectItem — an expression with AS', 'SELECT id, age * 2 AS double, name AS label FROM users'],
    ['assignment — an expression on the right', 'UPDATE users SET age = age + 1, name = name'],
    ['value — a negated number', 'INSERT INTO users VALUES (-1, -2.5, 2 * 3)'],
    ['operand — a bare identifier, one form of qualifiedColumn', "SELECT * FROM users WHERE name = 'a'"],
    [
      'qualifiedColumn — the table-qualified form',
      "SELECT authors.name FROM authors JOIN posts ON authors.id = posts.authorId WHERE authors.name = 'a'",
    ],
  ] as const)('%s: %s', (_label, sql) => {
    const result = parseStatement(sql);
    expect(result.ok, result.ok ? undefined : result.error.message).toBe(true);
  });
});
