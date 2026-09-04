---
title: Supported SQL
description: The exact SQL subset QueryLens's parser accepts, and what it says when you write something outside it.
---

QueryLens implements one statement: a single-table `SELECT` with an optional `WHERE` clause. This
page is the complete subset — if it isn't listed here, the parser does not accept it yet.

## What runs

```sql
SELECT * FROM users;
SELECT id, name FROM users;
SELECT * FROM users WHERE id = 5;
SELECT * FROM users WHERE age > 30 AND name = 'Ada';
```

- **Column list**: `*`, or a comma-separated list of column names.
- **`FROM`**: exactly one table.
- **`WHERE`**: any number of comparisons joined with `AND`.
  - Operators: `=`, `<`, `>` only.
  - Literals: numbers, single-quoted strings, `TRUE`/`FALSE`, `NULL`.
- Keywords are case-insensitive, `--` starts a line comment, and a trailing `;` is optional.

## What the parser recognises but rejects — on purpose

These keywords tokenise cleanly, so the parser can name exactly what you tried rather than failing
with a generic syntax error:

| You write | The parser says |
|---|---|
| `JOIN` / `INNER JOIN` / `LEFT JOIN` / etc. | *Joins arrive in v1 — v0 reads a single table.* |
| `GROUP BY` | *GROUP BY is not in the v0 subset.* |
| `ORDER BY` | *ORDER BY is not in the v0 subset.* |
| `HAVING` | *HAVING is not in the v0 subset.* |
| `LIMIT` | *LIMIT is not in the v0 subset.* |
| `DISTINCT` | *DISTINCT is not in the v0 subset.* |
| `UNION` | *UNION is not in the v0 subset.* |
| `OR` | *v0 supports AND only. Combine predicates with AND.* |
| `NOT` | *v0 supports =, < and > only, combined with AND.* |
| `<=`, `>=`, `<>`, `!=` | *"`<=` is not supported yet." — v0 supports `=`, `<` and `>`.* |
| `INSERT` / `UPDATE` / `DELETE` | *QueryLens only runs SELECT — it visualises reads, not writes.* |
| `CREATE` / `DROP` | *QueryLens only runs SELECT. Edit the seed data to change the table.* |

The last two rows are the reason [the data editor](/) exists: QueryLens has no write path by design,
so changing what's in the table happens by editing the seed rows directly rather than by `INSERT` or
`UPDATE`.

## The seed table

Every query runs against one table, `users`, with columns `id`, `name`, `email`, `age`. Its rows are
editable from the app (**Edit data**), and an edited set travels with a shareable link — see
[URL parameters](/reference/url-parameters/).
