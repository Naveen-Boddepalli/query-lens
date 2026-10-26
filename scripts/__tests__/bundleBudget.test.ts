import { describe, expect, it } from 'vitest';
import { closure, ENTRY_KEY, priceRoutes, resolveKey, ROUTES, unbudgeted } from '../bundle-budget.ts';
import type { Manifest, RouteBudget } from '../bundle-budget.ts';

/** A tiny app: an entry that needs React, two lazy pages that share a panel, and a hashed shared chunk. */
const MANIFEST: Manifest = {
  'index.html': { file: 'assets/index-a1.js', imports: ['_react-h1.js'], css: ['assets/index-a1.css'] },
  '_react-h1.js': { file: 'assets/react-h1.js' },
  '_panel-h2.js': { file: 'assets/panel-h2.js', imports: ['_react-h1.js', '_engine-h3.js'] },
  '_engine-h3.js': { file: 'assets/engine-h3.js' },
  '_docs-h4.js': { file: 'assets/docs-h4.js', imports: ['_react-h1.js'] },
  'src/pages/A.tsx': { file: 'assets/A-h5.js', imports: ['_panel-h2.js'] },
  'src/pages/B.tsx': { file: 'assets/B-h6.js', imports: ['_panel-h2.js', '_engine-h3.js'], css: ['assets/B-h6.css'] },
  'src/pages/C.tsx': { file: 'assets/C-h7.js' },
};

// Each file weighs its own length in "kB", so the arithmetic is checkable by eye.
const SIZE: Record<string, number> = {
  'assets/index-a1.js': 20, 'assets/index-a1.css': 10, 'assets/react-h1.js': 50, 'assets/panel-h2.js': 8,
  'assets/engine-h3.js': 30, 'assets/docs-h4.js': 5, 'assets/A-h5.js': 3, 'assets/B-h6.js': 4, 'assets/B-h6.css': 1, 'assets/C-h7.js': 2,
};
const size = (f: string): number => SIZE[f] ?? 0;

const route = (name: string, roots: string[], kb = 999): RouteBudget => ({ route: name, roots, kb, note: '' });

describe('resolveKey', () => {
  it('takes a source path exactly, and a shared chunk by its unhashed name', () => {
    expect(resolveKey(MANIFEST, 'src/pages/A.tsx')).toBe('src/pages/A.tsx');
    expect(resolveKey(MANIFEST, '_docs')).toBe('_docs-h4.js');
  });

  it('refuses a root that names nothing, or names two things', () => {
    expect(() => resolveKey(MANIFEST, 'src/pages/Nope.tsx')).toThrow(/no chunk/);
    expect(() => resolveKey({ ...MANIFEST, '_docs-zz.js': { file: 'assets/docs-zz.js' } }, '_docs')).toThrow(/several chunks/);
  });
});

describe('closure', () => {
  it('collects a chunk, its stylesheets and every static import, transitively and once', () => {
    expect([...closure(MANIFEST, ['src/pages/B.tsx'])].sort()).toEqual(
      ['assets/B-h6.css', 'assets/B-h6.js', 'assets/engine-h3.js', 'assets/panel-h2.js', 'assets/react-h1.js'].sort(),
    );
  });

  it('does not follow dynamic imports — a lazy route is priced on its own row, not into its parent', () => {
    const withDynamic: Manifest = { ...MANIFEST, 'index.html': { ...MANIFEST['index.html'], imports: ['_react-h1.js'] } };
    expect(closure(withDynamic, [ENTRY_KEY]).has('assets/A-h5.js')).toBe(false);
  });
});

describe('priceRoutes — what a visitor to the route downloads', () => {
  const rows = priceRoutes(MANIFEST, [route('/a', ['src/pages/A.tsx']), route('/b', ['src/pages/B.tsx']), route('/c', ['src/pages/C.tsx'])], size);
  const by = (r: string) => rows.find((x) => x.route === r)!;

  it('every route pays for the entry: shell, its stylesheet and React', () => {
    expect(by('/c').kb).toBe(20 + 10 + 50 + 2);
  });

  it('a file two things need is counted once', () => {
    // entry 80 + A 3 + panel 8 + engine 30 (through the panel)
    expect(by('/a').kb).toBe(80 + 3 + 8 + 30);
    // B needs panel and engine directly *and* engine through the panel — still once each; plus its stylesheet
    expect(by('/b').kb).toBe(80 + 4 + 1 + 8 + 30);
  });

  it('a route cannot borrow another route’s room: each is judged on its own download', () => {
    expect(by('/c').kb).toBeLessThan(by('/a').kb);
  });

  it('flags a route over its ceiling and only that route', () => {
    const tight = priceRoutes(MANIFEST, [route('/a', ['src/pages/A.tsx'], 100), route('/c', ['src/pages/C.tsx'], 100)], size);
    expect(tight.map((r) => [r.route, r.over])).toEqual([['/a', true], ['/c', false]]);
  });
});

describe('unbudgeted', () => {
  it('names a built file that no route and no opt-in reaches', () => {
    const rows = priceRoutes(MANIFEST, [route('/a', ['src/pages/A.tsx'])], size);
    const all = Object.values(MANIFEST).map((c) => c.file);
    expect(unbudgeted(all, rows, []).sort()).toEqual(['assets/B-h6.js', 'assets/C-h7.js', 'assets/docs-h4.js'].sort());
    expect(unbudgeted(all, rows, ['assets/docs-h4.js'])).not.toContain('assets/docs-h4.js');
  });
});

describe('the real route table', () => {
  it('lists each route once, with a ceiling and a reason', () => {
    const names = ROUTES.map((r) => r.route);
    expect(new Set(names).size).toBe(names.length);
    for (const r of ROUTES) {
      expect(r.kb, r.route).toBeGreaterThan(100); // every route pays the ~110 kB React + shell floor
      expect(r.kb, r.route).toBeLessThan(400);
      expect(r.note.length, r.route).toBeGreaterThan(5);
    }
  });

  it('gives every tool its own row (plan.md §25.2 Q8)', () => {
    for (const tool of ['buffer-pool', 'parser', 'btree', 'page', 'sort', 'planner', 'locks', 'grammar', 'hash-join']) {
      expect(ROUTES.some((r) => r.route === `/tools/${tool}`), tool).toBe(true);
    }
  });
});
