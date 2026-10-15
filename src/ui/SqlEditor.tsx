import { useEffect, useRef } from 'react';
import { Compartment, Prec } from '@codemirror/state';
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

const lightHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: '#6b21a8' },
  { tag: [tags.name, tags.variableName, tags.propertyName], color: '#1f2733' },
  { tag: [tags.string, tags.special(tags.string)], color: '#116343' },
  { tag: [tags.number, tags.bool, tags.null], color: '#8a4b06' },
  { tag: [tags.operator, tags.punctuation, tags.separator], color: '#4a5566' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#5d6675', fontStyle: 'italic' },
  { tag: tags.typeName, color: '#0f5f56' },
  { tag: tags.invalid, color: '#a4231a' },
]);

const editorTheme = (dark: boolean) =>
  EditorView.theme(
    {
      '&': { color: 'var(--color-ink)', backgroundColor: 'transparent' },
      '.cm-content': { caretColor: 'var(--color-accent)', fontFamily: 'var(--font-mono)' },
      '.cm-cursor': { borderLeftColor: 'var(--color-accent)' },
      '.cm-activeLine': { backgroundColor: 'var(--color-line-active)' },
      '.cm-lineNumbers .cm-gutterElement': { color: 'var(--color-ink-dim)' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
        backgroundColor: 'var(--color-select) !important',
      },
    },
    { dark },
  );

const appearance = new Compartment();

const appearanceFor = (theme: 'light' | 'dark') =>
  theme === 'dark'
    ? [syntaxHighlighting(darkHighlight, { fallback: true }), editorTheme(true)]
    : [syntaxHighlighting(lightHighlight, { fallback: true }), editorTheme(false)];

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
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
  sql({ dialect: SQLite, upperCaseKeywords: true }),
  markField,
  appearance.of(appearanceFor(typeof document !== 'undefined' && document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')),
];

export interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  error?: QueryError | undefined;
  /** The clause the current parse step is consuming. */
  activeSpan?: Span | undefined;
  theme: 'light' | 'dark';
}

const S = 'SELECT * FROM users ';
const SNIPPETS = [
  ['WHERE', `${S}WHERE id = 1`],
  ['LIMIT', `${S}LIMIT 5`],
] as const;

export function SqlEditor({ value, onChange, onRun, error, activeSpan, theme }: SqlEditorProps) {
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
    viewRef.current?.dispatch({ effects: appearance.reconfigure(appearanceFor(theme)) });
  }, [theme]);

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
      <div
        ref={wrapperRef}
        className="ql-sheen overflow-hidden rounded-xl border border-edge bg-surface-2 shadow-e2"
      >
        <div className="flex items-center justify-between border-b border-edge/70 px-3 py-1.5">
          <span className="font-mono text-label text-ink-dim">query.sql</span>
          <div className="flex gap-1 font-mono text-label">
            {SNIPPETS.map(([label, q]) => (
              <button
                key={label}
                type="button"
                onClick={() => { onChange(q); }}
                className="rounded border border-edge bg-surface-2 px-1.5 py-0.5 text-ink-dim hover:text-ink"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
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
          className="rounded-xl border border-edge bg-surface-2 px-3 py-2 text-label shadow-e1"
        >
          <p className="font-medium text-evict">{error.message}</p>
          {error.hint && <p className="mt-1 text-ink-dim">{error.hint}</p>}
        </div>
      )}
    </div>
  );
}
