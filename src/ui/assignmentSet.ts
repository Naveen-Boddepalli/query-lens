/**
 * plan.md §22.4: several `/assignments/new` links bundled into one sheet with a
 * class code. No backend and no submission — §20.5's line is unchanged; the
 * sheet is something an instructor pastes into their LMS or prints.
 *
 * Pure: the page holds the list, this turns it into text.
 */

export interface AssignmentItem {
  /** The instructor's name for this task. */
  label: string;
  /** A `/playground?…` link produced by the authoring form. */
  link: string;
}

/** A numbered Markdown worksheet — a heading, then one line per assignment. */
export function worksheet(code: string, items: readonly AssignmentItem[]): string {
  const title = code.trim() === '' ? 'Assignment set' : `${code.trim()} — assignment set`;
  const lines = [`# ${title}`, ''];
  items.forEach((item, i) => {
    const label = item.label.trim() === '' ? `Assignment ${String(i + 1)}` : item.label.trim();
    lines.push(`${String(i + 1)}. **${label}** — ${item.link}`);
  });
  return `${lines.join('\n')}\n`;
}

/** The same set as a JSON file the instructor can keep or re-open by hand. */
export function serializeSet(code: string, items: readonly AssignmentItem[]): string {
  return `${JSON.stringify(
    {
      kind: 'querylens/assignment-set',
      version: 1,
      code: code.trim(),
      assignments: items.map((i) => ({ label: i.label.trim(), link: i.link })),
    },
    null,
    2,
  )}\n`;
}
