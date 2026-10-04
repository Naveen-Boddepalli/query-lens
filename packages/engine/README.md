# @querylens/engine

The toy database engine behind [QueryLens](https://query-lens.1234naveenboddepalli.workers.dev): a SQL parser, planner,
optimizer, buffer pool, B+Tree and lock manager. Every step of a query is emitted as a trace event, so you can see what
the engine did, not just what it returned.

```js
import { runQuery, DATASETS, DEFAULT_ENGINE_OPTIONS } from '@querylens/engine';

const result = runQuery('SELECT * FROM users WHERE id = 5', DATASETS.users.make(), DEFAULT_ENGINE_OPTIONS);
console.log(result.rows);     // the rows
console.log(result.events);   // one trace event per step: parse, plan, optimize, execute, buffer, index, result
```

It is pure and deterministic: the same query on the same data gives the same events. It has no DOM, no React and no
dependencies at runtime. It is a model, not a database: its numbers are true to this engine, and not to PostgreSQL,
MySQL or any production system.

## Stability

This is a `0.x` release, and that means:

- **The SQL subset may grow.** Statements QueryLens does not support fail with an error; they are never silently
  approximated. The supported subset is listed in the project's docs.
- **The trace event shapes may change between minor versions.** Each event carries a `stage` and that stage's fields.
  Pin an exact version if you parse them.
- **Exports may move or be renamed between minor versions** until 1.0.0. Patch releases do not change exported names.

## Licence

MIT. The documentation is CC BY 4.0. See `LICENSE`.
