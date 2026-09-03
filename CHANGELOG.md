# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Self-hosted typefaces: JetBrains Mono and IBM Plex Sans (as `QueryLens Sans`), subset to the 235
  codepoints the app renders, ~30 kB each, preloaded and served under the existing `font-src 'self'`
  CSP. Previously the CSS named a font that was never shipped, so it appeared only for visitors who
  happened to have it installed
- Adjusted fallback faces with measured `ascent-override` / `descent-override` / `size-adjust`, so
  `font-display: swap` costs no layout shift
- Named type scale — six steps, one documented role each, with a display size that gives the scale a
  top. Tailwind's own scale is cleared, so every size in `src/` names its job
- Named motion scale — three durations, three curves — reachable from JavaScript via
  `src/ui/motion.ts`, and collapsing to zero under `prefers-reduced-motion`
- Hover and active states on every diagram element: buffer-pool frames, B+Tree/AST/plan nodes, lock
  rows, result rows and pipeline chips. Eight panels previously had one hover rule between them
- A real footer: Docs · GitHub · Licence · Changelog, and the build SHA, so bug reports identify
  their own build
- `apple-touch-icon.png`, generated from `favicon.svg`
- Scroll-snap between sections on phones
- Tabular figures on every number that changes during playback
- `scripts/build-fonts.py`, `scripts/build-icons.py` and `pnpm og` — the fonts, icons and link-preview
  card are all regenerated from source rather than hand-maintained
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md` — open-source governance files
- `CHANGELOG.md` — this file
- `NOTICE` — third-party licence attribution, now also covering the two bundled fonts
- GitHub issue templates and pull request template
- §16 (Visual Design Maturity), §17 (Documentation & User Manual), §18 (Community & Governance) and
  §19 (The Landing Page) added to `plan.md`

### Changed
- Tagline is now "Watch a SQL query become a B+Tree traversal." — concrete enough that reading the
  first screen tells you what the tool does
- Corner radius is constant (4px chrome, 2px inside diagrams) and the phone's sticky playback bar no
  longer uses `backdrop-blur`, per the design constraints in `plan.md` §16.1
- Every control now shows a pointer cursor. A `<button>` takes `cursor: default` from the user agent,
  so the cursor had been telling the user nothing
- The link-preview card is regenerated from a real trace at the first buffer eviction; its alt text
  said "four frames" through a change that made it eight

### Fixed
- The favicon's third page bar dropped out at 16px, so the stack read as two

## [0.1.0] - 2026-09-03

### Added
- Complete MVP: Parser → Planner → Optimizer → Execution → Buffer Pool → B+Tree Index → Locks → Result
- Recursive-descent SQL parser with AST visualization
- Rule-based query planner with predicate pushdown and index selection
- Buffer pool with pluggable replacement policies (LRU and clock sweep)
- B+Tree index with animated traversal, insert, and point/range lookup
- Volcano-style execution engine (SeqScan, IndexScan, Filter, Project)
- Page-level lock manager with crabbing for index descent
- Predict-then-reveal prompts at four pipeline stages
- Editable seed data with immediate re-execution
- Shareable URL state (query, policy, prediction mode, step index, custom rows)
- Light and dark themes with system preference detection
- Full keyboard navigation (Space, ←/→, Home, Mod+Enter)
- `prefers-reduced-motion` support
- Composited contrast sweep: zero elements below WCAG AA
- Error boundary with copyable crash repro
- CI pipeline (typecheck, lint, test, build) with SHA-pinned GitHub Actions
- Bundle budget enforcement (`pnpm budget`)
- End-to-end tests with Playwright and axe accessibility auditing
- Tested CSP security headers
- 326 unit tests, 14 end-to-end tests

[Unreleased]: https://github.com/Naveen-Boddepalli/QueryLens/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Naveen-Boddepalli/QueryLens/releases/tag/v0.1.0
