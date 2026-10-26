import { BUILD_SHA, BUILD_TIME, newFormIssueUrl, REPO_URL } from '../buildInfo.ts';
import type { ReplacementPolicyName, Row } from '../engine/index.ts';

/**
 * plan.md §14.1 item 4. The crashing state is four serialisable values the app
 * already holds, and a bug report without them is unactionable — this engine is
 * deterministic, so with them the crash reproduces on the first try.
 */
export interface Repro {
  sql: string;
  policy: ReplacementPolicyName;
  step: number;
  predictOn: boolean;
  rows: Row[];
  /** False when the rows are still the untouched seed set (plan.md §7.5). */
  rowsEdited: boolean;
}

let latest: Repro | null = null;

/**
 * Called during App's render, not from an effect. That is deliberate: the state
 * worth reporting is the state of the render that threw, and an effect only
 * ever sees the last render that *succeeded* — which would report step 12 for a
 * crash the user triggered by stepping to 13. The write is idempotent, so
 * StrictMode's double render is harmless.
 */
export function publishRepro(repro: Repro): void {
  latest = repro;
}

export function currentRepro(): Repro | null {
  return latest;
}

function describe(error: unknown): { message: string; stack: string } {
  if (error instanceof Error) {
    return { message: `${error.name}: ${error.message}`, stack: error.stack ?? '(no stack)' };
  }
  return { message: String(error), stack: '(not an Error object)' };
}

/** A Markdown block, because it is pasted into a GitHub issue or a chat. */
export function formatReport(error: unknown, componentStack?: string | null): string {
  const { message, stack } = describe(error);
  const repro = currentRepro();

  const lines = [
    '**QueryLens crash report**',
    '',
    `- Build: \`${BUILD_SHA}\` (built ${BUILD_TIME})`,
    `- Page: ${typeof location === 'undefined' ? '(unknown)' : location.href}`,
    `- Browser: ${typeof navigator === 'undefined' ? '(unknown)' : navigator.userAgent}`,
    `- When: ${new Date().toISOString()}`,
    '',
    '**Error**',
    '',
    '```',
    message,
    stack,
    '```',
  ];

  if (componentStack) {
    lines.push('', '**Component stack**', '', '```', componentStack.trim(), '```');
  }

  lines.push('', '**Reproduce**', '');
  if (repro) {
    lines.push(
      '```json',
      JSON.stringify(
        {
          sql: repro.sql,
          policy: repro.policy,
          step: repro.step,
          predictOn: repro.predictOn,
          rowsEdited: repro.rowsEdited,
          // Only when they differ from the seed set: otherwise this is 12 rows
          // of noise that anyone can regenerate by opening the app.
          rows: repro.rowsEdited ? repro.rows : '(unedited seed data)',
        },
        null,
        2,
      ),
      '```',
    );
  } else {
    lines.push('_The app crashed before any query state was recorded._');
  }

  return lines.join('\n');
}

export function issueUrlFor(error: unknown, componentStack?: string | null): string {
  const { message } = describe(error);
  // Fields of `.github/ISSUE_TEMPLATE/bug_report.yml`, by id — a form link, not a
  // free-form `body`, so the prefill survives the repository's blank-issues-off setting.
  return newFormIssueUrl('bug_report.yml', `Crash: ${message.slice(0, 90)}`, {
    description: `The app showed its error screen: ${message}`,
    repro: 'The crash report below has the query, policy and step — the engine is deterministic, so it reproduces exactly.',
    'error-boundary': formatReport(error, componentStack),
  });
}

/**
 * plan.md §14.1 item 3. React's boundaries only catch errors thrown while
 * rendering; a throw inside a `setTimeout`, an event listener React does not
 * own, or a rejected promise escapes them entirely and would otherwise vanish
 * into a console nobody has open. There is no telemetry by design (§14.4), so
 * the console *is* the sink — print the same report the fallback offers, so a
 * user who is asked "what does the console say" has one block to copy.
 */
export function installGlobalErrorHandlers(): void {
  if (typeof window === 'undefined') return;

  window.addEventListener('error', (event) => {
    // Resource load failures (a missing chunk) surface here with no `error`.
    // ErrorEvent types both fields as `any`; narrow once, at the boundary.
    const detail: unknown = event.error ?? event.message;
    console.error('[QueryLens] uncaught error\n\n' + formatReport(detail));
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    console.error('[QueryLens] unhandled rejection\n\n' + formatReport(reason));
  });
}

/** So a screenshot of the console identifies the build (plan.md §14.1 item 9). */
export function logBuildBanner(): void {
  console.info(
    `%cQueryLens%c build ${BUILD_SHA} · ${BUILD_TIME}\nA simplified educational model of database internals. Source: ${REPO_URL}`,
    'font-weight:bold',
    'font-weight:normal',
  );
}
