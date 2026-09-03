# Contributing to QueryLens

Thank you for your interest in contributing! QueryLens is a learning tool that teaches database internals through interactive visualization, and every contribution — code, docs, bug reports, ideas — helps make it better.

## Getting Started

```bash
git clone https://github.com/Naveen-Boddepalli/QueryLens.git
cd QueryLens
pnpm install
pnpm dev          # http://localhost:5173
```

### Prerequisites

- **Node.js** — `^20.19.0` or `>=22.12.0` (pinned in `.node-version`)
- **pnpm** — `11.1.2` (pinned in `package.json`)

### Verify your setup

```bash
pnpm typecheck    # TypeScript
pnpm lint         # ESLint + jsx-a11y
pnpm test         # 326 unit tests (vitest)
pnpm build        # production build
pnpm budget       # gzip bundle budget
pnpm test:e2e     # Playwright (needs: pnpm exec playwright install chromium)
```

CI runs exactly this sequence. If it passes locally, it will pass in CI.

## Development Workflow

1. **Fork and branch.** Create a branch from `main` with a descriptive name:
   - `feat/hash-join-visualization`
   - `fix/buffer-pool-overflow`
   - `docs/user-manual-btree-chapter`

2. **Make your changes.** The codebase has two strict boundaries:
   - `src/engine/` — pure, synchronous, no DOM, no React, no async. Every emitted value must be structurally cloneable.
   - `src/ui/` — a renderer of engine state, nothing more.

3. **Write tests.** Engine changes need unit tests. UI changes need UI tests (Testing Library) and, for visual or interactive changes, an end-to-end test (Playwright).

4. **Commit.** Use [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat:` — a new feature
   - `fix:` — a bug fix
   - `docs:` — documentation only
   - `refactor:` — code change that neither fixes a bug nor adds a feature
   - `test:` — adding or updating tests
   - `chore:` — build, CI, dependency updates

5. **Open a pull request.** Fill in the template. Link the issue if one exists.

## Code Style

ESLint enforces the style. Run `pnpm lint` before committing. Key rules:

- TypeScript strict mode
- `eslint-plugin-jsx-a11y` for accessibility
- `eslint-plugin-react-hooks` for React rules

## What Makes a Good Contribution

- **Bug reports** with the error boundary's copyable repro (SQL, policy, step, rows) are the most helpful reports possible.
- **Documentation** improvements are always welcome — especially the user manual and concept explanations.
- **New pipeline stages or SQL features** should start as an issue for discussion before code.
- **Accessibility fixes** are high-priority. The app targets WCAG AA.

## Architecture Overview

See [plan.md](plan.md) for the full design and [RESEARCH.md](RESEARCH.md) for the evidence it is built on. Key points:

- The engine is a pure synchronous function: `runQuery(sql, db, options) → { events, result }`
- Events are deltas, not snapshots — the UI folds them to derive state
- Playback is an index into an array
- The engine is worker-ready but runs on the main thread (see plan.md §5)

## Release-Age Floor

`minimumReleaseAge: 10080` is set in `pnpm-workspace.yaml`. If `pnpm add` fails on existing pins under a week old, run:

```bash
pnpm install --config.minimumReleaseAge=0
```

after checking the ages of what you are adding. Do not weaken the committed setting.

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold it.

## Questions?

Open a [GitHub Issue](https://github.com/Naveen-Boddepalli/QueryLens/issues) for bugs and feature requests.
