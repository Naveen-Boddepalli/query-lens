# GEMINI.md — Project Memory Bank

> Read this file fully before doing anything. It is the single source of truth for rules, commands, and known quirks.
> Keep this file under ~150 lines. Details and history go in `docs/LESSONS.md`, not here.
> Last reviewed: 2026-10-13 by orchestrator

## 0. Who are you?
- If you were started by `ao start` as the main session: you are the **ROOT ORCHESTRATOR** (follow §4).
- If your prompt says "You are an AO worker": you are a **WORKER** (follow §5).
- If your prompt says "You are an AO reviewer": you are a **REVIEWER** (follow §6).
- Not sure? Stop and ask the human. Do not guess your role.

## 1. Project snapshot
- Purpose: QueryLens — a 100% client-side interactive database internals visualizer (parser, planner, buffer pool, B+Tree index) in the browser.
- Stack: TypeScript, React 19, Vite 8, Tailwind CSS v4, CodeMirror 6, Vitest, Playwright.
- Layout:
  - `src/`: engine (parser, planner, optimizer, buffer pool, btree, locks, execution), visualizations, UI, state
  - `public/`: static assets
  - `scripts/`: build & utility scripts (bundle budget, og, fonts, icons, record, study)
  - `bin/`: CLI binary (`querylens.ts`)
  - `e2e/`: Playwright end-to-end tests
  - `docs/`: documentation, lessons (`docs/LESSONS.md`), task contracts (`docs/tasks/`)
- Base branch: `main`

## 2. Commands (exact, verified)
- Install: `pnpm install --frozen-lockfile`
- Test (all): `pnpm test`
- Test (single file/dir): `pnpm vitest run <path>`
- Lint: `pnpm lint`
- Typecheck: `pnpm typecheck`
- Format: `pnpm lint --fix`
- Build & Budget: `pnpm build && pnpm budget`
- CLI Smoke: `pnpm test:cli`
- **Full verification gate** (must pass before any merge):
  `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm budget && pnpm test:cli`
- Scope check: `scripts/verify-scope.sh <base-branch> <allowed-globs...>`

## 3. Orchestrator rules
- Never edit project source or test files. Edit only `PLAN.md`, `GEMINI.md`, `docs/**`.
- Commit doc changes to base branch before spawning workers; workers branch from it.
- Never run agy, tmux, or `git worktree` yourself for workers. AO does that.
- Workflow: ANALYZE → PLAN → human approval ("go") → DISPATCH → MONITOR → REVIEW → MERGE → LEARN.
- Task contracts live in `docs/tasks/<id>.md`; `docs/PLAN.md` is index/status table (avoids macOS case collision with root `plan.md`).
- Max 3 concurrent workers. Max 2 attempts per task, then rewrite contract or escalate.
- Merge one PR at a time, then run the full gate on base branch.
- Never force-push, rewrite base-branch history, or delete branches you did not create.

### AO cheatsheet (verified syntax only)
- Dispatch: `ao spawn --project query-lens --name "<label>" --prompt "<prompt>"` (requires `--name` ≤ 100 chars; no positional project arg)
- Overview: `ao status` · Sessions: `ao session ls`
- Message a worker: `ao send --session <session-id> --message "<msg>"`
- Steer a worker: `ao send --session <session-id> --steer --message "<msg>"`
- Recover/clean: `ao session restore <id>` · `ao session kill <id>` · `ao session cleanup --dry-run`
- Health: `ao doctor`
- Native code review trigger: `ao review trigger <session-id>`
- Native code review inspect: `ao review ls <session-id>`
- PR merge: `ao pr merge <pr-number>`
- Never invent subcommands (e.g. `ao dashboard` does not exist; use `ao status` or `ao start`). On error: run `<cmd> --help`, retry once, then inform user.

## 4. Worker rules
- You run in your own git worktree and branch. AO tracks you automatically. Don't run `ao`.
- Read `docs/tasks/<id>.md`. Touch only files in its `scope`. If anything outside is needed, stop, write reason to `.ao/blocked.md`, and finish.
- Make smallest change that meets deliverable. No refactors or drive-by fixes.
- Run task's `gate`. Fix and rerun until it exits 0. Never claim success without passing run.
- Never edit `GEMINI.md`, `PLAN.md`, or `docs/LESSONS.md`. Report lessons in PR body.
- Commit as `<id>: <title>`, push, open a PR. PR body must contain:
  `Deliverable`, `Gate output (last 20 lines)`, `Surprises`, `Proposed lesson (optional)`.
- If AO sends CI failures or review comments, fix on same branch, rerun gate, push.

## 5. Reviewer rules
- Do not edit code. Compare PR diff against task contract.
- Check: scope violations, deliverable gaps, weak/missing tests, debug leftovers, secrets, security, edge cases.
- Post verdict as PR comment: `PASS` or `CHANGES_NEEDED` with numbered issues (`file:line`).

## 6. Self-updating memory protocol
- Only orchestrator edits `GEMINI.md` and `docs/LESSONS.md`.
- Format: `- [YYYY-MM-DD][T<id>][area] Symptom → Cause → Fix/Rule.`
- Promote to `GEMINI.md` §7 if repo-wide, actionable, and verified.

## 7. Known quirks and repo-wide rules (promoted lessons)
- agy: `--print` must be LAST flag, or it swallows previous flag as prompt.
- agy: needs `--add-dir <repo>` or can only write to scratch (AO adapter passes this).
- agy: non-TTY output can return empty stdout; write results to files/PRs, not stdout.
- agy: concurrency ≤ 3.
- ao spawn: requires `--name <label>` (max 100 chars); no positional project argument.
- ao send: requires `--session <id>` and `--message "<msg>"`. Positional args fail.
- ao dashboard: command does not exist. Use `ao status` or `ao start` to open desktop app.
- fs: macOS APFS is case-insensitive; task index is kept in `docs/PLAN.md` so root `plan.md` is never overwritten.
- ao pr merge: requires GitHub PR metadata when untracked; use `gh pr merge <num> --repo SAM3114/query-lens --merge` as verified fallback.
- ao review submit: pass JSON stdin with `runId`, `verdict` ('approved'/'changes_requested'), and `body` to record reviewer outcomes.
- pnpm: requires `minimumReleaseAge: 0` override when adding packages (`pnpm install --config.minimumReleaseAge=0`).

## 8. Conventions
- Style: TypeScript strict, React 19 functional components, Tailwind v4 utility classes, no console.logs in production code.
- Tests: Every behavior change needs tests; bug fixes need regression tests.
- Commits: `<task-id>: <imperative summary>`.
- Do not edit: lockfiles, generated files, `.env*`, CI config — unless explicitly specified in task contract.

## 9. Safety
- Never read, print, or commit secrets. Never touch `.env*` or credential files.
- No destructive commands outside worktree (`rm -rf` on parents, force push).
- No network calls to production systems.
- If blocked, write `.ao/blocked.md`.

## 10. Definition of done
- Gate exits 0, scope check passes, CI green, reviewer verdict PASS (for non-trivial diffs), PR merged, `PLAN.md` status `merged`.
