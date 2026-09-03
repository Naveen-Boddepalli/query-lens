import { Component, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { formatReport, issueUrlFor } from './errorReport.ts';

interface Props {
  children: ReactNode;
  /**
   * 'page' is the root boundary: the alternative to it is a white screen.
   * 'panel' wraps one stage view, so the rest of the app — narration, playback,
   * the SQL the user typed — survives and the trace is not lost.
   */
  variant: 'page' | 'panel';
  /** Named in the fallback so the report says *which* panel died. */
  label?: string;
  /**
   * Changing this remounts the boundary. `StageDetail` is keyed by stage, and a
   * renderer that throws on the B+Tree should not keep the parse view broken.
   */
  resetKey?: unknown;
}

interface State {
  error: unknown;
  componentStack: string | null;
}

const EMPTY: State = { error: null, componentStack: null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = EMPTY;

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? null });
    console.error('[QueryLens] render error\n\n' + formatReport(error, info.componentStack));
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState(EMPTY);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <ErrorFallback
        error={this.state.error}
        componentStack={this.state.componentStack}
        variant={this.props.variant}
        {...(this.props.label === undefined ? {} : { label: this.props.label })}
        onRetry={() => { this.setState(EMPTY); }}
      />
    );
  }
}

interface FallbackProps {
  error: unknown;
  componentStack: string | null;
  variant: 'page' | 'panel';
  label?: string;
  onRetry: () => void;
}

function ErrorFallback({ error, componentStack, variant, label, onRetry }: FallbackProps) {
  const [copied, setCopied] = useState(false);
  const report = formatReport(error, componentStack);
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);

  async function copy() {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => { setCopied(false); }, 2000);
    } catch {
      // Clipboard access can be denied, and an unusable Copy button is worse
      // than none: fall back to selecting the text the user can already see.
      const pre = document.getElementById('querylens-crash-report');
      if (pre) getSelection()?.selectAllChildren(pre);
    }
  }

  return (
    <div
      role="alert"
      className={
        variant === 'page'
          ? 'mx-auto my-10 w-full max-w-2xl rounded-lg border border-evict/50 bg-surface-2 p-6'
          : 'flex h-full flex-col rounded-md border border-evict/50 bg-surface-3/40 p-4'
      }
    >
      <h2 className="text-base font-semibold text-ink">
        {variant === 'page'
          ? 'QueryLens hit a bug and stopped'
          : `The ${label ?? 'stage'} view hit a bug`}
      </h2>

      <p className="mt-1 text-sm text-ink-dim">
        {variant === 'page'
          ? 'The engine is deterministic, so the details below reproduce this exactly. Copying them into an issue is genuinely the whole bug report.'
          : 'The rest of the trace is intact — step away from this stage and it will keep working. The details below reproduce it exactly.'}
      </p>

      <p className="mt-3 font-mono text-xs break-words text-evict">{message}</p>

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => { void copy(); }}
          className="rounded-md border border-accent bg-accent/15 px-3 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-accent/25"
        >
          {copied ? 'Copied ✓' : 'Copy report'}
        </button>
        <a
          href={issueUrlFor(error, componentStack)}
          target="_blank"
          rel="noreferrer noopener"
          className="rounded-md border border-edge px-3 py-1.5 text-sm text-ink-dim transition-colors hover:border-accent/70 hover:text-ink"
        >
          Open an issue
        </a>
        <button
          type="button"
          onClick={variant === 'page' ? () => { location.reload(); } : onRetry}
          className="rounded-md border border-edge px-3 py-1.5 text-sm text-ink-dim transition-colors hover:border-accent/70 hover:text-ink"
        >
          {variant === 'page' ? 'Reload' : 'Try again'}
        </button>
      </div>

      {/* Shown, not hidden behind the button: a Copy that silently failed is
          exactly the situation where the text still has to be readable. */}
      <pre
        id="querylens-crash-report"
        className="mt-4 max-h-56 overflow-auto rounded border border-edge bg-surface p-3 font-mono text-xs whitespace-pre-wrap text-ink-dim"
      >
        {report}
      </pre>
    </div>
  );
}
