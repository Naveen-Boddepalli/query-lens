import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { EditorState } from '@codemirror/state';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

export interface CodeMirrorEditorProps {
  value: string;
  onChange: (value: string) => void;
  extensions: Extension[];
  className?: string;
  ariaLabel?: string;
  /** Populated with the live view, so callers can dispatch effects into it. */
  viewRef?: RefObject<EditorView | null>;
}

/**
 * A ~40-line React binding for CodeMirror 6, in place of
 * `@uiw/react-codemirror`: that wrapper statically imports its `basicSetup`
 * bundle (search, folding, linting) whether or not you ask for it, which puts
 * roughly 250 kB back into the bundle we chose CodeMirror to avoid.
 */
export function CodeMirrorEditor({
  value,
  onChange,
  extensions,
  className,
  ariaLabel,
  viewRef,
}: CodeMirrorEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const ownViewRef = useRef<EditorView | null>(null);

  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  });

  // The view is created once. `value` is pushed in by the effect below, so the
  // editor stays a controlled component without being torn down on each keystroke.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          ...extensions,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    ownViewRef.current = view;
    if (viewRef) viewRef.current = view;

    return () => {
      view.destroy();
      ownViewRef.current = null;
      if (viewRef) viewRef.current = null;
    };
    // `value` is intentionally read only as the initial document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extensions, viewRef]);

  useEffect(() => {
    const view = ownViewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return <div ref={hostRef} className={className} role="textbox" aria-label={ariaLabel} />;
}
