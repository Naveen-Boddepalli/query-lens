// plan.md §14.1 item 9. Injected by vite.config.ts `define`; see vite-env.d.ts.
export const BUILD_SHA: string = __BUILD_SHA__;
export const BUILD_TIME: string = __BUILD_TIME__;

export const REPO_URL = 'https://github.com/Naveen-Boddepalli/query-lens';

/**
 * plan.md §14.1 item 4: the crashing state is a handful of serialisable values
 * the app already holds, and this is the only bug report that will ever
 * arrive. Prefilling the issue body means the reporter does not have to know
 * which four things mattered.
 */
export function newIssueUrl(title: string, body: string): string {
  const url = new URL(`${REPO_URL}/issues/new`);
  url.searchParams.set('title', title);
  url.searchParams.set('body', body);
  return url.toString();
}

/**
 * A prefilled *issue form* (`.github/ISSUE_TEMPLATE/<template>`), each field
 * keyed by the `id` the form declares.
 *
 * Preferred over `newIssueUrl`'s free-form `body`: the repository disables blank
 * issues (`config.yml`), and with blank issues off GitHub sends a bare
 * `issues/new?body=…` to the template chooser — where the prefill is lost. A
 * link that names a template goes straight to that form with its fields filled.
 */
export function newFormIssueUrl(template: string, title: string, fields: Readonly<Record<string, string>>): string {
  const url = new URL(`${REPO_URL}/issues/new`);
  url.searchParams.set('template', template);
  if (title) url.searchParams.set('title', title);
  for (const [id, value] of Object.entries(fields)) url.searchParams.set(id, value);
  return url.toString();
}
