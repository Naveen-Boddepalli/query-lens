import { useEffect, useRef } from 'react';
import { Prec } from '@codemirror/state';
import { sql, SQLite } from '@codemirror/lang-sql';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { CodeMirrorEditor } from './CodeMirrorEditor.tsx';
import { markField, setMarks } from './editorMarks.ts';
import type { QueryError, Span } from '../engine/index.ts';

/**
 * Extensions are listed explicitly rather than using `basicSetup`: that bundle
 * statically imports search, folding and linting, so its feature flags cannot
 * tree-shake. Spelling out what we need keeps the editor near the payload
 * budget that made CodeMirror the right call over Monaco in the first place.
 */
/**
 * CodeMirror's `defaultHighlightStyle` is built for light backgrounds — on this
 * one its keywords land at 1.6:1, well under the 4.5:1 WCAG needs for body
 * text. Every colour below was checked against the editor's own background.
 */
const darkHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#d3a0ff' },
  { tag: [tags.name, tags.variableName, tags.propertyName], color: '#e6eaf2' },
  { tag: [tags.string, tags.special(tags.string)], color: '#8fe3a3' },
  { tag: [tags.number, tags.bool, tags.null], color: '#f5bd6b' },
  { tag: [tags.operator, tags.punctuation, tags.separator], color: '#b6c0cf' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#8b95a6', fontStyle: 'italic' },
  { tag: tags.typeName, color: '#7de3b0' },
  { tag: tags.invalid, color: '#ff8f7a' },
]);

const theme = EditorView.theme(
  {
    '&': { color: 'var(--color-ink)', backgroundColor: 'transparent' },
    '.cm-content': { caretColor: 'var(--color-accent)', fontFamily: 'var(--font-mono)' },
    '.cm-cursor': { borderLeftColor: 'var(--color-accent)' },
    '.cm-activeLine': { backgroundColor: 'oklch(1 0 0 / 4%)' },
    '.cm-lineNumbers .cm-gutterElement': { color: 'var(--color-ink-dim)' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
      backgroundColor: 'oklch(0.78 0.14 196 / 25%) !important',
    },
  },
  { dark: true },
);

/**
 * Mod-Enter must be a CodeMirror binding, not a DOM handler: the default keymap
 * binds it to `insertBlankLine` and consumes the event before React sees it.
 * `Prec.highest` puts ours in front. It re-emits as a DOM event so the
 * extension array can stay module-scoped — rebuilding it per render would tear
 * the editor down on every keystroke.
 */
const RUN_EVENT = 'querylens:run';

const runKeymap = Prec.highest(
  keymap.of([
    {
      key: 'Mod-Enter',
      run: (view) => {
        view.dom.dispatchEvent(new CustomEvent(RUN_EVENT, { bubbles: true }));
        return true;
      },
    },
  ]),
);

const extensions = [
  runKeymap,
  lineNumbers(),
  EditorView.lineWrapping,
  history(),
  drawSelection(),
  highlightActiveLine(),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  syntaxHighlighting(darkHighlight, { fallback: true }),
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
  sql({ dialect: SQLite, upperCaseKeywords: true }),
  markField,
  theme,
];

export interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  error?: QueryError | undefined;
  /** The clause the current parse step is consuming. */
  activeSpan?: Span | undefined;
}

export function SqlEditor({ value, onChange, onRun, error, activeSpan }: SqlEditorProps) {
  const viewRef = useRef<EditorView | null>(null);

  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const handler = () => { onRun(); };
    el.addEventListener(RUN_EVENT, handler);
    return () => { el.removeEventListener(RUN_EVENT, handler); };
  }, [onRun]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const errorSpan =
      error?.from === undefined ? undefined : { from: error.from, to: error.to ?? error.from + 1 };
    view.dispatch({
      effects: setMarks.of({
        ...(errorSpan === undefined ? {} : { error: errorSpan }),
        ...(activeSpan === undefined ? {} : { active: activeSpan }),
      }),
    });
  }, [error, activeSpan]);

  return (
    <div className="space-y-2">
      <div ref={wrapperRef} className="overflow-hidden rounded-lg border border-edge bg-surface-2">
        <CodeMirrorEditor
          value={value}
          onChange={onChange}
          extensions={extensions}
          className="min-h-30"
          ariaLabel="SQL query"
          viewRef={viewRef}
        />
      </div>

      {error && (
        <div
          role="alert"
          className="rounded-lg border border-evict/60 bg-evict/10 px-3 py-2 text-xs"
        >
          <p className="text-ink">{error.message}</p>
          {error.hint && <p className="mt-1 text-ink-dim">{error.hint}</p>}
        </div>
      )}
    </div>
  );
}
