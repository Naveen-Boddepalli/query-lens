import { expect, test } from '@playwright/test';

/**
 * Regressions, each one written after the behaviour was observed rather than
 * imagined. Two came from a bug report — "the graph is not updating when I
 * step" and "results extend the page instead of scrolling" — and the rest from
 * sweeping the same paths afterwards.
 */

const LOOKUP = 'SELECT%20*%20FROM%20users%20WHERE%20id%20%3D%205%3B';
const SCAN = 'SELECT%20*%20FROM%20users%20WHERE%20age%20%3E%2025%3B';

test('the panel follows every step of the trace', async ({ page }) => {
  // Reported as "the graph is not updating". The panel really does track the
  // trace; what stops it is a *pinned* stage, covered by the next test.
  await page.goto(`/?q=${LOOKUP}&p=lru&x=0&s=1`);
  const problems: string[] = [];
  for (let i = 1; i <= 33; i++) {
    await page.getByLabel('Scrub to step').fill(String(i));
    const panel = (await page.locator('section h2').first().innerText()).trim();
    const chip = await page.locator('nav button[aria-current="step"]').innerText().catch(() => '(none)');
    if (panel !== chip.trim()) problems.push(`step ${i}: panel ${panel} vs current chip ${chip.trim()}`);
  }
  expect(problems).toEqual([]);
});

test('a pinned stage holds the panel, says so, and releases in one click', async ({ page }) => {
  // Clicking a chip holds the panel there while the trace runs on — which is
  // the point, and which read as a bug because nothing said it was happening
  // and nothing obvious undid it.
  await page.goto(`/?q=${LOOKUP}&p=lru&x=0&s=4`);
  const follow = page.getByRole('button', { name: /follow the trace/ });

  await page.getByRole('button', { name: 'Parser', exact: true }).click();
  // Nothing to announce while the trace is on the pinned stage anyway.
  await expect(follow).toHaveCount(0);

  await page.getByLabel('Scrub to step').fill('14');
  await expect(page.locator('section h2').first()).toHaveText('Parser');
  await expect(follow).toBeVisible();

  await follow.click();
  await expect(follow).toHaveCount(0);
  await expect(page.locator('section h2').first()).toHaveText('Index');

  // And it keeps following from there.
  await page.getByLabel('Scrub to step').fill('20');
  await expect(page.locator('section h2').first()).toHaveText('Locks');
});

test('no page overflow at any step, desktop or mobile', async ({ page }) => {
  // Reported as results "extending the page" instead of scrolling in place.
  // The horizontal half was found here: a long email column made the phone
  // scroll sideways, because grid and flex children default to
  // `min-width: auto` and refuse to shrink below their content.
  const problems: string[] = [];
  for (const [name, size] of [['desktop', { width: 1360, height: 900 }], ['mobile', { width: 375, height: 812 }]] as const) {
    await page.setViewportSize(size);
    for (const url of [`/?q=${LOOKUP}&p=lru&x=0&s=33`, `/?q=${SCAN}&p=clock&x=0&s=9999`]) {
      await page.goto(url);
      await page.waitForTimeout(400);
      const m = await page.evaluate(() => ({
        x: document.documentElement.scrollWidth > innerWidth + 1,
        y: document.documentElement.scrollHeight > innerHeight + 2,
      }));
      if (m.x) problems.push(`${name} ${url}: horizontal overflow`);
      // Only the desktop shell is fixed-height; the phone is meant to scroll.
      if (name === 'desktop' && m.y) problems.push(`${name} ${url}: page grew past the viewport`);
    }
  }
  expect(problems).toEqual([]);
});

test('a long result scrolls inside its panel', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto(`/?q=${SCAN}&p=lru&x=0&s=9999`);
  await page.waitForTimeout(500);
  const m = await page.evaluate(() => {
    const box = document.querySelector('.min-h-80');
    const scroller = box?.querySelector('.overflow-auto');
    return {
      scrolls: scroller ? scroller.scrollHeight > scroller.clientHeight : false,
      controlsOnScreen: document.querySelector('.scrubber')!.getBoundingClientRect().bottom <= innerHeight + 1,
    };
  });
  expect(m).toEqual({ scrolls: true, controlsOnScreen: true });
});

test('prediction gates advancement and answering releases it', async ({ page }) => {
  await page.goto(`/?q=${LOOKUP}&p=lru&x=1&s=8`);
  const forward = page.getByRole('button', { name: 'Step forward' });
  await expect(forward).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Play' })).toBeDisabled();

  await page.getByRole('button', { name: /index lookup/i }).click();
  await expect(forward).toBeEnabled();
  await forward.click();
  await expect(page.getByText(/showing step/)).toContainText('9');
});

test('stepping does not pollute browser history', async ({ page }) => {
  await page.goto('/');
  await page.goto(`/?q=${LOOKUP}&p=lru&x=0&s=1`);
  for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Step forward' }).click();
  await page.waitForTimeout(500);
  // replaceState, not pushState: one Back should leave the app entirely.
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});

test('editing seed data re-runs the trace', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Edit data/ }).click();
  await page.getByLabel('age row 1', { exact: true }).fill('999');
  await page.getByRole('button', { name: /Apply/ }).click();
  await expect(page.locator('dialog')).toHaveCount(0);
  await expect(page.getByText(/steps in this trace/)).toBeVisible();
  // The edited rows travel in the link, so a refresh keeps them. The URL write
  // is debounced (it also fires on every keystroke), hence the wait.
  await expect.poll(() => page.url(), { timeout: 3000 }).toContain('d=');
  await page.reload();
  await expect(page.getByLabel('Scrub to step')).toBeVisible();
  await page.getByRole('button', { name: /^Edit data/ }).click();
  await expect(page.getByLabel('age row 1', { exact: true })).toHaveValue('999');
});

test('logs nothing to the console across a full playthrough', async ({ page }) => {
  const noise: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') noise.push(`${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => noise.push(`pageerror: ${e.message}`));

  await page.goto(`/?q=${LOOKUP}&p=lru&x=0&s=1`);
  for (const stage of ['Parser', 'Planner', 'Optimizer', 'Execution', 'Buffer Pool', 'Index', 'Locks', 'Result']) {
    await page.getByRole('button', { name: stage, exact: true }).click();
    await page.waitForTimeout(60);
  }
  await page.getByRole('radio', { name: 'Light' }).click();
  await page.getByLabel('Scrub to step').fill('33');
  await page.getByRole('radio', { name: 'System' }).click();
  await page.waitForTimeout(400);
  expect(noise).toEqual([]);
});
