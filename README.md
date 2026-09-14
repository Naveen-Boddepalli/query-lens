# QueryLens

![CI](https://github.com/Naveen-Boddepalli/QueryLens/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-6.0.3-blue.svg)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)

An in-browser toy relational database engine that animates a SQL query as it moves through
**Parser → Planner → Optimizer → Execution → Buffer Pool → B+Tree Index → Locks → Result**. Every
number the app shows is this engine's own — not Postgres's, not a claim about a real one.

A learning tool, not a production database. Run `SELECT`, `DELETE`, `INSERT` or `UPDATE` — with a
`JOIN`, `GROUP BY`, `ORDER BY` or `LIMIT` — and step through exactly what the engine did to answer
it: which access path the optimizer chose and why, which pages the buffer pool evicted, which
locks a B+Tree descent held at once. Predictions are asked for before each reveal, seed data is
editable in place, and every moment on screen is a shareable link.

**[Contributing](CONTRIBUTING.md)** · **[Code of Conduct](CODE_OF_CONDUCT.md)** ·
**[Security](SECURITY.md)** · **[Changelog](CHANGELOG.md)** · **[License](LICENSE)** ·
**[Docs license](LICENSE-DOCS)**

## Learn more

The **[in-app docs](src/pages/DocsContent/index.mdx)** — Getting Started, a task-shaped manual,
Concepts (with live embedded widgets), a full SQL/URL-parameter/shortcuts reference, and an
[Architecture](src/pages/DocsContent/architecture.mdx) page for contributors — live at `/docs`
once the app is running, built into the app itself rather than a separate site so a page can embed
a real component with no wrapper. **[plan.md](plan.md)** is the full decision log behind every
feature, narrated as it shipped; **[RESEARCH.md](RESEARCH.md)** is the evidence it's built on.

## Status

The MVP is complete: all eight pipeline stages are real, predict-then-reveal works, seed data is
editable, and the deploy and comprehension gates ([plan.md §14](plan.md#14-production-readiness--the-deploy-gate),
[§15](plan.md#15-uiux-readiness--the-comprehension-gate)) are both done through P1. Since then, the
engine has grown well past its original v0 scope — see [Supported SQL](src/pages/DocsContent/reference/sql.mdx)
for exactly what runs today. The one thing still outside this repo's control is
[plan.md §9](plan.md#9-validation-strategy-before-building-breadth)'s validation study — a post-test
against a text-explanation control, which needs real participants, not commits.

## Commands

```bash
pnpm install
pnpm dev        # http://localhost:5173
pnpm test       # vitest — the unit suite
pnpm typecheck  # tsc -b
pnpm lint       # eslint, including jsx-a11y
pnpm build      # tsc -b && vite build
pnpm budget     # gzip budget over dist/ — run after build
pnpm test:e2e   # playwright against the built output, including axe
```

CI runs exactly that sequence on every PR and push to `main`. `pnpm test:e2e` needs a browser once:
`pnpm exec playwright install chromium`.

**Adding a dependency trips the release-age floor.** `minimumReleaseAge: 10080` is a resolution-time
rule and pnpm re-resolves every direct dependency when `package.json` changes, so `pnpm add` fails
on whichever *existing* pin happens to be under a week old. Check the age of what you're actually
adding, then run the one-off as `pnpm install --config.minimumReleaseAge=0` — don't weaken the
committed setting or start an exclude list.

## Deploying

Cloudflare Pages (plan.md §6). `pnpm build` outputs a static `dist/`;
`public/_headers` carries a tested CSP and the full security header set
([plan.md §14.3](plan.md#143-the-security-headers-tested-rather-than-assumed)). There is **no
telemetry of any kind** — no analytics, no error tracking, no cookies — a decision recorded in
[plan.md §14.4](plan.md#144-the-telemetry-decision-stated-rather-than-drifted-into), not an
omission. `VITE_SITE_URL` sets the canonical/`og:image` URL if the site gets a custom domain.

## Testing

| Layer | What it covers |
|---|---|
| `pnpm test` | The engine (parser, planner, buffer pool, B+Tree, executor, locks, cost model) and the UI (playback gating, keyboard shortcuts, the data/schema editors, URL state, the error boundary) |
| `pnpm test:e2e` | Playwright against **`dist/`** — smoke (load→run→step→result, a shared link, the data editor, theming, axe in both palettes) and regressions (panel tracking, zoom, overflow, gating, history, console silence) |
| `pnpm budget` | A gzip ceiling per chunk and overall, so the bundle can't drift back silently |

See [Architecture](src/pages/DocsContent/architecture.mdx) for what the engine/UI split actually
looks like, and [CONTRIBUTING.md](CONTRIBUTING.md) for the day-to-day mechanics of a change.
