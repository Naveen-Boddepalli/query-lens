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

/**
 * Extensions are listed explicitly rather than using `basicSetup`: that bundle
 * statically imports search, folding and linting, so its feature flags cannot
 * tree-shake. Spelling out what we need keeps the editor near the payload
 * budget that made CodeMirror the right call over Monaco in the first place.
 */
/**
 * CodeMirror's `defaultHighlightStyle` is built for light backgrounds — on the
 * dark one its keywords land at 1.6:1, well under the 4.5:1 WCAG needs for body
 * text. Every colour below was checked against the editor's own background.
 *
 * These are the one thing in the app that a CSS variable cannot carry:
 * `HighlightStyle.define` bakes its colours into generated class rules at
 * definition time, so the two themes have to be two objects, swapped through a
 * compartment rather than repainted by the cascade (plan.md §15.3).
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

/** The same eight roles, re-picked against a near-white editor background. */
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

/**
 * Everything here that *can* be a token is one, so the cascade handles it and
 * only `dark` — which CodeMirror uses to pick its own defaults — needs swapping.
 */
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

/**
 * One compartment for both, reconfigured together. The extension array stays
 * module-scoped — rebuilding it per render would tear the editor down on every
 * keystroke, which is the reason this file is shaped the way it is.
 */
const appearance = new Compartment();

const appearanceFor = (theme: 'light' | 'dark') =>
  theme === 'dark'
    ? [syntaxHighlighting(darkHighlight, { fallback: true }), editorTheme(true)]
    : [syntaxHighlighting(lightHighlight, { fallback: true }), editorTheme(false)];

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
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
  sql({ dialect: SQLite, upperCaseKeywords: true }),
  markField,
  // Resolved before first paint by public/theme.js, so the editor is never
  // built with the wrong palette and then corrected.
  appearance.of(appearanceFor(readInitialTheme())),
];

function readInitialTheme(): 'light' | 'dark' {
  if (typeof document === 'undefined') return 'dark';
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
  error?: QueryError | undefined;
  /** The clause the current parse step is consuming. */
  activeSpan?: Span | undefined;
  theme: 'light' | 'dark';
}

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

  // Reconfigure rather than remount: the editor keeps its document, selection
  // and undo history across a theme change.
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
          className="rounded-lg border border-evict/60 bg-evict/10 px-3 py-2 text-label"
        >
          <p className="text-ink">{error.message}</p>
          {error.hint && <p className="mt-1 text-ink-dim">{error.hint}</p>}
        </div>
      )}
    </div>
  );
}
