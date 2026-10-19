/**
 * Every route the app serves, with one or two of each `:id` kind and a path that does not exist — the list the
 * WCAG audit (`audit.spec.ts`) scans and the page-title check (`titles.spec.ts`) walks. A new route belongs here.
 */
export const ROUTES: readonly string[] = [
  '/', '/playground', '/stages', '/stages/parse', '/learn', '/learn/one-row', '/learn/dirty-read', '/challenges',
  '/challenges/exactly-one', '/challenges/read-the-unreal', '/challenges/ahead-of-its-log',
  '/challenges/one-merge-pass', '/challenges/bigger-pool-more-misses', '/challenges/index-with-two-rules',
  '/challenges/one-page-deadlock', '/challenges/and-before-or', '/challenges/not-paris-either', '/learn/nulls',
  // A challenge on the three-table `shop` preset, whose page names the tables (plan.md §27.5 S2), and its lesson.
  '/challenges/never-ordered', '/learn/not-exists', '/challenges/leave-no-one-out', '/learn/outer-joins', '/challenges/count-each-once', '/challenges/above-average', '/challenges/who-referred-whom', '/learn/lock-table', '/tools', '/tools/buffer-pool', '/tools/parser', '/tools/planner', '/tools/btree',
  '/tools/page', '/tools/sort', '/tools/locks', '/tools/schedule', '/tools/isolation', '/tools/concurrency', '/tools/wal', '/tools/recovery', '/tools/grammar', '/tools/hash-join', '/tools/join-order', '/tools/histograms', '/tools/parallel', '/tools/partitioning',
  '/tools/lsm', '/tools/hash-index', '/tools/columnar', '/tools/latch-crabbing', '/tools/vector-index', '/gallery',
  '/examples', '/trace', '/compare', '/progress', '/practice', '/settings', '/assignments/new', '/study', '/docs',
  '/docs/getting-started', '/docs/faq', '/docs/architecture', '/docs/concepts/btree', '/docs/concepts/buffer-pool',
  '/docs/manual/eviction', '/docs/manual/btree-split', '/docs/essays/index-write-tax',
  '/docs/essays/scan-resistance', '/docs/essays/repeatable-read', '/docs/study/course-map', '/docs/study/interview-roadmap',
  '/docs/reference/sql', '/docs/reference/url-parameters', '/docs/reference/shortcuts', '/docs/reference/limits',
  '/docs/reference/answers', '/docs/accessibility', '/nothing-here',
];
