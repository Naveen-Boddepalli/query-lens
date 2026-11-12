import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * plan.md §H1. These run against `pnpm preview`, which serves the built output and does not apply
 * `public/_headers`. The worker only registers in production builds, so this is the environment it
 * has to work in.
 */

async function waitForWorker(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  // A page is only controlled once it loads after the worker activated, so one reload is needed.
  if (!(await page.evaluate(() => navigator.serviceWorker.controller !== null))) {
    await page.reload();
  }
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}

test('the app registers a service worker and links a web manifest with install icons', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');

  const manifest = (await (await request.get('/manifest.webmanifest')).json()) as {
    icons: { src: string; sizes: string }[];
  };
  for (const size of ['192x192', '512x512']) {
    const icon = manifest.icons.find((i) => i.sizes === size);
    expect(icon, `manifest names a ${size} icon`).toBeDefined();
    expect((await request.get(icon!.src)).ok(), `${icon!.src} is served`).toBe(true);
  }

  await waitForWorker(page);
  expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toMatch(/\/sw\.js$/);
});

test('the worker precaches the shell as / and no .html path the platform would redirect', async ({ request }) => {
  // Cloudflare answers `/index.html` (and any `/name.html`) with a 307; a cached redirect cannot answer a navigation,
  // and the preview now redirects the same way, so the reload in the tests below fails if this slips back.
  const source = await (await request.get('/sw.js')).text();
  const list = JSON.parse(/const PRECACHE = (\[.*?\]);/s.exec(source)?.[1] ?? '[]') as string[];
  expect(list).toContain('/');
  expect(list.filter((path) => path.endsWith('.html'))).toEqual([]);
  expect((await request.get('/index.html', { maxRedirects: 0 })).status()).toBe(307);
});

test('the production Content-Security-Policy admits the service worker and the manifest', async ({ page }) => {
  // `pnpm preview` ignores _headers, so the policy is taken from the file and applied to each document here.
  const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
  const csp = headers
    .split('\n')
    .find((line) => line.trim().startsWith('Content-Security-Policy:'))
    ?.trim()
    .slice('Content-Security-Policy:'.length)
    .trim();
  expect(csp, 'public/_headers declares a Content-Security-Policy').toBeTruthy();

  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': csp! } });
  });

  const violations: string[] = [];
  await page.exposeFunction('reportViolation', (text: string) => {
    violations.push(text);
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      void (window as unknown as { reportViolation(text: string): Promise<void> }).reportViolation(
        `${event.violatedDirective} ${event.blockedURI}`,
      );
    });
  });

  // Only this first load is served through the route. Once the worker controls the page, a reload comes from
  // its cache and no longer passes through here, so the manifest is checked before the worker is waited for.
  await page.goto('/');
  // Chromium does not fetch the manifest on a plain page load, so ask it for the manifest directly. Under a
  // policy that refuses it, the browser returns no URL and no data.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Page.enable');
  const manifest = (await cdp.send('Page.getAppManifest')) as { url: string; data?: string; errors: unknown[] };
  expect(manifest.url, 'the browser fetched the manifest under the policy').toMatch(/\/manifest\.webmanifest$/);
  expect(manifest.errors).toEqual([]);

  await waitForWorker(page);
  expect(violations).toEqual([]);
});

test('a visited app opens with the network off, including a route it has not opened this session', async ({ page, context }) => {
  await page.goto('/playground');
  await expect(page.getByText(/steps in this trace/)).toBeVisible();
  await waitForWorker(page);

  await context.setOffline(true);
  try {
    await page.goto('/playground?q=SELECT+*+FROM+users+WHERE+id+%3D+5');
    await expect(page.getByText(/steps in this trace/)).toBeVisible();

    await page.goto('/tools/parser');
    await expect(page.getByText(/Parser sandbox/)).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});

test('navigations hit the network when online so new deploys are not hidden behind a stale cached shell', async ({
  page,
  context,
}) => {
  await page.goto('/');
  await waitForWorker(page);

  let shellRequests = 0;
  await context.route('**/*', async (route) => {
    const req = route.request();
    const { pathname } = new URL(req.url());
    if (pathname === '/') {
      shellRequests += 1;
    }
    await route.continue();
  });

  await page.goto('/');
  expect(shellRequests).toBeGreaterThan(0);
});
