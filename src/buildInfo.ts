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
