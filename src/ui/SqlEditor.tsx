import { CodeMirrorEditor } from './CodeMirrorEditor.tsx';
import { sql, SQLite } from '@codemirror/lang-sql';
import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { bracketMatching, defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from '@codemirror/view';

/**
 * Extensions are listed explicitly rather than using `basicSetup`: that bundle
 * statically imports search, folding and linting, so its feature flags cannot
 * tree-shake. Spelling out what we need keeps the editor near the payload
 * budget that made CodeMirror the right call over Monaco in the first place.
 */
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

const extensions = [
  lineNumbers(),
  history(),
  drawSelection(),
  highlightActiveLine(),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
  keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
  sql({ dialect: SQLite, upperCaseKeywords: true }),
  theme,
];

export interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  onRun: () => void;
}

export function SqlEditor({ value, onChange, onRun }: SqlEditorProps) {
  return (
    <div
      className="overflow-hidden rounded-lg border border-edge bg-surface-2"
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          onRun();
        }
      }}
    >
      <CodeMirrorEditor
        value={value}
        onChange={onChange}
        extensions={extensions}
        className="min-h-30"
        ariaLabel="SQL query"
      />
    </div>
  );
}
