/**
 * Two decorations driven from engine output:
 *   - `error`  — a red squiggle under the exact text the parser rejected
 *   - `active` — the clause the current parse step is consuming
 *
 * Feeding CodeMirror from our own parser is what makes the parse stage feel
 * real rather than decorative (plan.md §8).
 */

import { StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import type { Span } from '../engine/index.ts';

export interface EditorMarks {
  error?: Span;
  active?: Span;
}

export const setMarks = StateEffect.define<EditorMarks>();

const errorMark = Decoration.mark({ class: 'cm-sql-error' });
const activeMark = Decoration.mark({ class: 'cm-sql-active' });

function build(marks: EditorMarks, docLength: number): DecorationSet {
  const ranges = [];
  for (const [span, deco] of [
    [marks.active, activeMark],
    [marks.error, errorMark],
  ] as const) {
    if (!span) continue;
    const from = Math.max(0, Math.min(span.from, docLength));
    // A zero-width span (end-of-input errors) still needs something to sit under.
    const to = Math.max(from + 1, Math.min(span.to, docLength));
    if (from >= docLength) continue;
    ranges.push(deco.range(from, Math.min(to, docLength)));
  }
  return Decoration.set(ranges, true);
}

export const markField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, tr) {
    // Editing invalidates both marks — a squiggle left over the text you just
    // fixed is worse than no squiggle.
    let next = tr.docChanged ? Decoration.none : decorations.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setMarks)) next = build(effect.value, tr.state.doc.length);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});
