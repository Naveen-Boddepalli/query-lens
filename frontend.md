# QueryLens — Frontend Developer Reference

> **Purpose of this document:** Everything a frontend developer needs to understand, build upon, or redesign the QueryLens UI — without reading a single source file first. This document is the single source of truth for the frontend layer.

---

## Table of Contents

- [1. Project Overview](#1-project-overview)
- [2. Tech Stack & Tooling](#2-tech-stack--tooling)
- [3. Project Structure](#3-project-structure)
- [4. Architecture Overview](#4-architecture-overview)
- [5. Entry Points & Bootstrap](#5-entry-points--bootstrap)
- [6. Routing](#6-routing)
- [7. Design System](#7-design-system)
- [8. Component Reference](#8-component-reference)
- [9. State Management](#9-state-management)
- [10. The Engine (Backend-in-Browser)](#10-the-engine-backend-in-browser)
- [11. Data Models & Types](#11-data-models--types)
- [12. Key User Flows](#12-key-user-flows)
- [13. Accessibility](#13-accessibility)
- [14. Performance & Bundle Strategy](#14-performance--bundle-strategy)
- [15. Deployment & Hosting](#15-deployment--hosting)
- [16. Testing](#16-testing)
- [17. Environment & Configuration](#17-environment--configuration)
- [18. CI/CD](#18-cicd)
- [19. Commands Reference](#19-commands-reference)
- [20. File-by-File Inventory](#20-file-by-file-inventory)

---

## 1. Project Overview

**QueryLens** is an **in-browser toy relational database engine** that animates a SQL query as it moves through the full pipeline:

```
Parser → Planner → Optimizer → Execution → Buffer Pool → B+Tree Index → Locks → Result
```

It is a **learning tool**, not a production database. The user types SQL (`SELECT`, `DELETE`, `INSERT`, `UPDATE` — with `JOIN`, `GROUP BY`, `ORDER BY`, `LIMIT`), steps through the trace one event at a time, and sees exactly what the engine did to answer it. It uses a **predict-then-reveal** pedagogical model: the user is asked to predict what happens next before each step is shown.

**Key characteristics:**
- **100% client-side** — no server, no API, no backend, no database. The "database engine" runs entirely in-browser as pure TypeScript.
- **No telemetry** — no analytics, no error tracking, no cookies. A deliberate, documented decision.
- **Static deploy** — `pnpm build` produces a static `dist/` folder deployed to Cloudflare Pages.
- **MIT licensed** (code), CC BY 4.0 (documentation), OFL 1.1 (fonts).
- **GitHub repo:** `https://github.com/Naveen-Boddepalli/query-lens`

---

## 2. Tech Stack & Tooling

### Core

| Technology | Version | Purpose |
|---|---|---|
| React | 19.3.0 | UI framework |
| TypeScript | 6.0.3 | Language |
| Vite | 8.3.0 | Build tool & dev server |
| Tailwind CSS | 4.3.3 | Utility-first styling (with `@tailwindcss/vite` plugin) |
| React Router DOM | 7.18.3 | Client-side routing (BrowserRouter) |

### Key Libraries

| Library | Version | Purpose |
|---|---|---|
| `flowinger` | 0.3.0 (npm) | Interactive node-based tree diagrams (AST, plan tree, B+Tree). Our own renderer; replaced `@xyflow/react` and keeps its API shape (`Handle`, `useReactFlow`; `ReactFlow` is its whole canvas, `FlowingerCore` the lean one `FlowTree` uses) |
| `@codemirror/*` | 6.x | SQL editor with syntax highlighting, autocomplete, error marks |
| `d3-hierarchy` | 3.1.2 | Tree layout calculations for diagram rendering |
| `html-to-image` | 1.11.13 | PNG export of panels (lazy-loaded) |
| `@mdx-js/rollup` + `@mdx-js/react` | 3.x | MDX documentation pages compiled to React components |
| `@tailwindcss/typography` | 0.5.20 | Prose styling for docs pages |
| `rehype-slug` | 6.0.0 | Auto-generates heading IDs for docs navigation |
| `remark-gfm` | 4.0.1 | GitHub-flavoured Markdown (tables, etc.) |
| `remark-frontmatter` + `remark-mdx-frontmatter` | 5.x | YAML frontmatter in MDX files |

### Dev Tooling

| Tool | Purpose |
|---|---|
| pnpm 11.1.2 | Package manager (monorepo-capable) |
| Node ≥ 22.13.0 | Runtime |
| Vitest 5.0.1 | Unit testing (jsdom environment) |
| Playwright 1.63.0 | End-to-end testing |
| ESLint 10 | Linting (with `jsx-a11y`, `react-hooks`, `react-refresh` plugins) |
| `fast-check` 4.9.0 | Property-based testing |

---

## 3. Project Structure

```
QueryLens/
├── public/                     # Static assets (served as-is)
│   ├── _headers                # Cloudflare Pages security headers (CSP, HSTS, etc.)
│   ├── _redirects              # SPA fallback: /* → /index.html 200
│   ├── 404.html                # Fallback 404 (last resort)
│   ├── apple-touch-icon.png    # iOS home screen icon (180×180)
│   ├── favicon.svg             # SVG favicon
│   ├── og.png                  # Open Graph card image (1200×630)
│   ├── robots.txt              # Search engine directives
│   ├── theme.js                # Anti-flash theme script (blocking, runs before React)
│   └── fonts/
│       ├── querylens-sans.woff2  # Variable font (400-700), subset to 235 codepoints
│       └── querylens-mono.woff2  # JetBrains Mono variable font, subset
│
├── src/
│   ├── main.tsx                # React entry point
│   ├── App.tsx                 # Root component: ThemeProvider → BrowserRouter → Routes
│   ├── routes.ts               # Single source of truth for nav items
│   ├── docsNav.ts              # Docs sidebar structure
│   ├── buildInfo.ts            # Build SHA, timestamp, repo URL
│   ├── index.css               # Global styles: design tokens, fonts, prose, print, a11y
│   ├── vite-env.d.ts           # Vite type declarations
│   │
│   ├── engine/                 # The in-browser database engine (PURE, NO DOM, NO REACT)
│   │   ├── index.ts            # Public API barrel export
│   │   ├── types.ts            # All shared types and interfaces
│   │   ├── runQuery.ts         # Main entry: SQL → RunResult (events + rows)
│   │   ├── trace.ts            # Trace builder (step event collector)
│   │   ├── viewState.ts        # Event → ViewState reducer (what the UI renders)
│   │   ├── seed.ts             # Default seed database (48-row users table)
│   │   ├── datasets.ts         # Preset datasets: users, orders, logins, employees, transactions
│   │   ├── predict.ts          # Prediction prompt generation
│   │   ├── bufferTrace.ts      # Standalone buffer-pool trace runner
│   │   ├── parser/             # SQL tokenizer + recursive-descent parser → AST
│   │   ├── planner/            # AST → logical plan → cost model → optimizer rewrites
│   │   ├── exec/               # Volcano-style row-at-a-time executor
│   │   ├── storage/            # Buffer pool (LRU, clock, FIFO, second-chance, optimal)
│   │   ├── index/              # B+Tree implementation (insert, delete, search, range)
│   │   └── locks/              # Page-level lock manager (shared/exclusive)
│   │
│   ├── pages/                  # Route-level page components (all lazy-loaded)
│   │   ├── PlaygroundPage.tsx   # The main SQL playground (primary UX)
│   │   ├── LandingPage.tsx      # Landing hub (/) with hero + navigation
│   │   ├── ExamplesPage.tsx     # Preset example queries
│   │   ├── GalleryPage.tsx      # Curated "named moments" gallery
│   │   ├── ComparePage.tsx      # Side-by-side comparison (4 modes)
│   │   ├── TracePage.tsx        # Raw trace event inspector
│   │   ├── LearnPage.tsx        # Structured learning path index
│   │   ├── LessonPage.tsx       # Individual lesson viewer
│   │   ├── ChallengesPage.tsx   # Challenge list
│   │   ├── ChallengePage.tsx    # Individual challenge viewer
│   │   ├── ProgressPage.tsx     # User progress dashboard
│   │   ├── SettingsPage.tsx     # User preferences (theme, default policy, etc.)
│   │   ├── AssignmentsNewPage.tsx # Assignment URL builder (for instructors)
│   │   ├── StagesIndex.tsx      # Pipeline stages overview
│   │   ├── StagePage.tsx        # Individual stage detail (/stages/:stageId)
│   │   ├── ToolsIndexPage.tsx   # Standalone tools index
│   │   ├── NotFoundPage.tsx     # 404 page
│   │   ├── challenges/          # Challenge definitions
│   │   │   └── challenges.tsx
│   │   ├── learn/               # Lesson definitions
│   │   │   └── lessons.tsx
│   │   ├── tools/               # Standalone tool pages
│   │   │   ├── BTreeToolPage.tsx
│   │   │   ├── BufferPoolToolPage.tsx
│   │   │   ├── GrammarToolPage.tsx
│   │   │   ├── HashJoinToolPage.tsx
│   │   │   ├── LocksToolPage.tsx
│   │   │   ├── PageToolPage.tsx
│   │   │   ├── ParserToolPage.tsx
│   │   │   ├── PlannerToolPage.tsx
│   │   │   └── SortToolPage.tsx
│   │   └── DocsContent/         # MDX documentation pages (compiled to React components)
│   │       ├── index.mdx        # Docs overview
│   │       ├── getting-started.mdx
│   │       ├── faq.mdx
│   │       ├── architecture.mdx
│   │       ├── concepts/
│   │       │   ├── buffer-pool.mdx  # Has live embedded widget (DocsBTreeDemo)
│   │       │   └── btree.mdx        # Has live embedded widget (DocsBufferPoolDemo)
│   │       ├── manual/
│   │       │   ├── eviction.mdx
│   │       │   └── btree-split.mdx
│   │       └── reference/
│   │           ├── sql.mdx
│   │           ├── url-parameters.mdx
│   │           ├── shortcuts.mdx
│   │           └── limits.mdx
│   │
│   ├── ui/                     # Reusable UI components, hooks, and utilities
│   │   ├── Layout.tsx           # Root layout shell (disclaimer + nav + outlet + footer)
│   │   ├── TopNav.tsx           # Sticky top navigation bar
│   │   ├── Footer.tsx           # 4-column footer (brand + 3 nav columns)
│   │   ├── Sidebar.tsx          # Pipeline stage sidebar (for /stages)
│   │   ├── StagesLayout.tsx     # Layout wrapper for /stages routes
│   │   ├── Hero.tsx             # Landing page hero section
│   │   ├── Logo.tsx             # SVG logo component
│   │   ├── ThemeContext.tsx      # React context provider for theme
│   │   ├── ThemeToggle.tsx       # Light/dark/system toggle button
│   │   ├── DisclaimerBanner.tsx  # "Simplified model, not a production DB" top banner
│   │   ├── ErrorBoundary.tsx     # React error boundary (page + panel variants)
│   │   ├── FirstVisitHint.tsx    # First-time visitor welcome hint
│   │   ├── SqlEditor.tsx         # CodeMirror-based SQL editor
│   │   ├── CodeMirrorEditor.tsx  # Low-level CodeMirror wrapper
│   │   ├── DataEditor.tsx        # Modal editor for seed table rows
│   │   ├── SchemaEditor.tsx      # Modal editor for custom database schemas
│   │   ├── PipelineTracker.tsx   # 8-stage progress rail (parse → result)
│   │   ├── PlaybackControls.tsx  # Transport controls (play, pause, step, scrub, speed)
│   │   ├── PredictionCard.tsx    # Predict-then-reveal question card
│   │   ├── PresenterView.tsx     # Room-facing presentation overlay
│   │   ├── PlaygroundTour.tsx    # 60-second guided tour overlay
│   │   ├── TraceWorksheet.tsx    # Print-only trace summary
│   │   ├── ShortcutHints.tsx     # Keyboard shortcut hints below controls
│   │   ├── CopyButton.tsx        # Generic "copy to clipboard" button
│   │   ├── DownloadPngButton.tsx  # PNG export of a panel
│   │   ├── DownloadSvgButton.tsx  # SVG export of a tree
│   │   ├── PageHeader.tsx        # Reusable page header (title + blurb)
│   │   ├── DocsLayout.tsx        # Docs sidebar + content layout
│   │   ├── DocsComponents.tsx    # MDX component overrides (Steps, Card, DocMeta, Contents)
│   │   ├── DocsBTreeDemo.tsx     # Live B+Tree widget for docs pages
│   │   ├── DocsBufferPoolDemo.tsx # Live buffer pool widget for docs pages
│   │   │
│   │   ├── panels/              # Visualization panels (one per pipeline stage)
│   │   │   ├── StageDetail.tsx   # Orchestrator: picks the right panel for a stage
│   │   │   ├── AstTree.tsx       # AST tree visualization (flowinger)
│   │   │   ├── PlanTree.tsx      # Plan tree visualization (flowinger)
│   │   │   ├── FlowTree.tsx      # Generic flowinger tree wrapper
│   │   │   ├── BTreePanel.tsx    # B+Tree visualization (flowinger)
│   │   │   ├── BufferPoolPanel.tsx # Buffer pool frame grid
│   │   │   ├── LockPanel.tsx     # Lock visualization
│   │   │   ├── ResultPanel.tsx   # Result rows table
│   │   │   ├── astTreeTones.ts   # AST node colour mapping
│   │   │   ├── btreeTones.ts     # B+Tree node colour mapping
│   │   │   └── planTreeTones.ts  # Plan node colour mapping
│   │   │
│   │   ├── theme.ts             # Theme hook (light/dark/system + localStorage)
│   │   ├── usePlayback.ts       # Playback hook (step, play, pause, speed, gates)
│   │   ├── useReducedMotion.ts  # prefers-reduced-motion hook
│   │   ├── urlState.ts          # URL ↔ ShareState serializer (address bar = persistence)
│   │   ├── preferences.ts       # localStorage preferences (default policy, predict)
│   │   ├── stageMeta.ts         # Metadata for each pipeline stage (title, blurb, color)
│   │   ├── primitives.ts        # Shared className strings (btnPrimary, panelSurface, etc.)
│   │   ├── platform.ts          # Platform detection (Apple vs PC, touch vs desktop)
│   │   ├── motion.ts            # CSS duration tokens read from JS
│   │   ├── progress.ts          # User progress tracker (localStorage)
│   │   ├── challengeProgress.ts # Challenge completion tracker
│   │   ├── learnProgress.ts     # Learn module progress tracker
│   │   ├── firstVisit.ts        # First-visit detection + tour trigger
│   │   ├── datasetCatalogue.ts  # Dataset UI metadata (labels, starter SQL, presets)
│   │   ├── customDatabase.ts    # Custom database localStorage persistence
│   │   ├── editorMarks.ts       # CodeMirror decoration/mark utilities
│   │   ├── errorReport.ts       # Console error formatting + global error handlers
│   │   ├── parseCsv.ts          # CSV parser for data import
│   │   ├── grammar.ts           # Grammar visualization utilities
│   │   ├── hashJoin.ts          # Hash join visualization utilities
│   │   ├── externalSort.ts      # External sort visualization utilities
│   │   ├── lockSimulation.ts    # Lock simulation utilities
│   │   ├── slottedPage.ts       # Slotted page visualization
│   │   ├── traceFile.ts         # Trace file serializer/deserializer (JSON)
│   │   ├── stepAnnouncement.ts  # Screen reader announcements for steps
│   │   ├── renderSvg.ts        # SVG rendering for tree exports
│   │   └── assignmentSet.ts    # Assignment URL generation
│   │
│   ├── export/                  # Export utilities
│   │   ├── index.ts
│   │   ├── toMermaid.ts         # Tree → Mermaid flowchart syntax
│   │   └── toText.ts            # Tree → monospace text
│   │
│   └── test/
│       └── setup.ts             # Vitest setup (jsdom, testing-library matchers)
│
├── e2e/                         # Playwright end-to-end tests
├── bin/                         # CLI tool (querylens trace runner)
├── scripts/                     # Build scripts (bundle budget, OG image, fonts, etc.)
├── build/                       # Build configuration
├── .github/                     # GitHub Actions CI/CD
│
├── index.html                   # HTML entry point (loads theme.js + /src/main.tsx)
├── vite.config.ts               # Vite + Vitest config
├── package.json                 # Dependencies and scripts
├── tsconfig.json                # TypeScript config
├── eslint.config.js             # ESLint config
├── playwright.config.ts         # Playwright config
├── pnpm-workspace.yaml          # pnpm workspace config
└── plan.md                      # Full decision log (265KB — the "why" behind everything)
```

---

## 4. Architecture Overview

### Engine / UI Split

```
┌─────────────────────────────────────────────────────────────┐
│                        UI Layer (React)                      │
│  ┌──────────┐  ┌────────────┐  ┌─────────────────────────┐  │
│  │ SqlEditor │  │ Playback   │  │ StageDetail             │  │
│  │           │  │ Controls   │  │  ├─ AstTree (flowinger)  │  │
│  │ CodeMirror│  │ usePlayback│  │  ├─ PlanTree             │  │
│  │ SQL input │  │ hook       │  │  ├─ BufferPoolPanel      │  │
│  │           │  │            │  │  ├─ BTreePanel           │  │
│  └──────────┘  └────────────┘  │  ├─ LockPanel            │  │
│                                │  └─ ResultPanel           │  │
│  ┌──────────────────────────┐  └─────────────────────────┘  │
│  │ ViewState (derived from events by a pure reducer)        │  │
│  └──────────────────────────────────────────────────────────┘  │
└───────────────────────────┬─────────────────────────────────┘
                            │  runQuery(sql, db, options)
                            │  returns RunResult { events[], rows[] }
┌───────────────────────────▼─────────────────────────────────┐
│                    Engine Layer (Pure TypeScript)             │
│  ┌────────┐ ┌────────┐ ┌──────────┐ ┌──────────┐ ┌──────┐  │
│  │ Parser │→│Planner │→│Optimizer │→│Executor  │→│Result│  │
│  │        │ │        │ │          │ │ ┌──────┐ │ │      │  │
│  │Tokenize│ │Logical │ │Rule-based│ │ │Buffer│ │ │      │  │
│  │ + AST  │ │ plan   │ │rewrites  │ │ │ Pool │ │ │      │  │
│  │        │ │        │ │          │ │ │B+Tree│ │ │      │  │
│  │        │ │Cost    │ │Predicate │ │ │Locks │ │ │      │  │
│  │        │ │model   │ │pushdown  │ │ └──────┘ │ │      │  │
│  └────────┘ └────────┘ └──────────┘ └──────────┘ └──────┘  │
│                                                              │
│  Rules: Pure, synchronous, no DOM, no React, no I/O          │
│  Every value is structurally cloneable (worker-ready)        │
└──────────────────────────────────────────────────────────────┘
```

### Data Flow

1. User types SQL in the `SqlEditor` (CodeMirror).
2. User clicks **Run** (or `⌘↵` / `Ctrl+↵`).
3. `runQuery(sql, database, engineOptions)` runs the full pipeline synchronously.
4. Returns `RunResult`: an array of `StepEvent[]` (deltas) + final `rows[]`.
5. `createTraceProjector(events, options)` creates an incremental folder.
6. `usePlayback(length)` manages step position (play/pause/step/seek/speed).
7. `projector.at(step)` returns `ViewState` at the current step (O(1) amortised forward).
8. `StageDetail` renders the correct panel based on the active stage.
9. The URL is updated via `replaceState` to encode the full moment (shareable link).

### No Server — The URL IS the Database

The address bar is the **only persistence layer**. A shareable URL encodes:

| Parameter | Key | Description |
|---|---|---|
| SQL query | `q` | The SQL text |
| Eviction policy | `p` | `lru`, `clock`, `fifo`, `second-chance`, `optimal`, `midpoint`, `lru-k` or `two-q` |
| Predict mode | `x` | `0` or `1` |
| Step position | `s` | Integer step number |
| Dataset | `t` | `users`, `orders`, `logins`, `employees` or `transactions` |
| Edited rows | `d` | JSON-encoded row arrays (only if modified) |
| Assignment lock | `l` | `1` = assignment mode |

Example: `/playground?q=SELECT+*+FROM+users+WHERE+id+%3D+5%3B&p=lru&x=1&s=5`

---

## 5. Entry Points & Bootstrap

### Boot Sequence

1. **`index.html`** — loaded by the browser.
   - Preloads two fonts (`querylens-sans.woff2`, `querylens-mono.woff2`).
   - Loads `public/theme.js` synchronously (blocking) — resolves `data-theme` attribute **before first paint** to prevent theme flash.
   - Injects `<script type="module" src="/src/main.tsx">`.

2. **`src/main.tsx`** — React entry:
   - Installs global error handlers (`window.onerror`, `unhandledrejection`).
   - Logs build banner to console (SHA + timestamp).
   - Creates React 19 root with `onUncaughtError` + `onRecoverableError` hooks.
   - Renders `<StrictMode> → <ErrorBoundary variant="page"> → <App />`.

3. **`src/App.tsx`** — Root component:
   - `<ThemeProvider>` — React context for light/dark theme state.
   - `<BrowserRouter>` — client-side routing.
   - `<Route element={<Layout />}>` — persistent shell wrapping all pages.
   - Every page component is `React.lazy()` — code-split automatically.

### Anti-Flash Theme System

Two halves work together:
- **`public/theme.js`** (blocking script, runs before React) — reads `localStorage('querylens:theme')` or `prefers-color-scheme`, sets `document.documentElement.dataset.theme`.
- **`src/ui/theme.ts`** (React hook) — interactive half that handles toggling. Both agree on one storage key (`querylens:theme`) and one attribute (`data-theme`).

---

## 6. Routing

### Route Table

All routes are defined in `App.tsx`. Navigation items are in `src/routes.ts`.

| Path | Component | Nav? | Description |
|---|---|---|---|
| `/` | `LandingPage` | — | Landing hub (hero + navigation). Redirects to `/playground` if share params present |
| `/playground` | `PlaygroundPage` | ✅ | **Main UX** — SQL editor, trace viewer, all panels |
| `/stages` | `StagesLayout > StagesIndex` | ✅ | Pipeline stages overview with sidebar |
| `/stages/:stageId` | `StagesLayout > StagePage` | — | Individual stage detail (parse, plan, optimize, execute, buffer, index, lock, result) |
| `/learn` | `LearnPage` | ✅ | Structured learning path index |
| `/learn/:lessonId` | `LessonPage` | — | Individual lesson |
| `/gallery` | `GalleryPage` | ✅ | Curated named moments gallery |
| `/tools` | `ToolsIndexPage` | ✅ | Standalone tools index |
| `/tools/buffer-pool` | `BufferPoolToolPage` | — | Standalone buffer pool sandbox (5 policies) |
| `/tools/parser` | `ParserToolPage` | — | Standalone parser tool |
| `/tools/btree` | `BTreeToolPage` | — | Standalone B+Tree tool |
| `/tools/page` | `PageToolPage` | — | Slotted page visualization |
| `/tools/sort` | `SortToolPage` | — | External sort visualization |
| `/tools/planner` | `PlannerToolPage` | — | Standalone planner/optimizer tool |
| `/tools/locks` | `LocksToolPage` | — | Lock simulation tool |
| `/tools/grammar` | `GrammarToolPage` | — | SQL grammar visualization |
| `/tools/hash-join` | `HashJoinToolPage` | — | Hash join visualization |
| `/compare` | `ComparePage` | ✅ | Side-by-side comparison (4 modes: policies, index vs seq scan, hash vs sort aggregate, join algorithms) |
| `/examples` | `ExamplesPage` | ✅ | Example queries with one-click load |
| `/docs` | `DocsLayout > DocsIndex` | ✅ | Documentation home |
| `/docs/getting-started` | MDX page | — | Getting started guide |
| `/docs/faq` | MDX page | — | Frequently asked questions |
| `/docs/concepts/buffer-pool` | MDX page | — | Buffer pool concept (live widget) |
| `/docs/concepts/btree` | MDX page | — | B+Tree concept (live widget) |
| `/docs/manual/eviction` | MDX page | — | Task: watch a page get evicted |
| `/docs/manual/btree-split` | MDX page | — | Task: watch a B+Tree split |
| `/docs/reference/sql` | MDX page | — | Supported SQL reference |
| `/docs/reference/url-parameters` | MDX page | — | URL parameter reference |
| `/docs/reference/shortcuts` | MDX page | — | Keyboard shortcuts reference |
| `/docs/reference/limits` | MDX page | — | Engine limits reference |
| `/docs/architecture` | MDX page | — | Architecture for contributors |
| `/settings` | `SettingsPage` | Footer | User preferences |
| `/assignments/new` | `AssignmentsNewPage` | Footer | Assignment URL builder |
| `/trace` | `TracePage` | Footer | Raw trace event inspector |
| `/challenges` | `ChallengesPage` | Footer | Challenge list |
| `/challenges/:challengeId` | `ChallengePage` | — | Individual challenge |
| `/progress` | `ProgressPage` | Footer | User progress dashboard |
| `*` | `NotFoundPage` | — | 404 catch-all |

### Navigation Sources

- **`src/routes.ts`** (`NAV_ITEMS`) — single source for top nav and footer links.
- **`src/docsNav.ts`** (`DOCS_NAV`) — docs sidebar and footer's Documentation column.
- **`src/ui/stageMeta.ts`** (`STAGE_META`) — pipeline stage sidebar navigation.

---

## 7. Design System

### 7.1 Colour Tokens

All colours are CSS custom properties defined in `src/index.css` using **oklch** colour space. They **flip automatically** under `[data-theme='light']`.

#### Surface Ramp (Dark Theme)

| Token | Value | Usage |
|---|---|---|
| `--color-surface` | oklch(0.155 0.014 264) | Page background |
| `--color-surface-2` | oklch(0.195 0.016 264) | Elevated panels, cards |
| `--color-surface-3` | oklch(0.238 0.018 264) | Hover states, inputs |
| `--color-surface-4` | oklch(0.29 0.02 264) | Deep hover, scrollbar thumb |
| `--color-edge` | oklch(0.34 0.02 264) | Borders |
| `--color-ink` | oklch(0.96 0.004 264) | Primary text |
| `--color-ink-dim` | oklch(0.72 0.016 264) | Secondary/dimmed text |

#### Accent

| Token | Usage |
|---|---|
| `--color-accent` | Primary accent (links, active states) |
| `--color-accent-strong` | Luminous accent (glow, hero) |
| `--color-accent-soft` | Translucent accent fill |

#### Semantic Colours

| Token | Usage |
|---|---|
| `--color-hit` | Buffer pool hit (green) |
| `--color-miss` | Buffer pool miss (amber) |
| `--color-evict` | Buffer pool eviction / errors (red-orange) |
| `--color-node-internal` | B+Tree internal nodes (pink) |
| `--color-node-leaf` | B+Tree leaf nodes (green) |

#### Pipeline Stage Colours

Each stage has a dedicated colour token: `--color-stage-parse`, `--color-stage-plan`, `--color-stage-optimize`, `--color-stage-execute`, `--color-stage-buffer`, `--color-stage-index`, `--color-stage-lock`, `--color-stage-result`.

#### Diagram Hues

Five hue pairs (`sky`, `violet`, `amber`, `emerald`, `orange`) with `-line` and `-ink` variants for AST nodes, plan tree nodes, and other diagrams.

### 7.2 Typography Scale

Custom scale — Tailwind's default scale is **cleared** and replaced:

| Token | Size | Role |
|---|---|---|
| `--text-hero` | clamp(2.25rem, 1.4rem + 3.6vw, 3.5rem) | Landing headline |
| `--text-display` | 1.75rem | Wordmark, page titles |
| `--text-heading` | 1.25rem | Stage titles, dialog titles |
| `--text-body` | 0.9375rem | Prose, narration, buttons |
| `--text-code` | 0.875rem | SQL, editor gutter |
| `--text-label` | 0.8125rem | Field labels, chips, table headers |
| (micro) | via inline | Annotations inside diagrams |

**Fonts:**
- **Text face:** `QueryLens Sans` (variable, 400-700, based on a self-hosted OFL font) + `QueryLens Sans Fallback` (adjusted Arial metrics)
- **Monospace:** `JetBrains Mono` (variable, 400-700) + `JetBrains Mono Fallback` (adjusted Courier New metrics)
- Both are preloaded in `<head>`, ~30KB each, subset to 235 codepoints.
- Font-metric fallbacks eliminate layout shift during swap.

### 7.3 Spacing Scale

Based on Tailwind's 2px base unit. Named tokens map to Tailwind utilities:

| Token | Value | Tailwind | Usage |
|---|---|---|---|
| `--space-0-5` | 2px | `gap-0.5` | Hairline gaps inside chips |
| `--space-1` | 4px | `p-1` | Tightest readable padding |
| `--space-2` | 8px | `gap-2` | Default sibling gap |
| `--space-4` | 16px | `p-4` | Panel padding, page gutter |
| `--space-6` | 24px | `gap-6` | Between major regions |
| `--space-8` | 32px | `gap-8` | Between sections on prose pages |

**Density rule:** 2px steps inside dense chrome, 4px steps and up for layout.

### 7.4 Elevation (Shadows)

| Token | Usage |
|---|---|
| `--shadow-e1` | Subtle: chips, inputs, small controls |
| `--shadow-e2` | Medium: panels, cards |
| `--shadow-e3` | Heavy: modals, overlays |
| `--shadow-glow` | Accent glow: current/active element |

### 7.5 Border Radius Scale

| Token | Value |
|---|---|
| `--radius-xs` | 4px |
| `--radius-sm` | 6px |
| `--radius-md` | 8px |
| `--radius-lg` | 12px |
| `--radius-xl` | 16px |
| `--radius-2xl` | 20px |
| `--radius-3xl` | 26px |

### 7.6 Motion / Transitions

Three named durations:

| Token | Value | Usage |
|---|---|---|
| `--dur-fast` | 120ms | Hover, focus, colour change |
| `--dur-base` | 180ms | Panel/stage change |
| `--dur-slow` | 320ms | Diagram layout animation |

Four easing curves: `--ease-enter`, `--ease-exit`, `--ease-morph`, `--ease-spring`.

**Reduced motion:** `@media (prefers-reduced-motion: reduce)` sets all durations to `0ms` and stops all animations.

### 7.7 Shared UI Primitives (`src/ui/primitives.ts`)

Pre-composed Tailwind className strings for consistent styling:

| Export | Description |
|---|---|
| `btnPrimary` | Primary action button (translucent accent fill, glow on hover) |
| `btnSecondary` | Secondary action button (neutral surface) |
| `btnGhost` | Quiet link-weight button |
| `panelSurface` | Elevated panel container with sheen |
| `card` | Static content card |
| `cardInteractive` | Clickable card that lifts on hover |
| `eyebrow` | Quiet category kicker text |
| `pill` | Small rounded tag/badge |
| `inputField` | Form input/select/textarea |
| `segBase`, `segOn`, `segOff` | Segmented radio group |

### 7.8 Special CSS Classes

| Class | Purpose |
|---|---|
| `.ql-sheen` | Lit top-edge highlight on elevated cards (using `::before`) |
| `.ql-hero-backdrop` | Hero gradient backdrop |
| `.cell` | Hover-timing carrier for interactive elements |
| `.scrubber` | Custom-styled range input (24px touch target) |
| `.snap-section` | Mobile scroll-snap child |
| `.print-only` | Hidden on screen, visible only in print |

---

## 8. Component Reference

### 8.1 Layout Shell

#### `Layout` (`src/ui/Layout.tsx`)
The root layout rendered by `<Route element={<Layout />}>`.
- Always shows: `DisclaimerBanner` → `TopNav` → `<Outlet />` → `Footer`.
- On desktop (≥1024px), non-landing pages use `h-dvh overflow-hidden` to contain scrolling within panels.
- Landing page (`/`) scrolls the full window normally.
- Shows `FirstVisitHint` only on `/playground` with no query params.

#### `TopNav` (`src/ui/TopNav.tsx`)
- Sticky header with backdrop blur.
- Logo + wordmark link to `/`.
- Navigation links from `NAV_ITEMS.filter(item => item.nav)`.
- `ThemeToggle` on the right.
- Active link styled with `bg-accent-soft text-ink`.

#### `Footer` (`src/ui/Footer.tsx`)
- 4-column grid: brand block + Explore + Documentation + Project.
- Explore links from `NAV_ITEMS`, Documentation from `DOCS_NAV`, Project includes GitHub, licence, changelog, and footer-only routes.
- Shows `MIT · CC BY 4.0 docs · no telemetry` badge.

#### `DisclaimerBanner` (`src/ui/DisclaimerBanner.tsx`)
- Yellow-tinted bar at top: "This is a simplified educational model, not a production database."
- Dismissible (stored in sessionStorage).

### 8.2 The Playground (`PlaygroundPage`)

The **core experience**. Two-column layout on desktop:

**Left column (authoring):**
- Dataset selector chips (`users`, `orders`, `logins`, `employees`, `transactions`, `Custom`).
- Preset query chips ("Point lookup", "Sequential scan", etc.).
- `SqlEditor` — CodeMirror with SQL highlighting, autocomplete, error squiggles.
- **Run** button + **Edit data** button + **Eviction policy** select (all eight: LRU, Clock sweep, FIFO, Second-chance, Optimal, Midpoint LRU, LRU-2, 2Q).
- Trace info line ("33 steps in this trace · showing step 12").
- Action links: Copy link, Download trace, Load trace, Present, Tour, Print.
- Predict-on checkbox (or assignment mode notice).

**Right column (trace):**
- `PipelineTracker` — 8-stage progress rail.
- `StageDetail` — the active panel (AST tree, plan tree, buffer pool grid, B+Tree, locks, result table, execution operators, optimizer before/after).
- `PredictionCard` — multiple-choice question before each reveal.
- Narration line (live region for screen readers).
- `PlaybackControls` — reset, step back, play/pause, step forward, speed selector, scrubber.
- `ShortcutHints` — keyboard hint text.

**Overlays (conditionally rendered):**
- `DataEditor` — modal to edit seed table rows.
- `SchemaEditor` — modal to manage custom database tables.
- `PresenterView` — full-screen presentation overlay.
- `PlaygroundTour` — guided 60-second walkthrough overlay.
- `TraceWorksheet` — print-only trace summary (mounted only during `beforeprint`).

### 8.3 Visualization Panels

Each pipeline stage has a dedicated visualization:

| Stage | Panel | Technology | What it Shows |
|---|---|---|---|
| `parse` | `AstTree` | flowinger | Abstract syntax tree with highlighted source spans |
| `plan` | `PlanTree` | flowinger | Logical plan tree with estimated rows |
| `optimize` | `PlanTree` ×2 | flowinger | Before/after plan trees side by side with rule name |
| `execute` | Operator list | Plain HTML | Volcano operators with row counts |
| `buffer` | `BufferPoolPanel` | Custom grid | 8 buffer frames, hit/miss/evict coloring, stats, clock hand |
| `index` | `BTreePanel` | flowinger | B+Tree with traversal path highlighted, sibling chain edges |
| `lock` | `LockPanel` | Custom list | Held page locks (shared/exclusive) with counts |
| `result` | `ResultPanel` | HTML table | Final result rows |

**Export capabilities per panel:**
- Download as PNG (all panels)
- Download as SVG (AST, plan, B+Tree)
- Copy as Mermaid (AST, plan)
- Copy as text (AST, plan, B+Tree)
- Copy as EXPLAIN (result panel — estimate vs actual)

### 8.4 Standalone Tool Pages

Nine self-contained sandbox pages under `/tools/`:

| Tool | Path | Description |
|---|---|---|
| Buffer Pool | `/tools/buffer-pool` | 5 replacement policies (LRU, clock, FIFO, second-chance, optimal) on a custom page reference string |
| Parser | `/tools/parser` | Live SQL → AST with token stream |
| B+Tree | `/tools/btree` | Interactive B+Tree insert/delete/search |
| Page | `/tools/page` | Slotted page structure visualization |
| Sort | `/tools/sort` | External merge sort with buffer pool spills |
| Planner | `/tools/planner` | Full planner + optimizer + cost model |
| Locks | `/tools/locks` | Lock acquisition/release simulation |
| Grammar | `/tools/grammar` | SQL grammar railroad diagrams |
| Hash Join | `/tools/hash-join` | Hash join build/probe visualization |

### 8.5 Compare Page

Four comparison modes:

1. **Replacement Policies** — two policies on the same page reference string, stepped together.
2. **Index vs. Sequential Scan** — same SQL with and without a B+Tree index.
3. **Hash Aggregate vs. Sort Aggregate** — same `GROUP BY` with different strategies.
4. **Join Algorithms** — nested-loop vs. hash vs. sort-merge on the same `JOIN`.

### 8.6 Docs System

- MDX files in `src/pages/DocsContent/` compiled at build time by `@mdx-js/rollup`.
- `DocsLayout` provides sidebar navigation + content area.
- `DocsComponents` provides custom MDX components: `Steps`, `Card`, `DocMeta`, `Contents`.
- Two concept pages (`buffer-pool.mdx`, `btree.mdx`) embed **live interactive widgets** (`DocsBTreeDemo`, `DocsBufferPoolDemo`).
- All docs pages use `.mdx` extension (not `.md`) — required for JSX import support.

---

## 9. State Management

### No Global Store

QueryLens uses **no Redux, Zustand, or global state library**. All state is:

1. **React `useState` / `useMemo`** — local component state.
2. **React Context** — only for theme (`ThemeContext`).
3. **URL query string** — the shareable moment (`urlState.ts`).
4. **`localStorage`** — user preferences, progress, custom database (all with try/catch guards).

### Key State in PlaygroundPage

| State | Type | Source |
|---|---|---|
| `sql` | `string` | User input / URL |
| `policy` | `ReplacementPolicyName` | User selection / URL / preferences |
| `db` | `Database` | Seed data / user edits / URL |
| `result` | `RunResult` | `runQuery()` output |
| `predictOn` | `boolean` | User toggle / URL / preferences |
| `answers` | `Record<number, string>` | User prediction answers |
| `datasetId` | `DatasetId` | Selected dataset |
| `isCustom` | `boolean` | Whether using custom multi-table DB |
| `pinnedStage` | `Stage \| null` | Manually selected stage |
| `presenting` | `boolean` | Presenter view open |
| `tourOpen` | `boolean` | Tour overlay open |
| `editingData` | `boolean` | Data editor modal open |

### Playback State (via `usePlayback` hook)

| Property | Type | Description |
|---|---|---|
| `step` | `number` | Current position (0 = before first event) |
| `playing` | `boolean` | Auto-advancing |
| `speed` | `number` | Multiplier (0.25, 0.5, 1, 2, 4) |
| `atStart` | `boolean` | step === 0 |
| `atEnd` | `boolean` | step >= length |
| `blocked` | `boolean` | Unanswered prediction holding playback |
| `play()` | function | Start auto-advance |
| `pause()` | function | Stop auto-advance |
| `toggle()` | function | Play/pause toggle |
| `stepForward()` | function | Advance one step |
| `stepBack()` | function | Go back one step |
| `reset()` | function | Go to step 0 |
| `seek(n)` | function | Jump to step n |
| `land(n)` | function | Jump without length clamping (for new traces) |
| `setSpeed(n)` | function | Change playback speed |

**Gates:** An array of booleans. `gates[i] = true` means "pause before step i" (prediction must be answered).

**Ceiling:** Assignment mode sets a hard upper bound the playhead cannot cross (even via scrubber).

**Dwell weights:** Per-event pacing. A disk read dwells longer (e.g., dwell = 2) than a buffer hit (dwell = 1). Base interval is 900ms.

### localStorage Keys

| Key | Purpose |
|---|---|
| `querylens:theme` | Theme choice ('light', 'dark', or absent = system) |
| `querylens:default-policy` | Default eviction policy |
| `querylens:default-predict` | Default predict-on preference |
| `querylens:stages-seen` | Which pipeline stages have been visited |
| `querylens:predictions` | Prediction accuracy stats |
| `querylens:first-visit` | First-visit hint dismissed flag |
| `querylens:challenges` | Challenge completion status |
| `querylens:learn-progress` | Learning module progress |
| `querylens:custom-db` | Custom multi-table database definition |

---

## 10. The Engine (Backend-in-Browser)

The engine lives in `src/engine/` and has **zero knowledge of the UI**. It is pure, synchronous TypeScript — no DOM, no React, no async, no I/O.

### Public API (`src/engine/index.ts`)

Key functions:

```typescript
// Run a SQL query against a database → trace events + result rows
runQuery(sql: string, db: Database, options: EngineOptions): RunResult

// Run a standalone buffer-pool trace from a page reference string
runBufferTrace(refs: number[], options: BufferTraceOptions): BufferTraceResult

// Parse SQL → AST
parse(sql: string): SelectStatement | DeleteStatement | InsertStatement | UpdateStatement

// Build + optimize a logical plan
buildPlan(ast, db): Plan
optimize(plan): { plan: Plan; rules: string[] }

// Create/manage a B+Tree
createTree(order): BPlusTree
insert(tree, key, pointer): BPlusTree
search(tree, key): RowPointer | null
deleteKey(tree, key): DeleteResult

// Create/manage a buffer pool
createBufferPool(frames, policy): BufferPool

// Create incremental view state projector
createTraceProjector(events, options): TraceProjector
```

### Pipeline Stages

| Stage | Module | What It Does |
|---|---|---|
| `parse` | `parser/` | Tokenizes SQL → recursive-descent parser → typed AST |
| `plan` | `planner/buildPlan.ts` | AST → logical plan tree (Scan, Filter, Project, Sort, GroupBy, Join) |
| `optimize` | `planner/optimize.ts` | Rule-based rewrites (e.g., predicate pushdown, index selection) |
| `execute` | `exec/` | Volcano-style row-at-a-time operators pull from scan to result |
| `buffer` | `storage/` | Fixed-frame buffer pool with LRU/clock/FIFO/second-chance/optimal/midpoint |
| `index` | `index/` | B+Tree (insert, delete, search, range scan, sibling chain traversal) |
| `lock` | `locks/` | Page-level shared/exclusive lock manager |
| `result` | — | Collects rows from the executor |

### Supported SQL

- `SELECT` with `*`, column list, `AS` aliases, aggregate functions (`COUNT`, `SUM`, `AVG`, `MIN`, `MAX`)
- `FROM` with single table or `JOIN` (inner, left, cross) with `ON`
- `WHERE` with `=`, `!=`, `<`, `>`, `<=`, `>=`, `AND`, `OR`, `NOT`, `IN`, `BETWEEN`, `LIKE`, `IS NULL`, `IS NOT NULL`
- `GROUP BY` with `HAVING`
- `ORDER BY` with `ASC`/`DESC`
- `LIMIT`
- `DELETE FROM ... WHERE ...`
- `INSERT INTO ... VALUES ...`
- `UPDATE ... SET ... WHERE ...`

### Preset Datasets

| ID | Table | Rows | Indexed Columns | Shape Purpose |
|---|---|---|---|---|
| `users` | `users` | 48 | `id` | Baseline: 12-page scan vs 8 buffer frames |
| `orders` | `orders` | 120 | `id` | Deeper B+Tree, harder eviction |
| `logins` | `logins` | 80 | `id` | 8:1 skew on `status` — selectivity contrast |

---

## 11. Data Models & Types

### Core Types (`src/engine/types.ts`)

```typescript
type SqlValue = string | number | boolean | null;
type Row = Record<string, SqlValue>;

type Stage = 'parse' | 'plan' | 'optimize' | 'execute' | 'buffer' | 'index' | 'lock' | 'result';

interface Table {
  name: string;
  columns: string[];
  rows: Row[];
  indexedColumns?: string[];  // Columns with B+Tree indexes
}

interface Database {
  tables: Record<string, Table>;
}

interface EngineOptions {
  bufferFrames: number;       // Default: 8
  rowsPerPage: number;        // Default: 4
  policy: ReplacementPolicyName;
  aggregateStrategy?: 'hash' | 'sort';
  joinStrategy?: 'nested-loop' | 'hash' | 'sort-merge';
}

type ReplacementPolicyName = 'lru' | 'clock' | 'fifo' | 'second-chance' | 'optimal' | 'midpoint';

// The main output
interface RunResult {
  events: StepEvent[];
  rows: Row[];
  error?: QueryError;
  write?: WriteOutcome;
}
```

### StepEvent (Trace Events)

Events are **deltas**, not snapshots. Each describes one thing that happened:

```typescript
type StepEvent = StepEventBase & StepEventBody;

interface StepEventBase {
  id: number;              // Position in trace (= array index)
  label: string;           // Human-readable narration
  dwell?: number;          // Pacing weight (default 1)
  predictable?: PredictionPrompt;
}

type StepEventBody =
  | { stage: 'parse'; ast: ASTNode; span?: Span }
  | { stage: 'plan'; planTree: PlanNode }
  | { stage: 'optimize'; rule: string; before: PlanNode; after: PlanNode }
  | { stage: 'execute'; op: string; rowsProduced: number }
  | { stage: 'buffer'; action: 'hit' | 'miss' | 'load' | 'write' | 'evict' | 'sweep'; ... }
  | { stage: 'index'; action: 'open' | 'traverse' | 'found' | 'not-found' | 'chain-next'; ... }
  | { stage: 'lock'; action: 'acquire' | 'release'; pageId: number; mode: 'shared' | 'exclusive' }
  | { stage: 'result'; rows: Row[] };
```

### ViewState (What the UI Renders)

```typescript
interface ViewState {
  step: number;
  stage: Stage | null;
  narration: string;
  lastEvent: StepEvent | null;
  ast: ASTNode | null;
  plan: PlanNode | null;
  planBefore: PlanNode | null;
  appliedRules: string[];
  frames: BufferFrame[];         // Array of 8 buffer frames
  clockHand: number;
  bufferStats: { hits: number; misses: number; evictions: number; writes: number };
  indexTree: IndexNode | null;
  indexPath: string[];           // Nodes traversed so far
  indexOutcome: 'searching' | 'found' | 'not-found' | null;
  locks: LockHeld[];
  locksTaken: number;
  operators: { op: string; rowsProduced: number }[];
  rows: Row[];
}
```

### Display Tree Shapes (for flowinger)

```typescript
// AST node
interface ASTNode {
  id: string;
  kind: string;
  label: string;
  detail?: string;
  span?: Span;
  children?: ASTNode[];
}

// Plan node
interface PlanNode {
  id: string;
  op: string;
  label: string;
  detail?: string;
  highlight?: boolean;   // Set by optimizer rewrites
  estRows?: number;      // Cost model estimate
  estBasis?: string;     // Estimation method
  children?: PlanNode[];
}

// B+Tree node
interface IndexNode {
  id: string;
  kind: 'internal' | 'leaf';
  label: string;        // Keys in this node
  pageId: number;
  next?: string;        // Sibling chain pointer
  children?: IndexNode[];
}
```

### PredictionPrompt

```typescript
interface PredictionPrompt {
  question: string;
  options: PredictionOption[];     // { id: string; label: string }
  correctOptionId: string;
  explanation: string;             // Shown after reveal
}
```

---

## 12. Key User Flows

### Flow 1: First Visit

1. User opens `/`. → `LandingPage` with hero, "Reading a trace" steps, and "Where to start" links.
2. Clicks "Playground" → navigates to `/playground`.
3. `FirstVisitHint` shows ("This is your first time — take a 60-second tour").
4. If accepted → `PlaygroundTour` overlay guides through editor, pipeline, panel, narration, and playback.
5. On initial load, the default query (`SELECT * FROM users WHERE id = 5;`) is already **run** — the trace is live.

### Flow 2: Run a Query

1. User types SQL in the `SqlEditor`.
2. Clicks **Run** or presses `⌘↵` / `Ctrl+↵`.
3. `runQuery()` executes synchronously → `RunResult`.
4. Playback lands at step 1 (or step 0 if first event is predictable).
5. User presses Play / steps forward with → / drags scrubber.
6. Each step advances the `ViewState` and the corresponding panel updates.
7. URL updates via `history.replaceState` (debounced 250ms).

### Flow 3: Predict-Then-Reveal

1. Playback hits a step with `predictable` prompt.
2. `PredictionCard` appears with multiple-choice question.
3. User **must** answer (or skip, unless in assignment mode) before playback can advance.
4. After answer: explanation shown, correct/wrong indicated, playback unblocks.
5. Progress is recorded to localStorage.

### Flow 4: Share a Moment

1. User clicks "Copy link to this step".
2. Full state encoded in URL: SQL, policy, predict mode, step, dataset, edited rows.
3. Recipient opens URL → state restored identically.

### Flow 5: Assignment Mode

1. Instructor visits `/assignments/new` → builds a URL with `&l=1`.
2. Student opens link → `lockReveal=true`, predict forced on.
3. Scrubber cannot pass first unanswered question.
4. No "skip" button on prediction cards.

### Flow 6: Edit Data

1. Click "Edit data" → `DataEditor` modal opens.
2. Inline editable table with add/delete rows.
3. Apply → re-runs the current SQL against modified data.
4. Edited rows encoded in the URL `d` parameter.

### Flow 7: Compare

1. Navigate to `/compare`.
2. Pick a mode (policies / index / aggregate / join).
3. Two (or three) traces run simultaneously with different options.
4. Step through them in lockstep; first divergence is flagged.

---

## 13. Accessibility

### Standards

- **WCAG 2.2** AA compliance targeted.
- **`eslint-plugin-jsx-a11y`** runs in CI.
- **`@axe-core/playwright`** runs in e2e tests (both light and dark themes).

### Keyboard Navigation

| Key | Action | Context |
|---|---|---|
| `Space` | Play / Pause | Global (except when typing) |
| `→` (ArrowRight) | Step forward | Global |
| `←` (ArrowLeft) | Step back | Global |
| `Home` | Reset to start | Global |
| `⌘↵` / `Ctrl+↵` | Run query | SQL editor |

Shortcuts are **suspended** when:
- Typing in an `<input>`, `<textarea>`, `<select>`, or CodeMirror editor.
- The tour overlay is open.
- The data editor is open.

### Screen Reader Support

- Live region (`aria-live="polite"`) on narration text — announces each step.
- `aria-current="step"` on active pipeline stage.
- `aria-pressed` on pinned stage.
- `aria-expanded` + `aria-controls` on help toggles.
- `aria-label` on all controls.
- Step counter reads as "Step 12 of 33" via `aria-label`.
- `stepAnnouncement()` generates context-appropriate screen reader text.

### Touch & Mobile

- All touch targets ≥ 24×24px (WCAG 2.2 SC 2.5.8).
- Custom scrubber thumb: 24px diameter.
- `useIsTouch()` hook hides keyboard-only hints on touch devices.
- Mobile scroll-snap on playground sections.
- Responsive sidebar collapses to horizontal scroll.

### Reduced Motion

- `prefers-reduced-motion: reduce` → all `--dur-*` tokens set to 0ms.
- All CSS `animation-duration` forced to 0.01ms.
- Scroll-snap disabled.
- `useReducedMotion()` hook available for JS-driven animations.

### Print

- `@media print` rules hide everything except `[data-print]` regions.
- `TraceWorksheet` is mounted only during `beforeprint` event.
- Forces light colour scheme for printing.

### Theme

- Three choices: Light, Dark, System (follows OS preference at sunset).
- High-contrast focus ring: 2px accent outline + 4px glow.
- All colours contrast-checked in both themes.
- Themed scrollbars.
- `::selection` styled.

---

## 14. Performance & Bundle Strategy

### Code Splitting

Every page is `React.lazy()` — no page loads until navigated to. Chunks are configured in `vite.config.ts`:

| Chunk | Contents |
|---|---|
| `codemirror` | `@codemirror/*`, `@lezer/*`, `style-mod`, `w3c-keyname` |
| `flow` | `flowinger`, `d3-*` |
| `react` | `react`, `react-dom`, `scheduler` |
| `html-to-image` | PNG export (lazy-loaded on first use) |
| `docs` | All docs MDX pages (except concepts with live widgets) |

### Font Strategy

- Two variable woff2 fonts, ~30KB each, subset to 235 codepoints.
- `<link rel="preload">` in `<head>` for both.
- `font-display: swap` with metric-adjusted fallbacks (zero layout shift).

### Bundle Budget

`scripts/bundle-budget.ts` prices what a visitor downloads, and fails CI when something passes its ceiling. Runs
after every build (plan.md §25.4 H8 replaced the older per-chunk-group ceilings and their one total).

- **Every route has its own ceiling**: the entry chunk, the route's lazy chunk and every static dependency of
  either, read from Vite's manifest (`dist/.vite/manifest.json`) — the graph the browser walks. A new tool is its
  own lazy chunk with its own row, so it cannot grow a shared ceiling to fit.
- **The entry chunk** — the shell every route loads first — has its own ceiling (24 kB).
- **Opt-in chunks**, fetched only on a click (PNG export, the Durability dialog, a challenge's checks), are priced
  on their own, measured past what their page already loaded.
- **Nothing hides outside the budget**: a chunk over 0.5 kB that no route and no opt-in reaches fails the check.
- Sizes are gzip at level 9, in KiB; Vite's build output prints slightly larger figures for the same files (the
  `react` chunk is 62.5 kB here and 64.8 kB there). Ceilings sit about 3 kB over the measured size, and raising
  one is a diff with a dated comment saying why.

### Caching

- `public/_headers` sets:
  - `/assets/*`: `Cache-Control: public, max-age=31536000, immutable` (hashed filenames).
  - Everything else: `Cache-Control: public, max-age=0, must-revalidate`.

---

## 15. Deployment & Hosting

### Platform

**Cloudflare Pages** — static hosting.

### Build Output

`pnpm build` → `dist/` (static HTML/CSS/JS/assets).

### SPA Routing

`public/_redirects` contains: `/* /index.html 200` — all unmatched paths serve the SPA entry.

### Security Headers (`public/_headers`)

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
Permissions-Policy: geolocation=(), microphone=(), camera=()
Cross-Origin-Opener-Policy: same-origin
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
```

> **Note:** `style-src 'unsafe-inline'` is required because CodeMirror injects runtime `<style>` elements. This is scoped to styles only.

### Environment Variables

| Variable | Purpose | Set By |
|---|---|---|
| `VITE_SITE_URL` | Canonical URL and og:image base | Manual override |
| `CF_PAGES_URL` | Deployment URL | Cloudflare Pages |
| `CF_PAGES_COMMIT_SHA` | Build commit | Cloudflare Pages |
| `GITHUB_SHA` | Build commit | GitHub Actions |

### Build Metadata

`vite.config.ts` injects:
- `__BUILD_SHA__` — git commit short hash (12 chars).
- `__BUILD_TIME__` — ISO 8601 build timestamp.
- `%SITE_URL%` — replaced in index.html for og:image and canonical.
- `querylens:build` and `querylens:built-at` `<meta>` tags injected into HTML.

---

## 16. Testing

### Unit Tests (Vitest)

```bash
pnpm test        # vitest run
pnpm test:watch  # vitest (watch mode)
```

- Environment: `jsdom`
- Setup: `src/test/setup.ts`
- Includes: `src/**/*.{test,spec}.{ts,tsx}` + `bin/**/*.{test,spec}.ts`
- Covers: engine (parser, planner, buffer pool, B+Tree, executor, locks, cost model) + UI (playback gating, keyboard shortcuts, data/schema editors, URL state, error boundary)
- `fast-check` for property-based tests.

### E2E Tests (Playwright)

```bash
pnpm test:e2e    # playwright test (requires built dist/)
```

- Runs against **`dist/`** (production build).
- Requires: `pnpm exec playwright install chromium`
- Config: `playwright.config.ts`
- In CI a failed test is retried once, recording a trace; one that passes only on its retry is **flaky** and fails
  the build (`failOnFlakyTests`) instead of going green unnoticed. The HTML report, traces included, is uploaded
  when the job fails.
- Includes:
  - Smoke: load → run → step → result, shared links, data editor, theming, axe in both palettes.
  - Regressions: panel tracking, zoom, overflow, gating, history, console silence.

### Bundle Budget

```bash
pnpm budget      # run after pnpm build
```

A gzip ceiling per route, for the entry chunk and for each opt-in chunk; fails CI if one is passed, or if a chunk
is reached by no route at all (see §14, *Bundle Budget*).

---

## 17. Environment & Configuration

### Node Version

`.node-version`: `22` (requires ≥ 22.13.0)

### TypeScript

Three tsconfig files:
- `tsconfig.json` — project references root.
- `tsconfig.app.json` — app source (`src/`).
- `tsconfig.node.json` — Vite config, scripts, bin.

### ESLint

`eslint.config.js` includes:
- `@eslint/js` recommended.
- `typescript-eslint` strict rules.
- `react-hooks` rules.
- `react-refresh` (warn on non-component exports).
- **`jsx-a11y`** — accessibility linting.
- **Engine purity barrier:** `src/engine/**/*.ts` files run with **zero browser or Node globals** — no `window`, `document`, `localStorage`, `setTimeout`, `fetch` allowed. Enforced by stripping all globals from the ESLint language options for that directory.

### CLI Tool (`bin/querylens.ts`)

A terminal CLI for running traces outside the browser:

```bash
pnpm trace "SELECT * FROM users WHERE id = 5"  # human-readable ANSI output
pnpm trace "SELECT * FROM users" --json          # JSON trace output
pnpm trace "SELECT * FROM users" --policy clock   # clock sweep
pnpm trace "SELECT * FROM orders" --dataset orders
```

**Exit codes:** `0` = success, `1` = SQL error, `2` = CLI usage error.

### pnpm

- `pnpm-workspace.yaml` — monorepo config.
- `minimumReleaseAge: 10080` — blocks dependencies younger than 7 days (supply-chain quarantine).
- `blockExoticSubdeps: true` — blocks exotic subdependency specifiers.
- `allowBuilds: []` — no native build steps allowed.
- pnpm overrides for `@codemirror/state` and `@codemirror/view` version pinning.

### Build Scripts (`scripts/`)

| Script | Command | Purpose |
|---|---|---|
| `build-fonts.py` | `python scripts/build-fonts.py` | Downloads, subsets, and renames IBM Plex Sans → "QueryLens Sans" (OFL compliance). Emits `.woff2` to `public/fonts/` |
| `build-icons.py` | `python scripts/build-icons.py` | Renders `public/apple-touch-icon.png` (180×180) from favicon SVG |
| `build-og.ts` | `pnpm og` | Captures OG image via Playwright from a real running trace (step 91, buffer eviction moment) |
| `bundle-budget.ts` | `pnpm budget` | Enforces per-route gzip ceilings (fails CI if exceeded) |
| `record.ts` | `pnpm record` | Records step-by-step videos (`.webm` + `.gif`) via Playwright + ffmpeg |

---

## 18. CI/CD

### GitHub Actions (`.github/workflows/ci.yml`)

Runs on every PR and push to `main`. All GitHub Actions are **pinned to immutable 40-character commit SHAs**. Concurrent runs on the same branch are cancelled.

**Parallel jobs:**

| Job | What It Runs |
|---|---|
| `typecheck` | `pnpm typecheck` (`tsc -b`) |
| `lint` | `pnpm lint` (`eslint .` including jsx-a11y) |
| `unit-test` | `pnpm test` (`vitest run`) |
| `build-and-budget` | `pnpm build` + `pnpm budget` |
| `cli-test` | CLI `--help`, query execution, `--policy clock`, `--json` |
| `e2e-test` | Playwright + axe a11y audit; a flaky test fails it. Uploads the HTML report (with traces) on failure |
| `ci-gate` | Required status check gating PR merges |

### Dependabot (`.github/dependabot.yml`)

- Weekly npm updates on Mondays.
- Groups: `codemirror`, `react`, and `dev` dependencies.
- Ignores TypeScript 7.x (pinned for `typescript-eslint` compatibility).
- Monthly GitHub Actions SHA updater.

### Issue & PR Templates

- **Bug report** (`bug_report.yml`): Structured with reproduction steps, crash repro JSON, browser/OS fields.
- **Feature request** (`feature_request.yml`): Organized by engine subsystem.
- **PR template** (`PULL_REQUEST_TEMPLATE.md`): Description, issue link, classification, testing notes, checklist.

---

## 19. Commands Reference

| Command | Description |
|---|---|
| `pnpm install` | Install dependencies |
| `pnpm dev` | Start Vite dev server (http://localhost:5173) |
| `pnpm build` | Type-check + production build → `dist/` |
| `pnpm preview` | Preview production build locally |
| `pnpm typecheck` | Run TypeScript type checking |
| `pnpm lint` | ESLint (including jsx-a11y) |
| `pnpm test` | Run unit tests (Vitest) |
| `pnpm test:watch` | Unit tests in watch mode |
| `pnpm test:e2e` | Playwright e2e tests (requires build) |
| `pnpm budget` | Gzip bundle budget check (requires build) |
| `pnpm og` | Regenerate OG image from a real trace |
| `pnpm record` | Record screenshots/traces |
| `pnpm trace` | Run CLI trace tool |
| `pnpm test:cli` | Test CLI help output |

---

## 20. File-by-File Inventory

### Pages (`src/pages/`)

| File | Route | Description |
|---|---|---|
| `PlaygroundPage.tsx` | `/playground` | ~810 lines. The main experience. SQL editor, trace viewer, all panels, predictions, sharing, assignments, presenter view, tour, print. |
| `LandingPage.tsx` | `/` | Hero + "reading a trace" steps + "where to start" navigation |
| `ExamplesPage.tsx` | `/examples` | Preset SQL examples with one-click load |
| `GalleryPage.tsx` | `/gallery` | Curated "named moments" with direct links |
| `ComparePage.tsx` | `/compare` | ~900 lines. Side-by-side comparison in 4 modes |
| `TracePage.tsx` | `/trace` | Raw trace event table inspector |
| `LearnPage.tsx` | `/learn` | Structured learning module index |
| `LessonPage.tsx` | `/learn/:lessonId` | Individual lesson with embedded playground |
| `ChallengesPage.tsx` | `/challenges` | Challenge list with completion status |
| `ChallengePage.tsx` | `/challenges/:id` | Individual challenge with requirements |
| `ProgressPage.tsx` | `/progress` | Dashboard: stages seen, prediction accuracy, learn progress |
| `SettingsPage.tsx` | `/settings` | Default policy, predict mode, theme preferences |
| `AssignmentsNewPage.tsx` | `/assignments/new` | URL builder for instructors |
| `StagesIndex.tsx` | `/stages` | 8 stages overview grid |
| `StagePage.tsx` | `/stages/:stageId` | Individual stage with its panel |
| `ToolsIndexPage.tsx` | `/tools` | Tools grid with descriptions |
| `NotFoundPage.tsx` | `*` | 404 page |

### UI Components (`src/ui/`)

| File | Description |
|---|---|
| `Layout.tsx` | Root layout: disclaimer + nav + outlet + footer |
| `TopNav.tsx` | Sticky header navigation bar |
| `Footer.tsx` | 4-column footer |
| `Sidebar.tsx` | Pipeline stage sidebar nav |
| `StagesLayout.tsx` | Sidebar + outlet layout for `/stages` |
| `Hero.tsx` | Landing page hero with gradient backdrop |
| `Logo.tsx` | SVG logo component |
| `DisclaimerBanner.tsx` | "Simplified model" dismissible banner |
| `ErrorBoundary.tsx` | Error boundary (page + panel variants) |
| `FirstVisitHint.tsx` | First-visit welcome + tour CTA |
| `SqlEditor.tsx` | CodeMirror SQL editor with error marks + autocomplete |
| `CodeMirrorEditor.tsx` | Low-level CodeMirror wrapper |
| `DataEditor.tsx` | Modal table row editor (add/delete/edit rows, CSV import) |
| `SchemaEditor.tsx` | Modal database schema editor (add/remove tables, columns, indexes) |
| `PipelineTracker.tsx` | 8-stage progress rail with status dots and connectors |
| `PlaybackControls.tsx` | Transport: reset, back, play/pause, forward, speed, scrubber |
| `PredictionCard.tsx` | Predict-then-reveal question card with options |
| `PresenterView.tsx` | Full-screen overlay for classroom presentation |
| `PlaygroundTour.tsx` | Guided 60-second onboarding overlay |
| `TraceWorksheet.tsx` | Print-only trace summary table |
| `ShortcutHints.tsx` | Keyboard shortcut hint text |
| `CopyButton.tsx` | Generic clipboard copy button |
| `DownloadPngButton.tsx` | PNG export via html-to-image |
| `DownloadSvgButton.tsx` | SVG export via renderSvg |
| `PageHeader.tsx` | Reusable page title + blurb header |
| `DocsLayout.tsx` | Docs sidebar + MDX content layout |
| `DocsComponents.tsx` | MDX component overrides (Steps, Card, DocMeta, Contents) |
| `DocsBTreeDemo.tsx` | Live B+Tree widget for concept docs |
| `DocsBufferPoolDemo.tsx` | Live buffer pool widget for concept docs |
| `ThemeContext.tsx` | React context provider + `useThemeContext` hook |
| `ThemeToggle.tsx` | Three-way toggle: light / dark / system |

### UI Hooks & Utilities (`src/ui/`)

| File | Description |
|---|---|
| `theme.ts` | `useTheme()` — theme state, localStorage, system preference listener |
| `usePlayback.ts` | `usePlayback()` — step/play/pause/speed/gates + keyboard shortcuts |
| `useReducedMotion.ts` | `useReducedMotion()` — prefers-reduced-motion |
| `urlState.ts` | URL ↔ `ShareState` encode/decode + `writeShareState` |
| `preferences.ts` | Read/write default policy + predict from localStorage |
| `stageMeta.ts` | `STAGE_META` — title, blurb, help, doc link, tone for each stage |
| `primitives.ts` | Shared className strings (buttons, cards, inputs, pills) |
| `platform.ts` | `IS_APPLE`, `MOD_KEY`, `RUN_HINT`, `useIsTouch()` |
| `motion.ts` | `durationMs()` — reads CSS custom properties for JS animations |
| `progress.ts` | Stage visit + prediction recording (localStorage) |
| `challengeProgress.ts` | Challenge completion tracking |
| `learnProgress.ts` | Learn module progress tracking |
| `firstVisit.ts` | First-visit detection, tour pending flag |
| `datasetCatalogue.ts` | Labels, blurbs, starter SQL, preset chips per dataset |
| `customDatabase.ts` | Custom DB load/save from localStorage |
| `editorMarks.ts` | CodeMirror decoration/marks utilities |
| `errorReport.ts` | Error formatting, console banner, global handlers |
| `parseCsv.ts` | Simple CSV parser for data import |
| `traceFile.ts` | Trace file serialize/deserialize (JSON) |
| `stepAnnouncement.ts` | Screen reader announcement text generator |
| `renderSvg.ts` | SVG rendering for tree diagram exports |
| `assignmentSet.ts` | Assignment URL generation utilities |
| `grammar.ts` | Grammar visualization helper |
| `hashJoin.ts` | Hash join visualization helper |
| `externalSort.ts` | External sort visualization helper |
| `lockSimulation.ts` | Lock simulation logic |
| `slottedPage.ts` | Slotted page structure visualization |

### Visualization Panels (`src/ui/panels/`)

| File | Stage | Technology |
|---|---|---|
| `StageDetail.tsx` | All | Orchestrator: picks panel, renders header/help/export buttons |
| `AstTree.tsx` | parse | flowinger tree |
| `PlanTree.tsx` | plan, optimize | flowinger tree |
| `FlowTree.tsx` | — | Generic flowinger tree wrapper (used by AST, Plan, BTree) |
| `BTreePanel.tsx` | index | flowinger tree with sibling edges |
| `BufferPoolPanel.tsx` | buffer | Custom grid of frames with hit/miss/evict colouring |
| `LockPanel.tsx` | lock | List of held locks |
| `ResultPanel.tsx` | result | HTML table of result rows |
| `astTreeTones.ts` | — | AST node → hue mapping |
| `btreeTones.ts` | — | B+Tree node → hue mapping + sibling edge collector |
| `planTreeTones.ts` | — | Plan node → hue mapping |

### Engine (`src/engine/`)

| File | Description |
|---|---|
| `index.ts` | Barrel export — the public API boundary |
| `types.ts` | All shared types (Stage, StepEvent, ViewState, Table, Database, etc.) |
| `runQuery.ts` | Main entry: SQL string + database → RunResult |
| `trace.ts` | Trace builder — collects StepEvents during pipeline execution |
| `viewState.ts` | Pure event→state reducer + `TraceProjector` (incremental folder) |
| `seed.ts` | Default 48-row users table |
| `datasets.ts` | Preset dataset definitions (users, orders, logins, employees, transactions) |
| `predict.ts` | Prediction prompt generation for each stage |
| `bufferTrace.ts` | Standalone buffer trace runner (for Compare + Tools) |
| `parser/tokenizer.ts` | SQL tokenizer |
| `parser/parser.ts` | Recursive-descent SQL parser |
| `parser/ast.ts` | AST type definitions |
| `parser/display.ts` | AST → display tree conversion |
| `planner/buildPlan.ts` | AST → logical plan |
| `planner/plan.ts` | Plan node types |
| `planner/cost.ts` | Cost model (row estimates, selectivity) |
| `planner/optimize.ts` | Rule-based optimizer (predicate pushdown, index selection) |
| `planner/emit.ts` | Plan → executor step events |
| `planner/emitDelete.ts` | DELETE plan emission |
| `planner/emitUpdate.ts` | UPDATE plan emission |
| `storage/bufferPool.ts` | Buffer pool implementation |
| `storage/page.ts` | Page abstraction |
| `storage/policy.ts` | Replacement policies (LRU, clock, FIFO, second-chance, optimal, midpoint) |
| `index/btree.ts` | B+Tree core data structure |
| `index/build.ts` | Build index from table data |
| `index/lookup.ts` | Point lookup |
| `index/rangeLookup.ts` | Range scan with sibling chain traversal |
| `index/display.ts` | B+Tree → display tree |
| `index/validate.ts` | B+Tree structural validation |
| `exec/run.ts` | Volcano executor main loop |
| `exec/operators.ts` | Scan, Filter, Project, Sort, GroupBy operators |
| `exec/evaluate.ts` | Expression evaluator |
| `exec/sort.ts` | External merge sort |
| `exec/delete.ts` | DELETE executor |
| `exec/insert.ts` | INSERT executor |
| `exec/update.ts` | UPDATE executor |
| `locks/lockManager.ts` | Page-level lock manager |

---

> **This document was generated from a complete scan of every file in the project on 2026-09-19. When in doubt, the source code is the truth — but this should give you everything you need to start.**

## 21. Current Frontend State

As of the latest repository scan, the frontend is in a **highly mature, production-ready state** for an educational application. All major features, pipelines, and visualizations have been successfully built out.

### Implementation Status
- **Core Playground (`PlaygroundPage.tsx`)**: Fully implemented (~800 lines). Supports all 8 pipeline stages, schema editing, inline data editing, prediction recording, and playback controls.
- **Visualizations (`src/ui/panels/`)**: 100% complete. The flowinger renderer draws the AST, Plan Tree, and B+Tree panels. Custom HTML/CSS grids are used for the Buffer Pool and Slotted Page layouts.
- **Standalone Tools (`src/pages/tools/`)**: All 9 dedicated sandboxes are complete, functional, and heavily tested (B+Tree, Buffer Pool, Parser, Planner, Page, Sort, Locks, Grammar, Hash Join).
- **Compare Mode (`ComparePage.tsx`)**: Fully implemented (~900 lines) with all 4 comparison algorithms functioning (Eviction Policies, Index vs. Seq Scan, Hash vs. Sort Aggregate, and Join Strategies).
- **Documentation (`src/pages/DocsContent/`)**: Fully integrated using MDX. Live React components (`DocsBTreeDemo`, `DocsBufferPoolDemo`) successfully embed interactive DB state directly into the markdown documentation.

### Codebase Scale & Health
- **UI Codebase**: ~13,400 lines of UI and component code (`src/ui/`, `src/pages/`).
- **Engine Codebase**: ~16,800 lines of pure TypeScript engine code (`src/engine/`).
- **TypeScript**: Strict mode is fully enabled. No `any` types escape the boundaries.
- **Linting/A11y**: Zero ESLint errors. The engine directory strictly isolates away browser globals. Full WCAG 2.2 AA compliance is verified via Playwright/Axe.
- **Testing**: End-to-end tests (smoke, features, regressions) are comprehensive and cover edge cases like horizontal canvas overflows, timeline tracing, and theme switching.

### Known Technical Debt / Next Steps
- **Web Workers**: The database engine currently executes completely on the main UI thread. Because the engine was explicitly architected to be pure and synchronous, the state is 100% serializable. A logical next step for the frontend would be to wrap `runQuery()` into a Web Worker to prevent UI blocking when executing intentionally heavy eviction storms.
- **Mobile UX**: While the layout uses responsive design (`.snap-section` and touch-friendly 24px scrubbers), visualizing complex structures like deep B+Trees or Hash Join buckets on narrow mobile screens fundamentally requires heavy horizontal scrolling.
