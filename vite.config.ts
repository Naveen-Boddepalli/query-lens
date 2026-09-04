import { execSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import mdx from '@mdx-js/rollup';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMdxFrontmatter from 'remark-mdx-frontmatter';

// plan.md §14.1 item 9. Without this, no bug report can be tied to a build.
// Cloudflare Pages sets CF_PAGES_COMMIT_SHA; GitHub Actions sets GITHUB_SHA;
// a developer machine has git. If all three fail the string says so rather
// than pretending — 'unknown' in a repro is information, a wrong SHA is not.
function buildSha(): string {
  const fromCi = process.env.CF_PAGES_COMMIT_SHA ?? process.env.GITHUB_SHA;
  if (fromCi) return fromCi.slice(0, 12);
  try {
    return execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
}

const BUILD_SHA = buildSha();
const BUILD_TIME = new Date().toISOString();

// og:image and canonical have to be absolute — a relative one is dropped by
// most scrapers, and the preview card *is* the landing page (plan.md §14.1
// item 8). Cloudflare Pages sets CF_PAGES_URL per deployment; the default is
// the project's production hostname. Override with VITE_SITE_URL if the site
// ever moves to a custom domain, rather than editing markup.
const SITE_URL = (
  process.env.VITE_SITE_URL ??
  process.env.CF_PAGES_URL ??
  'https://query-lens.pages.dev'
).replace(/\/$/, '');

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    { enforce: 'pre', ...mdx({ remarkPlugins: [remarkFrontmatter, remarkMdxFrontmatter] }) },
    react(),
    tailwindcss(),
    {
      // The stamp has to be readable without running any script — "view source
      // and tell me what it says" is a question that gets asked over chat.
      name: 'querylens-build-stamp',
      transformIndexHtml: {
        order: 'pre',
        handler: (html: string) =>
          html
            .replaceAll('%SITE_URL%', SITE_URL)
            .replace(
              '</head>',
              `  <meta name="querylens:build" content="${BUILD_SHA}" />\n` +
                `    <meta name="querylens:built-at" content="${BUILD_TIME}" />\n  </head>`,
            ),
      },
    },
  ],
  build: {
    /**
     * plan.md §14.2 asked for the panels to be lazy-loaded behind Run, on the
     * grounds that React Flow and d3-hierarchy "render nothing until Run".
     * §15.1 item 1 then made the app run its first trace on load, so the AST
     * tree *is* first paint now and deferring it would undo the fix that made
     * the app comprehensible. The premise changed; the item does not apply as
     * written, and pretending otherwise would trade a real teaching win for a
     * smaller number.
     *
     * What is still worth having is separation for caching: app code changes
     * on every commit, these three do not, so splitting them means a returning
     * visitor re-downloads ~10 kB rather than ~260 kB, and the browser fetches
     * them in parallel. The size floor is held by the CI budget instead
     * (`scripts/bundle-budget.ts`), which is the durable half of that item.
     */
    rolldownOptions: {
      output: {
        advancedChunks: {
          groups: [
            { name: 'codemirror', test: /node_modules\/(@codemirror|@lezer|style-mod|w3c-keyname)\// },
            { name: 'flow', test: /node_modules\/(@xyflow|d3-|classcat|zustand)/ },
            { name: 'react', test: /node_modules\/(react|react-dom|scheduler)\// },
          ],
        },
      },
    },
  },
  define: {
    __BUILD_SHA__: JSON.stringify(BUILD_SHA),
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    // Scoped to src/: `e2e/` is Playwright's, and Vitest cannot run it.
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
});
