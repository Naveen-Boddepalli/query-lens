/**
 * The docs sidebar's structure (`DocsLayout`), and the source the footer's
 * "Documentation" column reads from (`Footer.tsx`) — one list, so a page added
 * to one and not the other cannot happen, the same discipline `src/routes.ts`
 * applies to the top-level nav.
 */
export interface DocsNavGroup {
  title: string;
  items: { to: string; label: string }[];
}

export const DOCS_NAV: readonly DocsNavGroup[] = [
  {
    title: 'Introduction',
    items: [
      { to: '/docs', label: 'Overview' },
      { to: '/docs/getting-started', label: 'Getting started' },
      { to: '/docs/faq', label: 'FAQ' },
    ],
  },
  {
    title: 'Manual',
    items: [
      { to: '/docs/manual/eviction', label: 'Watch a page get evicted' },
      { to: '/docs/manual/btree-split', label: 'Watch a B+Tree split' },
    ],
  },
  {
    title: 'Concepts',
    items: [
      { to: '/docs/concepts/buffer-pool', label: 'Buffer pool' },
      { to: '/docs/concepts/btree', label: 'B+Tree' },
    ],
  },
  {
    title: 'Study',
    items: [
      { to: '/docs/study/course-map', label: 'Course map' },
      { to: '/docs/study/interview-roadmap', label: 'Interview roadmap' },
    ],
  },
  {
    title: 'Reference',
    items: [
      { to: '/docs/reference/sql', label: 'Supported SQL' },
      { to: '/docs/reference/url-parameters', label: 'URL parameters' },
      { to: '/docs/reference/shortcuts', label: 'Keyboard shortcuts' },
      { to: '/docs/reference/limits', label: 'Engine limits' },
      { to: '/docs/reference/answers', label: 'How we know the answers are right' },
    ],
  },
  {
    title: 'Architecture',
    items: [{ to: '/docs/architecture', label: 'Architecture' }],
  },
];
