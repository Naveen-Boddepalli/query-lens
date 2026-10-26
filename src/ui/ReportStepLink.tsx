import { btnGhost } from './primitives.ts';
import { stepReportUrl } from './stepReport.ts';
import type { Moment } from './stepReport.ts';

/**
 * plan.md §25.4 A3. A plain link, deliberately: it opens a prefilled GitHub
 * issue form in a new tab, and nothing is sent anywhere until the reader
 * submits it there. `noreferrer` keeps the app's own URL (which can carry the
 * query and edited rows) out of the Referer header — the report carries the
 * moment on purpose, in the body they can read and edit, and not by accident.
 */
export function ReportStepLink({ moment }: { moment: Moment }) {
  return (
    <a
      href={stepReportUrl(moment)}
      target="_blank"
      rel="noreferrer noopener"
      title="Opens a prefilled GitHub issue in a new tab — nothing is sent until you submit it there."
      className={btnGhost}
    >
      Report a confusing step
      <span className="sr-only"> (opens GitHub in a new tab)</span>
    </a>
  );
}
