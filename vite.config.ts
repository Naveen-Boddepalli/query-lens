import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import mdx from '@mdx-js/rollup';
import remarkFrontmatter from 'remark-frontmatter';
import remarkMdxFrontmatter from 'remark-mdx-frontmatter';
import remarkGfm from 'remark-gfm';
import rehypeSlug from 'rehype-slug';

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
// item 8). CF_PAGES_URL is classic-Pages-only and this project runs on the
// unified Workers-with-static-assets engine instead (plan.md §6) — Cloudflare
// documents no equivalent auto-injected URL for a Workers Builds deploy, so
// it is never set here and the fallback below is the real, live default, not
// a placeholder. It was wrong once already: `query-lens.pages.dev` never
// resolved (no such project existed under that exact slug), which silently
// broke every og:url/og:image tag until the live URL was checked by hand
// post-deploy. Override with VITE_SITE_URL if the site moves to a custom
// domain, rather than editing markup or this fallback.
const SITE_URL = (
  process.env.VITE_SITE_URL ??
  process.env.CF_PAGES_URL ??
  'https://query-lens.1234naveenboddepalli.workers.dev'
).replace(/\/$/, '');

// https://vite.dev/config/
// plan.md §H1. public/sw.js is written by hand; the build fills in the two things only the build knows: this
// build's stamp, which names the cache, and every file it emitted, which is what the worker precaches.
const SW_NOT_PRECACHED = new Set(['sw.js', '_headers', '_redirects']);

function listFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`],
  );
}

let swOutDir = '';

const serviceWorkerPlugin = {
  name: 'querylens-service-worker',
  apply: 'build',
  configResolved(config: { root: string; build: { outDir: string } }) {
    swOutDir = resolve(config.root, config.build.outDir);
  },
  closeBundle() {
    const file = join(swOutDir, 'sw.js');
    const source = readFileSync(file, 'utf8');
    if (!source.includes('__BUILD_STAMP__') || !source.includes('__PRECACHE__')) {
      throw new Error('public/sw.js lost its __BUILD_STAMP__ or __PRECACHE__ placeholder');
    }
    // The shell is cached as `/`, never as `/index.html`: Cloudflare redirects every `/name.html` to `/name`, and a
    // cached redirect cannot answer a navigation (see `cloudflareHtmlHandlingPlugin`). Any other page (`404.html`, the
    // platform's own last resort) is the platform's business, not the worker's.
    const precache = listFiles(swOutDir)
      .filter((f) => !SW_NOT_PRECACHED.has(f) && !f.split('/').some((seg) => seg.startsWith('.')))
      .filter((f) => f === 'index.html' || !f.endsWith('.html'))
      .map((f) => (f === 'index.html' ? '/' : `/${f}`));
    writeFileSync(
      file,
      source
        .replace('__BUILD_STAMP__', () => `${BUILD_SHA}-${BUILD_TIME}`)
        .replace('__PRECACHE__', () => JSON.stringify(precache)),
    );
  },
};

/**
 * `vite preview` is what the e2e suite runs against, so where the platform answers differently from Vite and the app
 * depends on it, the preview answers the platform's way. Cloudflare's asset handling (`html_handling`, default
 * `auto-trailing-slash`) redirects `/name.html` to `/name` — `/index.html` to `/` — with a 307. The service worker once
 * precached `/index.html` and served that redirected response to every navigation, which a browser refuses: the
 * second visit to production failed to load at all, while every test here passed against a preview that never
 * redirected (CHANGELOG, 2.0.0-rc.2). A request for an `.html` file now gets the same redirect here.
 */
const cloudflareHtmlHandlingPlugin = {
  name: 'querylens-cloudflare-html-handling',
  configurePreviewServer(server: { middlewares: { use: (fn: (req: { url?: string }, res: { statusCode: number; setHeader: (k: string, v: string) => void; end: () => void }, next: () => void) => void) => void } }) {
    server.middlewares.use((req, res, next) => {
      const [path = '', query] = (req.url ?? '').split('?');
      if (!path.endsWith('.html')) return next();
      const target = path === '/index.html' ? '/' : path.slice(0, -'.html'.length);
      res.statusCode = 307;
      res.setHeader('Location', query ? `${target}?${query}` : target);
      res.end();
    });
  },
};

/**
 * A fenced code block can be wider than its column, and then it scrolls, and a box that scrolls has to be reachable
 * from the keyboard (WCAG 2.1.1; axe's `scrollable-region-focusable`) — a block of text has nothing focusable inside
 * it. This gives every `<pre>` of the docs a tab stop, at build time, so no page has to remember to.
 */
interface HastNode {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}
function rehypeFocusablePre() {
  const walk = (node: HastNode): void => {
    if (node.type === 'element' && node.tagName === 'pre') node.properties = { ...node.properties, tabIndex: 0 };
    for (const child of node.children ?? []) walk(child);
  };
  return (tree: HastNode) => { walk(tree); };
}

export default defineConfig({
  plugins: [
    cloudflareHtmlHandlingPlugin,
    // `rehype-slug` gives every rendered heading a stable `id` (kebab-cased
    // from its text), which is what lets a docs page's own `<Contents>` block
    // (src/ui/DocsComponents.tsx) link to `#section-name` and have the browser
    // actually land there — MDX/remark emit plain heading elements with no id
    // on their own.
    //
    // Every docs page is `.mdx`, deliberately, not `.md` — see the note on
    // `src/pages/DocsContent/`. Left at its default "detect" format, a `.md`
    // extension compiles as plain CommonMark with no JSX or `{expression}`
    // support, so every doc page's `import`ed component (`<Steps>`, `<Card>`,
    // `<DocMeta>`, `<Contents>`) would silently render as escaped text
    // instead of a component. Forcing `format: 'mdx'` for every file was the
    // first fix tried and it does turn JSX on — but it also breaks
    // `remark-frontmatter`'s recognition of the leading `---` block on a
    // `.md`-extensioned file specifically (a micromark/mdx interaction this
    // comment does not need to fully explain to route around). Naming every
    // file `.mdx` sidesteps the interaction entirely: format detection then
    // correctly and consistently picks 'mdx' for all of them.
    // `remark-gfm` adds the GitHub-flavoured syntax three reference pages
    // depend on — tables, mainly. Plain `remark-parse` treats a `| a | b |`
    // block as a literal paragraph of pipe characters, not a table; three
    // reference pages (SQL, shortcuts, URL parameters) had exactly that bug
    // since the docs migration, invisible until something rendered the raw
    // text rather than a table.
    { enforce: 'pre', ...mdx({
      remarkPlugins: [remarkFrontmatter, remarkMdxFrontmatter, remarkGfm],
      rehypePlugins: [rehypeSlug, rehypeFocusablePre],
    }) },
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
    serviceWorkerPlugin,
  ],
  build: {
    // `dist/.vite/manifest.json`: which chunks each lazy route pulls in. `scripts/bundle-budget.ts` walks it to
    // price a route by what a visitor to that route actually downloads (plan.md §25.4 H8).
    manifest: true,
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
        codeSplitting: {
          groups: [
            { name: 'codemirror', test: /node_modules\/(@codemirror|@lezer|style-mod|w3c-keyname)\// },
            { name: 'flow', test: /node_modules\/(flowinger|d3-)/ },
            { name: 'react', test: /node_modules\/(react|react-dom|scheduler)\// },
            // Panel PNG export (§20.3). `import()`ed on first use only, so this
            // gives it a stable chunk name rather than rolldown's generic `es-`.
            { name: 'html-to-image', test: /node_modules\/html-to-image\// },
            // The docs pages (plan.md §21.5 item 5) are `React.lazy` in
            // App.tsx, so they are already out of the entry chunk; this folds
            // their individual async chunks into one `docs-*.js` that loads on
            // the first `/docs` hit rather than nine round trips. Excludes the
            // two Concepts pages with a live embedded widget (§23.1's
            // interactive-docs item, `DocsBTreeDemo`/`DocsBufferPoolDemo`):
            // those pull in `BTreePanel`/`FlowTree`/`BufferPoolPanel` and the
            // engine's trace machinery, which forcing into this group merged
            // into every other docs page's download too (measured: `docs`
            // 15.5 → 49.8 kB) rather than the small shared chunk those two
            // panels already are for Playground/`/tools`. Left ungrouped, they
            // fall to rolldown's own default chunking and share that existing
            // chunk instead of duplicating its contents in here.
            {
              name: 'docs',
              test: /src[\\/]pages[\\/]DocsContent[\\/](?!concepts[\\/](btree|buffer-pool)\.mdx$)/,
            },
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
    // `src/`, the `bin/` CLI and `scripts/` (the study kit's researcher CLI,
    // plan.md §25.4 A2), `oracle/` (the SQLite differential + metamorphic
    // suites, §25.4 A1 — Node-only, since it drives `node:sqlite`), and
    // `mcp/` (the MCP server, §25.4 H4 — also Node-only: stdio, no DOM);
    // `e2e/` is Playwright's and Vitest cannot run it.
    include: [
      'src/**/*.{test,spec}.{ts,tsx}',
      'bin/**/*.{test,spec}.ts',
      'scripts/**/*.{test,spec}.ts',
      'oracle/**/*.{test,spec}.ts',
      'mcp/**/*.{test,spec}.ts',
    ],
  },
});
