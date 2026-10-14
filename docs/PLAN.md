# PLAN.md

Maintained by the orchestrator. Contracts live in `docs/tasks/<id>.md`.
Status values: pending | running | pr_open | review | merged | failed

## Objective
Design and elevate the frontend of QueryLens into an ultra-clean, professional, developer-first database internals visualizer with cohesive glassmorphic & soft-neumorphic theming (derived from Stitch design systems), seamless light/dark modes, classic restrained micro-interactions (no over-animation), and complete feature focus.

## Constraints
- **Strict Backend Preservation**: Do NOT modify or disturb `src/engine/**` (parser, planner, optimizer, buffer pool, btree, locks, execution).
- **Scope Discipline**: Non-overlapping file globs per task; shared files belong to exactly one task.
- **Verification Gate**: Every task must pass `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm budget && pnpm test:cli` before PR submission and merge.

## Acceptance Criteria
- Full visual consistency across all routes (`/`, `/playground`, `/stages`, `/tools`, `/compare`, `/gallery`, `/examples`, `/learn`, `/docs`, `/settings`).
- Complete dark and light theme fidelity using OKLCH semantic surface, glassmorphic backdrop filters, and soft-neumorphic depth.
- 100% of the verification gate passing (1228+ tests, clean linter, bundle budget within thresholds).

## Tasks
| id | phase | title | depends_on | scope | session | PR | status | attempts |
|----|-------|-------|------------|-------|---------|----|--------|----------|
| R1 | 0 | Design Research: Glassmorphism & Neumorphism for DevTools | none | `docs/research/glass-neumorphic-system.md` | query-lens-3 | #1 | merged | 1 |
| R2 | 0 | Design Research: Database Internals Visualizers & High-Density UI | none | `docs/research/database-internals-ui.md` | query-lens-4 | #3 | merged | 1 |
| R3 | 0 | Design Research: Interactive Learning & Step-Debugger UX | none | `docs/research/interactive-learning-ux.md` | query-lens-5 | #2 | merged | 1 |
| T1 | 1 | Design Tokens, Typography & Primitive Controls | R1 | `src/index.css`, `src/ui/primitives.ts`, `src/ui/theme.ts`, `src/ui/ThemeContext.tsx`, `src/ui/ThemeToggle.tsx` | query-lens-6 | #4 | merged | 1 |
| T2 | 1 | Navigation, Layout Shell & Global Chrome | T1 | `src/ui/TopNav.tsx`, `src/ui/Footer.tsx`, `src/ui/Layout.tsx`, `src/ui/Logo.tsx`, `src/ui/PageHeader.tsx` | query-lens-7 | #5 | merged | 1 |
| T3 | 2 | Modern Landing Page & Interactive Hero | T2 | `src/pages/LandingPage.tsx`, `src/ui/Hero.tsx` | query-lens-8 | - | paused | 1 |
| T4 | 2 | Playground Layout & Playback Controls | T2, R2 | `src/pages/PlaygroundPage.tsx`, `src/ui/PipelineTracker.tsx`, `src/ui/PlaybackControls.tsx`, `src/ui/PredictionCard.tsx`, `src/ui/PresenterView.tsx`, `src/ui/PlaygroundTour.tsx` | query-lens-9 | - | paused | 1 |
| T5 | 2 | Database Visualizer Panels & Diagram Theming | T4 | `src/ui/panels/**`, `src/ui/DataEditor.tsx`, `src/ui/SchemaEditor.tsx`, `src/ui/SqlEditor.tsx`, `src/ui/TraceWorksheet.tsx` | - | - | pending | 0 |
| T6 | 3 | Standalone Tools Suite & Sandboxes | T2, R2 | `src/pages/tools/**`, `src/pages/ToolsIndexPage.tsx` | - | - | pending | 0 |
| T7 | 3 | Comparison Engine, Gallery & Example Library | T2 | `src/pages/ComparePage.tsx`, `src/pages/GalleryPage.tsx`, `src/pages/ExamplesPage.tsx` | - | - | pending | 0 |
| T8 | 4 | Learn Curriculum, Challenges & Progress Dashboard | T2, R3 | `src/pages/LearnPage.tsx`, `src/pages/LessonPage.tsx`, `src/pages/ChallengesPage.tsx`, `src/pages/ChallengePage.tsx`, `src/pages/ProgressPage.tsx`, `src/pages/learn/**`, `src/pages/challenges/**` | - | - | pending | 0 |
| T9 | 4 | Documentation, Settings & Utility Views | T2 | `src/ui/DocsLayout.tsx`, `src/ui/DocsComponents.tsx`, `src/ui/Sidebar.tsx`, `src/ui/StagesLayout.tsx`, `src/pages/StagesIndex.tsx`, `src/pages/StagePage.tsx`, `src/pages/SettingsPage.tsx`, `src/pages/TracePage.tsx`, `src/pages/AssignmentsNewPage.tsx`, `src/pages/NotFoundPage.tsx` | - | - | pending | 0 |

## Decisions log
- 2026-10-13 Initialized docs/PLAN.md and bootstrapped GEMINI.md with verified verification gate and AO cheatsheet. Preserved root plan.md (QueryLens product plan) to avoid APFS case-collision.
- 2026-10-13 Decomposed frontend redesign objective into 4 phases across 9 non-overlapping task contracts (T1-T9), isolating `src/engine/**` completely.
- 2026-10-14 Recreated Stitch project `QueryLens - Tactile Glass Studio` (ID: 12661379354391736788), generated design system `Tactile Glass` (asset: 5f1d6e6bf4c24f8c9b38c901686c4ed0). Overhauled screen into calm, zero-emoji, tabbed developer workbench (screen: fe971626ee3e42fe8ac3b64da530e561).
- 2026-10-13 Added Phase 0 (R1, R2, R3) for extensive parallel design research across glassmorphic/neumorphic tokens, database visualizer UI patterns, and interactive educational step-debuggers.
- 2026-10-13 Merged Phase 0 research tasks R1 (PR #1), R2 (PR #3), and R3 (PR #2). Full verification gate green on main. Ready for Phase 1 dispatch (T1).
- 2026-10-14 Merged T1 (PR #4): core OKLCH design tokens, tactile glassmorphism, soft neumorphic elevation, zero-emoji ThemeToggle SVG icons. Full verification gate green on main. Ready for T2.
- 2026-10-14 Merged T2 (PR #5): Navigation header, layout shell, logo, page header, and footer upgraded with tactile glassmorphism, zero emojis, and verified bundle budget. Gate green on main. Phase 1 complete. Ready for Phase 2 (T3, T4).
- 2026-10-14 Paused active Phase 2 workers (T3 query-lens-8, T4 query-lens-9) via ao session exit-agent on user request. Worktrees, staged files, and session states safely preserved.
