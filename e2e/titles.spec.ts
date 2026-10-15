import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { ROUTES } from './support/routes.ts';

/**
 * WCAG 2.4.2 (*Page Titled*): every route names its own browser tab. axe cannot see this one — `index.html` has a
 * `<title>`, so a page that never sets its own still passes the audit while every tab, history entry and bookmark
 * reads the same. Each page sets it in an effect (`src/ui/documentTitle.ts`), after it has rendered.
 */
const DEFAULT = /<title>(.*)<\/title>/.exec(readFileSync('index.html', 'utf8'))?.[1] ?? '';

test('every route names its own tab, and no two routes share a name', async ({ page }) => {
  test.setTimeout(180_000);
  expect(DEFAULT).not.toBe('');
  const owner = new Map<string, string>();
  for (const route of ROUTES) {
    await page.goto(route);
    // The document opens with index.html's title; the page replaces it once it has rendered — `/` keeps it.
    if (route === '/') await expect(page).toHaveTitle(DEFAULT);
    else await expect(page, route).not.toHaveTitle(DEFAULT);
    const title = await page.title();
    expect(title, route).toMatch(route === '/' ? /^QueryLens — / : / · QueryLens$/);
    expect(owner.get(title), `${route} is titled "${title}", like ${owner.get(title) ?? ''}`).toBeUndefined();
    owner.set(title, route);
  }
});

test('the title follows navigation inside the app, back and forward included', async ({ page }) => {
  await page.goto('/tools');
  await expect(page).toHaveTitle('Tools · QueryLens');
  await page.locator('a[href="/tools/recovery"]').first().click();
  await expect(page).toHaveTitle('Crash recovery · Tools · QueryLens');
  await page.goBack();
  await expect(page).toHaveTitle('Tools · QueryLens');
  await page.goForward();
  await expect(page).toHaveTitle('Crash recovery · Tools · QueryLens');

  // The docs share one layout; the sidebar's label names each page.
  await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Docs' }).click();
  await expect(page).toHaveTitle('Docs · QueryLens');
  await page.getByRole('navigation', { name: 'Docs navigation' }).getByRole('link', { name: 'FAQ' }).click();
  await expect(page).toHaveTitle('FAQ · Docs · QueryLens');

  // A lesson's "Next" link keeps the same page component and changes only what it shows.
  await page.goto('/learn/one-row');
  await expect(page).toHaveTitle(/ · Learn · QueryLens$/);
  const first = await page.title();
  await page.getByRole('link', { name: /^Next: / }).click();
  await expect(page).not.toHaveTitle(first);
  await expect(page).toHaveTitle(/ · Learn · QueryLens$/);

  // And back to the front door, which keeps index.html's own title.
  await page.getByRole('link', { name: 'QueryLens', exact: true }).first().click();
  await expect(page).toHaveTitle(DEFAULT);
});
