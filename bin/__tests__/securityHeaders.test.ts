import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('Security headers and static distribution assets (plan.md §14.1, §14.3)', () => {
  const root = resolve(import.meta.dirname, '../..');
  const headersPath = resolve(root, 'public/_headers');

  it('public/_headers exists and is readable', () => {
    expect(existsSync(headersPath)).toBe(true);
  });

  it('declares the tested Content-Security-Policy with required directives', () => {
    const content = readFileSync(headersPath, 'utf8');
    const cspMatch = content.match(/Content-Security-Policy:\s*([^\r\n]+)/);
    expect(cspMatch).not.toBeNull();
    const csp = cspMatch![1];

    // default-src 'none' blocks unlisted categories
    expect(csp).toContain("default-src 'none'");
    // Zero inline scripts emitted by build
    expect(csp).toContain("script-src 'self'");
    // CodeMirror style-mod uses runtime <style> insertion (§14.3)
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    // Icons, SVGs, and data URIs
    expect(csp).toContain("img-src 'self' data:");
    // Local fonts only, no Google Fonts CDN leaks
    expect(csp).toContain("font-src 'self'");
    // Same-origin only, no third-party telemetry / beacons (§14.4)
    expect(csp).toContain("connect-src 'self'");
    // Defend against base-tag hijacking and form action hijacking
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    // frame-ancestors 'none' supersedes X-Frame-Options against clickjacking
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('enforces modern transport security and origin isolation headers', () => {
    const content = readFileSync(headersPath, 'utf8');

    // HSTS (2 years, subdomains, preload)
    expect(content).toMatch(/Strict-Transport-Security:\s*max-age=\d+;\s*includeSubDomains;\s*preload/);
    // Camera, microphone, and geolocation locked down
    expect(content).toMatch(/Permissions-Policy:\s*geolocation=\(\),\s*microphone=\(\),\s*camera=\(\)/);
    // COOP prevents cross-origin window reference leaks
    expect(content).toMatch(/Cross-Origin-Opener-Policy:\s*same-origin/);
    // MIME-sniffing prevention
    expect(content).toMatch(/X-Content-Type-Options:\s*nosniff/);
    // Referrer policy
    expect(content).toMatch(/Referrer-Policy:\s*strict-origin-when-cross-origin/);
  });

  /**
   * What Cloudflare sends for a path, worked out the way its asset worker does (workers-sdk,
   * `packages/workers-shared/asset-worker/src/utils/headers.ts`): its default `Cache-Control` first, then every
   * matching rule in turn — a rule's `! Name` lines delete, and its first value for a header replaces whatever is
   * there, while a value a later rule sets for the same header is joined on with a comma. Checking the file's text,
   * as this test once did, passed while both rules set `Cache-Control` and every hashed asset was sent both values.
   */
  const served = (path: string, order: 'file' | 'reversed' = 'file') => {
    const rules: { pattern: RegExp; set: [string, string][]; unset: string[] }[] = [];
    for (const line of readFileSync(headersPath, 'utf8').split(/\r?\n/)) {
      if (line.trim() === '' || line.trim().startsWith('#')) continue;
      if (!/^\s/.test(line)) {
        const source = line.trim().split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
        rules.push({ pattern: new RegExp(`^${source}$`), set: [], unset: [] });
        continue;
      }
      const rule = rules.at(-1)!;
      const body = line.trim();
      if (body.startsWith('! ')) rule.unset.push(body.slice(2).trim().toLowerCase());
      else {
        const colon = body.indexOf(':');
        rule.set.push([body.slice(0, colon).trim().toLowerCase(), body.slice(colon + 1).trim()]);
      }
    }
    const headers = new Map([['cache-control', 'public, max-age=0, must-revalidate']]);
    const setByRule = new Set<string>();
    const matching = rules.filter((rule) => rule.pattern.test(path));
    for (const rule of order === 'file' ? matching : matching.reverse()) {
      for (const name of rule.unset) headers.delete(name);
      for (const [name, value] of rule.set) {
        headers.set(name, setByRule.has(name) ? `${headers.get(name) ?? ''}, ${value}` : value);
        setByRule.add(name);
      }
    }
    return headers;
  };

  it.each(['file', 'reversed'] as const)(
    'hashed assets get one year-long Cache-Control, and everything else revalidates (rules in %s order)',
    (order) => {
      for (const asset of ['/assets/index-DOkIOFjv.js', '/assets/flow-DT8EqD97.js', '/assets/index-a1b2c3d4.css']) {
        expect(served(asset, order).get('cache-control'), asset).toBe('public, max-age=31536000, immutable');
      }
      for (const document of ['/', '/index.html', '/playground', '/learn/nulls', '/sw.js', '/manifest.webmanifest']) {
        expect(served(document, order).get('cache-control'), document).toBe('public, max-age=0, must-revalidate');
      }
    },
  );

  it('every path, assets included, gets the security headers as `/*` declares them, never joined', () => {
    const declared = served('/'); // only `/*` matches `/`
    expect(declared.get('content-security-policy')).toContain("frame-ancestors 'none'");
    for (const path of ['/playground', '/sw.js', '/assets/index-DOkIOFjv.js']) {
      for (const name of ['content-security-policy', 'strict-transport-security', 'x-content-type-options']) {
        expect(served(path).get(name), `${path} ${name}`).toBe(declared.get(name));
      }
    }
  });

  it('required public static assets exist', () => {
    const publicDir = resolve(root, 'public');
    expect(existsSync(resolve(publicDir, '404.html'))).toBe(true);
    expect(existsSync(resolve(publicDir, 'og.png'))).toBe(true);
    expect(existsSync(resolve(publicDir, 'robots.txt'))).toBe(true);
    expect(existsSync(resolve(publicDir, 'favicon.svg'))).toBe(true);
  });

  it('index.html contains metadata for Open Graph, viewport, and icons', () => {
    const indexPath = resolve(root, 'index.html');
    const indexHtml = readFileSync(indexPath, 'utf8');
    expect(indexHtml).toMatch(/<meta\s+name="viewport"/);
    expect(indexHtml).toMatch(/<meta\s+name="description"/);
    expect(indexHtml).toContain('property="og:title"');
    expect(indexHtml).toContain('property="og:image"');
    expect(indexHtml).toContain('name="twitter:card"');
  });
});
