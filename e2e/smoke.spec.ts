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
