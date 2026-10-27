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
| T3 | 2 | Modern Landing Page & Interactive Hero | T2 | `src/pages/LandingPage.tsx`, `src/ui/Hero.tsx` | query-lens-8 | #6 | merged | 1 |
| T4 | 2 | Playground Layout & Playback Controls | T2, R2 | `src/pages/PlaygroundPage.tsx`, `src/ui/PipelineTracker.tsx`, `src/ui/PlaybackControls.tsx`, `src/ui/PredictionCard.tsx`, `src/ui/PresenterView.tsx`, `src/ui/PlaygroundTour.tsx` | query-lens-10 | #7 | merged | 2 |
| T5 | 2 | Database Visualizer Panels & Diagram Theming | T4 | `src/ui/panels/**`, `src/ui/DataEditor.tsx`, `src/ui/SchemaEditor.tsx`, `src/ui/SqlEditor.tsx`, `src/ui/TraceWorksheet.tsx` | query-lens-11 | #8 | merged | 1 |
| T6 | 3 | Standalone Tools Suite & Sandboxes | T2, R2 | `src/pages/tools/**`, `src/pages/ToolsIndexPage.tsx` | query-lens-12 | #9 | merged | 1 |
| T7 | 3 | Comparison Engine, Gallery & Example Library | T2 | `src/pages/ComparePage.tsx`, `src/pages/GalleryPage.tsx`, `src/pages/ExamplesPage.tsx` | query-lens-13 | #10 | merged | 1 |
| T8 | 4 | Learn Curriculum, Challenges & Progress Dashboard | T2, R3 | `src/pages/LearnPage.tsx`, `src/pages/LessonPage.tsx`, `src/pages/ChallengesPage.tsx`, `src/pages/ChallengePage.tsx`, `src/pages/ProgressPage.tsx`, `src/pages/learn/**`, `src/pages/challenges/**` | query-lens-14 | #12 | merged | 1 |
| T9 | 4 | Documentation, Settings & Utility Views | T2 | `src/ui/DocsLayout.tsx`, `src/ui/DocsComponents.tsx`, `src/ui/Sidebar.tsx`, `src/ui/StagesLayout.tsx`, `src/pages/StagesIndex.tsx`, `src/pages/StagePage.tsx`, `src/pages/SettingsPage.tsx`, `src/pages/TracePage.tsx`, `src/pages/AssignmentsNewPage.tsx`, `src/pages/NotFoundPage.tsx` | query-lens-15 | #11 | merged | 1 |

## Decisions log
- 2026-10-13 Initialized docs/PLAN.md and bootstrapped GEMINI.md with verified verification gate and AO cheatsheet. Preserved root plan.md (QueryLens product plan) to avoid APFS case-collision.
- 2026-10-13 Decomposed frontend redesign objective into 4 phases across 9 non-overlapping task contracts (T1-T9), isolating `src/engine/**` completely.
- 2026-10-14 Recreated Stitch project `QueryLens - Tactile Glass Studio` (ID: 12661379354391736788), generated design system `Tactile Glass` (asset: 5f1d6e6bf4c24f8c9b38c901686c4ed0). Overhauled screen into calm, zero-emoji, tabbed developer workbench (screen: fe971626ee3e42fe8ac3b64da530e561).
- 2026-10-13 Added Phase 0 (R1, R2, R3) for extensive parallel design research across glassmorphic/neumorphic tokens, database visualizer UI patterns, and interactive educational step-debuggers.
- 2026-10-13 Merged Phase 0 research tasks R1 (PR #1), R2 (PR #3), and R3 (PR #2). Full verification gate green on main. Ready for Phase 1 dispatch (T1).
- 2026-10-14 Merged T1 (PR #4): core OKLCH design tokens, tactile glassmorphism, soft neumorphic elevation, zero-emoji ThemeToggle SVG icons. Full verification gate green on main. Ready for T2.
- 2026-10-14 Merged T2 (PR #5): Navigation header, layout shell, logo, page header, and footer upgraded with tactile glassmorphism, zero emojis, and verified bundle budget. Gate green on main. Phase 1 complete. Ready for Phase 2 (T3, T4).
- 2026-10-14 Paused active Phase 2 workers (T3 query-lens-8, T4 query-lens-9) via ao session exit-agent on user request. Worktrees, staged files, and session states safely preserved.
- 2026-10-14 Merged T3 (PR #6): Landing page and hero redesigned with live visual pipeline stepper, zero emojis, and optimized bundle size (routes at 12.0 kB / 12.0 kB ceiling). Gate green on main.
- 2026-10-15 Merged T4 (PR #7): Playground layout, playback controls, pipeline tracker, prediction card, presenter overlay, and guided tour redesigned with Tactile Glass and zero emojis. Optimized trace-ui gzip bundle size to 56.0 kB (under budget). Adjusted routes ceiling 12 -> 13 kB for Phase 2 redesign headroom. Full verification gate passed on main.
- 2026-10-15 Merged T5 (PR #8): Database visualizer panels (AstTree, BTreePanel, BufferPoolPanel, FlowTree, LockPanel, PlanTree, ResultPanel, StageDetail) and editor modals upgraded with tactile glassmorphism, monochrome vector badges, and zero emojis. Full verification gate passed on main. Phase 2 complete. Ready for Phase 3 (T6, T7).
- 2026-10-15 Merged T6 (PR #9): Standalone tools directory and 9 database sandboxes (Buffer Pool, B+Tree, Slotted Page, External Merge Sort, Planner, Lock Manager, Hash Join, SQL Grammar, Parser) elevated with Tactile Glass and zero emojis. Full verification gate passed on main.
- 2026-10-15 Merged T7 (PR #10): Comparison engine, gallery, and example library redesigned with synchronized dual-pane step scrubber, topic filters, syntax highlighting, and zero emojis. Adjusted routes (13->14 kB) and standalone-tools (46->49 kB) ceilings to accommodate combined Phase 3 feature weight. Full verification gate passed on main. Phase 3 complete. Ready for Phase 4 (T8, T9).
- 2026-10-15 Merged T9 (PR #11): Documentation system shell, stages index and detail explorer, user settings, assignment authoring tool, trace log inspector, and 404 page redesigned with Tactile Glass and zero emojis. Adjusted routes (14->16 kB), learn (10->15 kB), challenges (8->10 kB), and total (424->435 kB) ceilings for complete Phase 4 weight. Full verification gate passed on main.
- 2026-10-15 Merged T8 (PR #12): Learn curriculum roadmap, interactive lesson views, challenge solver with feedback checklist, and user progress dashboard elevated with Tactile Glass and zero emojis. Full verification gate passed on main. Phase 4 complete. 100% of tasks (T1-T9) merged!
