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

  it('configures long-term immutable caching for hashed assets and revalidation for HTML', () => {
    const content = readFileSync(headersPath, 'utf8');
    expect(content).toContain('/assets/*');
    expect(content).toMatch(/Cache-Control:\s*public,\s*max-age=31536000,\s*immutable/);
    expect(content).toContain('/*');
    expect(content).toMatch(/Cache-Control:\s*public,\s*max-age=0,\s*must-revalidate/);
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
