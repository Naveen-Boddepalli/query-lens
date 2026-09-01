# QueryLens

An in-browser toy relational database engine that animates a SQL query as it moves through
**Parser → Planner → Optimizer → Execution → Buffer Pool → B+Tree Index → Locks → Result**.

A learning tool, not a production DB tool. See [plan.md](plan.md) for scope and
[RESEARCH.md](RESEARCH.md) for the evidence the plan is built on.

## Status: M1 complete — parser + AST visualization

One stage of eight is real. `IMPLEMENTED_STAGES` in
[types.ts](src/engine/types.ts) is the single source of truth for that, and the UI reads it: the
header counts built stages, unbuilt ones are dashed in the pipeline tracker, and selecting one says
plainly that it is not built yet. plan.md §2 makes honesty about ground truth a top-line goal, and a
pipeline that *looks* complete when it is not would teach the wrong thing.

| Milestone | Scope | State |
|---|---|---|
| M0 | Scaffold, event contract, fold, playback, UI shell | ✅ done |
| M1 | Recursive-descent parser + AST visualization | ✅ done |
| M2 | Planner + predicate pushdown + plan tree | next |
| M3 | Pages, buffer pool, LRU **and** clock sweep | |
| M4 | B+Tree index + traversal visualization | |
| M5 | Volcano executor wiring it all together | |
| M6 | Lock manager visual layer | |
| M6.5 | Predict-then-reveal + editable seed data | |
| M7 | Polish, a11y, deploy | |

## Commands

```bash
pnpm install
pnpm dev        # http://localhost:5173
pnpm test       # vitest
pnpm typecheck  # tsc -b
pnpm lint       # eslint
pnpm build      # tsc -b && vite build
```

## Architecture

```
src/engine/   pure, synchronous, no DOM, no React, no async
src/ui/       a renderer of engine state, nothing more
```

`runQuery(sql, db, options)` returns the **complete** event array in one synchronous call.
Playback is then an index into an array the UI already owns, which makes step-back, scrubbing and
reset trivially correct. See plan.md §5 for why this is deliberately *not* a Web Worker.

**Events are deltas, not snapshots.** `applyEvent` folds them into a `ViewState`;
`createTraceProjector` memoises per index so stepping backward is free. Snapshotting per step
would forfeit the ability to animate the *transition*, which is the entire product.

### Rules for `src/engine`

1. Pure and synchronous. No DOM, no React import, no async, no I/O.
2. Every emitted value must be structurally cloneable — this keeps the engine worker-ready
   should a v1 feature ever need it.
3. Every event carries a human-readable `label`. The narration is what turns an animation into
   a lesson.
4. Correctness tests come *before* visualization (see plan.md §7.6 for the B+Tree case).

## The v0 SQL subset

```
statement  := select [';'] EOF
select     := SELECT selectList FROM identifier [WHERE expr]
selectList := '*' | identifier (',' identifier)*
expr       := comparison (AND comparison)*
comparison := operand ('=' | '<' | '>') operand
operand    := identifier | number | string | NULL | TRUE | FALSE
```

Anything outside it gets a message naming the scope rather than a token-level complaint —
`JOIN` says joins arrive in v1, `>=` says v0 handles `=`, `<` and `>`, `a.id` says qualified names
come with joins. The tokenizer deliberately recognises keywords and operators the parser rejects,
purely so those messages are possible. Errors carry a character span, which CodeMirror renders as a
squiggle under the offending text.

## Decisions made during M0/M1

- **TypeScript pinned to 6.0.3.** `typescript-eslint@8.69.0` declares `typescript: ">=4.8.4 <6.1.0"`
  — it excludes TS 7. Verified against the registry. Revisit once 7.1 ships a stable compiler API.
- **CodeMirror is wired up directly**, not via `@uiw/react-codemirror`. That wrapper statically
  imports its `basicSetup` bundle (search, folding, linting) whether or not you pass
  `basicSetup={false}`, so its flags cannot tree-shake. A ~40-line binding
  ([CodeMirrorEditor.tsx](src/ui/CodeMirrorEditor.tsx)) saved ~70 kB.
- **RESEARCH.md's "~50 kB tree-shaken" CodeMirror figure does not hold.** `@codemirror/view` alone
  is 480 kB of source. The editor stack costs ~370 kB raw / ~120 kB gzip in practice. Still the
  right call — Monaco is 2–5 MB — but the budget is 2–3× what the research assumed.
- **`@codemirror/state` and `/view` are pinned via `pnpm-workspace.yaml` overrides.** CodeMirror
  breaks, in types and at runtime, if two copies are loaded.
- **The parser emits the parse stage as a progressive reveal** — SELECT list, then FROM, then WHERE,
  then a summary. Display-tree node ids are stable across those steps so the tree animates as it
  grows instead of remounting.
- **`Mod-Enter` is a CodeMirror keybinding at `Prec.highest`, not a DOM handler.** The default keymap
  binds it to `insertBlankLine` and consumes the event before React sees it. It re-emits as a DOM
  `CustomEvent` so the extension array can stay module-scoped — rebuilding it per render would tear
  the editor down on every keystroke.
- **React Flow + d3-hierarchy for trees**, as plan.md §6 specifies: d3 does the layout maths,
  React Flow only draws. Cost is ~62 kB gzip. Bundle is now 250 kB gzip total; if that becomes a
  problem, these trees are static layouts and could be plain SVG.
