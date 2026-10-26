# querylens

Trace a SQL query through [QueryLens](https://query-lens.1234naveenboddepalli.workers.dev)'s toy database engine, on
the terminal. Every step the engine takes is printed, one line each: parse, plan, optimize, the buffer pool's hits
and misses, the B+Tree's descent, and the result.

```sh
npx querylens "SELECT * FROM users WHERE id = 5"
```

```
querylens — trace a SQL query through the QueryLens engine

Usage:
  querylens "<SQL>" [options]

Options:
  --policy <name>     buffer replacement policy: lru, clock, fifo, second-chance, optimal, midpoint, lru-k, two-q (default: lru)
  --dataset <name>    preset table: users, orders, logins, employees, transactions (default: users)
  --json             emit the trace as JSON instead of text
  --no-color         disable ANSI colour (also respects the NO_COLOR env var)
  -h, --help         show this help
```

It runs the same engine as the website, with no network access and nothing else to install. Its numbers are true to
this engine, and not to PostgreSQL, MySQL or any production system.

## Stability

This is a `0.x` release. The flags and the `--json` trace shape may change between minor versions; pin an exact
version if a script parses the output.

## Licence

MIT. See `LICENSE`.
