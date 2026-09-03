import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import starlight from '@astrojs/starlight';

/**
 * The QueryLens documentation site (plan.md §17.1).
 *
 * Astro Starlight, chosen because the deciding requirement is embedding real
 * components from `src/` into explanation pages, and it is the only candidate
 * where that costs nothing — React is a first-class island here, where in
 * VitePress it would need a Vue wrapper around a React root.
 *
 * Hosted at `/docs` on the *same* Cloudflare Pages project as the application:
 * one deploy, one origin, one set of headers from `public/_headers`, and
 * relative links between app and docs that cannot break. That also matters for
 * the CSP — `frame-ancestors 'none'` means no docs page may ever iframe the
 * live app, so demos import components or link out with a shareable URL.
 */
export default defineConfig({
  site: process.env.VITE_SITE_URL ?? 'https://query-lens.pages.dev',
  base: '/docs',
  // Emitted straight into the application's build output. `pnpm build` runs
  // Vite first (which empties dist/) and this second, so the order matters.
  outDir: '../dist/docs',
  // The app owns dist/; this build must not tidy up around it.
  build: { assets: 'assets' },
  integrations: [
    // `starlight()` must precede `mdx()`: it registers astro-expressive-code
    // for MDX's code blocks, and that integration insists on running first —
    // building errors out by name if the order is reversed.
    starlight({
      title: 'QueryLens',
      description:
        'How QueryLens models a SQL query — parser, planner, optimizer, execution, buffer pool, B+Tree index and locks.',
      // `docs/public/favicon.svg` is a byte-for-byte copy of the app's own
      // `public/favicon.svg` (both trace back to scripts/build-icons.py's
      // source geometry), kept in sync by hand rather than symlinked — a
      // symlink does not survive every deploy pipeline. Astro's `base: '/docs'`
      // prefixes even an absolute-looking favicon path, so pointing this at
      // the app's root `/favicon.svg` produced a <link> to a file that does
      // not exist under /docs; a local copy is what makes the base-prefixed
      // path resolve to something real.
      customCss: ['./src/styles/querylens.css'],
      // The fonts the application already serves. Same origin, so the docs pay
      // nothing to reuse them and the two halves of the site cannot drift apart
      // typographically.
      head: [
        {
          tag: 'link',
          attrs: { rel: 'preload', href: '/fonts/querylens-sans.woff2', as: 'font', type: 'font/woff2', crossorigin: true },
        },
        {
          tag: 'link',
          attrs: { rel: 'preload', href: '/fonts/querylens-mono.woff2', as: 'font', type: 'font/woff2', crossorigin: true },
        },
      ],
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/Naveen-Boddepalli/query-lens' },
      ],
      editLink: {
        baseUrl: 'https://github.com/Naveen-Boddepalli/query-lens/edit/main/docs/',
      },
      sidebar: [
        { label: 'Start here', items: [
          { label: 'What QueryLens is', link: '/' },
          { label: 'Getting started', link: '/getting-started/' },
          { label: 'FAQ', link: '/faq/' },
        ]},
        { label: 'Concepts', items: [
          { label: 'The buffer pool', link: '/concepts/buffer-pool/' },
          { label: 'The B+Tree index', link: '/concepts/btree/' },
        ]},
        { label: 'Reference', items: [
          { label: 'Supported SQL', link: '/reference/sql/' },
          { label: 'Keyboard shortcuts', link: '/reference/shortcuts/' },
          { label: 'URL parameters', link: '/reference/url-parameters/' },
          { label: 'Engine limits', link: '/reference/limits/' },
        ]},
      ],
    }),
    // After starlight() — see the note above. The whole reason Astro Starlight
    // was chosen over VitePress (plan.md §17.1): a .mdx page can `import` a
    // real component and embed a real piece of `src/`, not a screenshot of it.
    mdx(),
  ],
});
