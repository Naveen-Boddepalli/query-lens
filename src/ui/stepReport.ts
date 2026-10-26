import { BUILD_SHA, BUILD_TIME, newFormIssueUrl } from '../buildInfo.ts';
import type { ReplacementPolicyName, Stage } from '../engine/index.ts';

/**
 * plan.md §25.4 A3 — "Report a confusing step".
 *
 * QueryLens has no telemetry, by decision (§14.4), so the only signal about
 * *which moments confuse people* is the one a person chooses to send. This
 * builds that message: a prefilled GitHub issue form carrying the exact
 * moment — build, step, stage, what the narration said, the query, and a link
 * that reopens it. It is a link, not a request: nothing leaves the browser
 * until the reader presses Submit on GitHub, where they can edit or delete
 * any of it first.
 *
 * Pure and DOM-free (`location` is read by the caller), so it is unit-tested
 * without rendering the Playground.
 */
export interface Moment {
  sql: string;
  policy: ReplacementPolicyName;
  predictOn: boolean;
  /** Playhead position, 0 … `stepCount`. */
  step: number;
  stepCount: number;
  /** The stage the step is in, or `null` before the first step / on a query error. */
  stage: Stage | null;
  /** What the narration line says right now — the thing that may have confused. */
  narration: string;
  /** A preset's id, or "a custom database". */
  dataset: string;
  rowsEdited: boolean;
  /** Absolute link that reopens this moment (the address bar's `?q=…&s=…`). */
  shareUrl: string;
}

/**
 * Below GitHub's request-line limit with room to spare. The share link is the
 * one part that can be large (an edited table is encoded into it), so it is the
 * part that yields — see `stepReportUrl`.
 */
export const MAX_REPORT_URL = 6000;

const TITLE_NARRATION = 60;

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The "Where" box: Markdown, because it lands in an issue. */
export function formatMoment(m: Moment, link: 'full' | 'no-data' | 'none' = 'full'): string {
  const where =
    m.step === 0
      ? 'before the first step'
      : `step ${m.step} of ${m.stepCount}${m.stage ? ` — stage \`${m.stage}\`` : ''}`;

  const lines = [
    `- **Where:** ${where}`,
    `- **Build:** \`${BUILD_SHA}\` (built ${BUILD_TIME})`,
    `- **Settings:** ${m.policy === 'lru' ? 'LRU' : 'clock sweep'} policy · predictions ${m.predictOn ? 'on' : 'off'} · ${
      m.rowsEdited ? `edited data (${m.dataset})` : m.dataset
    }`,
  ];

  if (link === 'full') lines.push(`- **Reopen this moment:** ${m.shareUrl}`);
  else if (link === 'no-data') {
    lines.push(
      `- **Reopen this moment:** ${m.shareUrl} _(the edited data was too large to put in the link — the query and step are, the rows are not)_`,
    );
  } else {
    lines.push('- **Reopen this moment:** _(too long to prefill — use the Playground’s Copy link and paste it here)_');
  }

  const narration = oneLine(m.narration);
  lines.push(
    '',
    '**The narration said:**',
    '',
    narration ? `> ${narration}` : '> _(nothing yet)_',
    '',
    '**The query:**',
    '',
    '```sql',
    m.sql.trim(),
    '```',
  );
  return lines.join('\n');
}

/** `shareUrl` with the `d` (edited rows) parameter removed, for when the whole link would be too long. */
function withoutData(shareUrl: string): string {
  try {
    const url = new URL(shareUrl);
    url.searchParams.delete('d');
    return url.toString();
  } catch {
    return shareUrl;
  }
}

/**
 * The link the button opens. Tries the full moment first; if the resulting URL
 * would be too long, drops the edited rows from the share link, and if it is
 * *still* too long (a huge query), drops the link — always keeping the step,
 * the narration and the build, which are what make a report actionable.
 */
export function stepReportUrl(m: Moment): string {
  const stage = m.stage ?? 'trace';
  const narration = oneLine(m.narration);
  const title = `Confusing step: ${stage}${narration ? ` — ${narration.slice(0, TITLE_NARRATION)}${narration.length > TITLE_NARRATION ? '…' : ''}` : ''}`;

  const attempts: [Moment, 'full' | 'no-data' | 'none'][] = [
    [m, 'full'],
    [{ ...m, shareUrl: withoutData(m.shareUrl) }, 'no-data'],
    [m, 'none'],
  ];
  for (const [moment, mode] of attempts) {
    const url = newFormIssueUrl('confusing_step.yml', title, { moment: formatMoment(moment, mode) });
    if (url.length <= MAX_REPORT_URL) return url;
  }
  // Last resort — a truly enormous query. Keep the report openable at the cost of the query text.
  return newFormIssueUrl('confusing_step.yml', title, {
    moment: formatMoment({ ...m, sql: '(query too long to prefill)', narration: narration.slice(0, 300) }, 'none'),
  });
}
