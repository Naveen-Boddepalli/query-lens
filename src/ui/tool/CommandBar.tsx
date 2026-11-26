import { useEffect, useRef, type ReactNode } from 'react';
import { btnCritical, btnGhost, btnPrimary, btnSecondary, panelSurface } from '../primitives.ts';

export interface Command {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** Why it is disabled, or what it does: the button's tooltip. */
  title?: string;
}

export interface CommandBarProps {
  /** The bar's name ("Operations"). */
  label?: string;
  /** The operation's inputs (a key field, a transaction picker), clustered with the primary. */
  children?: ReactNode;
  /** The one thing a reader came to do. At most one per tool, and none on a tool with no operation (§4.2 rule 1). */
  primary?: Command;
  secondary?: readonly Command[];
  /** Destroys state on purpose (Crash). Its own cluster, in `btnCritical`, never the primary. */
  critical?: readonly Command[];
  /** Rare operations, behind a "More" menu that never wraps onto a line of its own. */
  overflow?: readonly Command[];
}

const cluster = 'flex min-w-0 flex-wrap items-end gap-2';

function Button({ command, className }: { command: Command; className: string }) {
  return (
    <button type="button" onClick={command.onClick} disabled={command.disabled} title={command.title} className={className}>
      {command.label}
    </button>
  );
}

/** The overflow menu: a disclosure that closes on a choice, on Escape and on a press anywhere else. */
function More({ commands }: { commands: readonly Command[] }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (e: Event) => {
      const el = ref.current;
      if (!el?.open) return;
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !el.contains(e.target as Node)) el.open = false;
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, []);
  return (
    <details ref={ref} className="relative">
      <summary className={`${btnGhost} cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>More ▾</summary>
      <div className={`${panelSurface} absolute right-0 z-20 mt-1 flex min-w-44 flex-col p-1`}>
        {commands.map((c) => (
          <button
            key={c.label}
            type="button"
            disabled={c.disabled}
            title={c.title}
            onClick={() => {
              if (ref.current) ref.current.open = false;
              c.onClick();
            }}
            className={`${btnGhost} justify-start`}
          >
            {c.label}
          </button>
        ))}
      </div>
    </details>
  );
}

/**
 * The operations on the current state, above the stage they act on (§4.2). Clusters, not separators: the inputs and
 * the primary, then the secondaries, then the critical actions, then the overflow menu. Each cluster wraps as one
 * unit, so a narrow screen never strands a divider at the start of a line.
 */
export function CommandBar({ label = 'Operations', children, primary, secondary = [], critical = [], overflow = [] }: CommandBarProps) {
  return (
    <div role="group" aria-label={label} className="flex min-w-0 flex-wrap items-end gap-x-6 gap-y-3">
      {(children ?? primary) && (
        <div className={cluster}>
          {children}
          {primary && <Button command={primary} className={btnPrimary} />}
        </div>
      )}
      {secondary.length > 0 && (
        <div className={cluster}>
          {secondary.map((c) => <Button key={c.label} command={c} className={btnSecondary} />)}
        </div>
      )}
      {critical.length > 0 && (
        <div className={cluster}>
          {critical.map((c) => <Button key={c.label} command={c} className={btnCritical} />)}
        </div>
      )}
      {overflow.length > 0 && <More commands={overflow} />}
    </div>
  );
}
