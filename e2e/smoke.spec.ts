import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

/**
 * plan.md §14.2's smoke test: load → run → step to the end → assert the rows.
 *
 * Deliberately one path through the whole thing rather than many shallow
 * checks. If this passes, the bundle loaded, the engine ran, the panels
 * rendered and playback works — which is the entire question "is the deploy
 * broken" reduces to.
 */

const POINT_LOOKUP = 'SELECT *\nFROM users\nWHERE id = 5;';

test('loads, runs the default trace, and steps to a result', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto('/');

  // plan.md §15.1 item 1: a visitor who touches nothing sees a real trace.
  await expect(page.getByText(/steps in this trace/)).toBeVisible();
  await expect(page.getByText(/showing step/)).toContainText('1');

  // Prediction gates playback on purpose, and this test is about the pipeline.
  await page.getByLabel('Ask me to predict before each reveal').uncheck();

  await page.getByRole('button', { name: /^Run/ }).click();
  await page.getByRole('button', { name: 'Step forward' }).click();
  await expect(page.getByText(/showing step/)).toContainText('2');

  // Straight to the end, which is where the result rows are.
  const scrubber = page.getByLabel('Scrub to step');
  await scrubber.press('End');

  await expect(page.getByRole('button', { name: 'Step forward' })).toBeDisabled();
  // The point lookup returns exactly the one row it asked for. By cell, not by
  // text: 'carmack' also appears inside carmack@example.com in the next column.
  await expect(page.getByRole('cell', { name: 'carmack', exact: true })).toBeVisible();
  await expect(page.getByText(/1 row returned/)).toBeVisible();

  expect(errors, 'the built page logged errors').toEqual([]);
});

test('a shared link reproduces the moment it points at', async ({ page }) => {
  // plan.md §15.2. §9's study needs every participant to start identically and
  // §13's course packaging wants "predict what happens at step 13" to be a link.
  await page.goto(`/?q=${encodeURIComponent(POINT_LOOKUP)}&p=clock&x=0&s=13`);

  await expect(page.getByText(/showing step/)).toContainText('13');
  await expect(page.getByLabel('Eviction')).toHaveValue('clock');
  await expect(page.getByLabel('Ask me to predict before each reveal')).not.toBeChecked();
});

test('the data editor is a real modal', async ({ page }) => {
  // plan.md §15.1 item 3. jsdom implements none of the dialog methods, so the
  // browser is the only place the top layer and Escape can actually be checked.
  await page.goto('/');
  await page.getByRole('button', { name: /^Edit data/ }).click();

  const dialog = page.locator('dialog');
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((el: HTMLDialogElement) => el.matches(':modal'))).toBe(true);
  expect(await dialog.evaluate((el) => el.contains(document.activeElement))).toBe(true);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // Unmounted, not merely hidden — and therefore reopenable. The component
  // only calls showModal() on mount, so a dialog left mounted-but-closed would
  // make "Edit data" silently dead for the rest of the session. `toBeHidden`
  // alone would not catch that: a closed <dialog> is display:none either way.
  await expect(page.locator('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: /^Edit data/ }).click();
  await expect(page.locator('dialog')).toBeVisible();

  // And focus comes back to the trigger rather than being stranded inside a
  // hidden subtree.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /^Edit data/ })).toBeFocused();
});

test('the theme toggle switches, persists, and survives a reload', async ({ page }) => {
  // plan.md §15.3. Three states, because a two-state switch has to silently
  // stop following the system the moment it decides what it means on load.
  await page.goto('/');
  const root = page.locator('html');

  await page.getByRole('radio', { name: 'Light' }).click();
  await expect(root).toHaveAttribute('data-theme', 'light');

  // The stuck-colour bug this guards against: Chrome settles a transitioned
  // colour on the value its custom property held when the transition started,
  // so every `transition-colors` element kept the *previous* palette. Reading
  // a real element's colour is the only way to catch it — the token is right
  // either way. See src/ui/theme.ts.
  const runColour = () =>
    page.getByRole('button', { name: /^Run/ }).evaluate((el) => getComputedStyle(el).color);
  const lightRun = await runColour();

  await page.getByRole('radio', { name: 'Dark' }).click();
  await expect(root).toHaveAttribute('data-theme', 'dark');
  const darkRun = await runColour();
  expect(darkRun).not.toBe(lightRun);

  await page.getByRole('radio', { name: 'Light' }).click();
  expect(await runColour()).toBe(lightRun);

  // Persisted, and resolved before first paint by public/theme.js.
  await page.reload();
  await expect(root).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');

  // "System" is a real third state: it forgets the choice rather than storing one.
  await page.getByRole('radio', { name: 'System' }).click();
  expect(await page.evaluate(() => localStorage.getItem('querylens:theme'))).toBeNull();
});

test('has no detectable WCAG A/AA violations on the default view', async ({ page }) => {
  // plan.md §8: a regression net, explicitly *not* a compliance claim —
  // automated tooling catches 30–57% of WCAG failures, so the manual
  // composited-contrast sweep stays the real check (§15.3).
  await page.goto('/');
  await expect(page.getByText(/steps in this trace/)).toBeVisible();

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.length} node(s) — ${v.help}`),
  ).toEqual([]);
});

test('has no detectable WCAG A/AA violations in the light theme either', async ({ page }) => {
  // A second palette is a second chance to fail contrast, and the light one is
  // the newer of the two. Taken at the end of the trace on purpose: that is
  // where every pipeline chip is in its *visited* state and painting its own
  // stage colour, which is exactly where three of them failed when measured.
  await page.goto('/?q=SELECT%20*%20FROM%20users%20WHERE%20id%20%3D%205%3B&p=lru&x=0&s=33');
  await page.getByRole('radio', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByText(/showing step/)).toContainText('33');

  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  expect(
    results.violations.map((v) => `${v.id}: ${v.nodes.length} node(s) — ${v.help}`),
  ).toEqual([]);
});

test('the header Docs link opens a real page, not a 404', async ({ page }) => {
  // The docs site (plan.md §17.1) is a separate Astro package built into
  // dist/docs by a separate CI step — nothing here proves at build time that
  // the two halves of the deploy actually agree on the URL between them, only
  // that each builds on its own. This is that proof: click the link the app
  // itself renders, and land on a real Starlight page rather than the app's
  // own 404.html.
  // Both the header and the footer link to /docs/ now, hence the scope: the
  // point of this test is that the URL and the docs build agree, and either
  // link proves that equally well.
  await page.goto('/');
  await page.getByRole('banner').getByRole('link', { name: 'Docs' }).click();
  await expect(page).toHaveURL(/\/docs\/$/);
  await expect(page.getByRole('heading', { name: 'What QueryLens is' })).toBeVisible();
});
