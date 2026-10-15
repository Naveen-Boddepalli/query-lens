import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Lessons and challenges for the transaction and durability tools: the two groups on the index pages, each lesson's
 * link landing in a tool that holds the script it names, and the script challenges — a text box, a run, a verdict.
 */

const LESSON_IDS = [
  'dirty-read',
  'isolation-levels',
  'snapshots',
  'protocols',
  'log-first',
  'steal-and-force',
  'recovery',
] as const;

const script = (page: Page) => page.getByLabel(/one step to a line/);

async function solve(page: Page, text: string) {
  await script(page).fill(text);
  await page.getByRole('button', { name: 'Run & check' }).click();
}

test('the learn track has a transactions and durability group, last', async ({ page }) => {
  await page.goto('/learn');
  await expect(page.getByRole('heading', { name: 'The query pipeline', level: 2 })).toBeVisible();
  const group = page.getByRole('heading', { name: 'Transactions and durability', level: 2 });
  await expect(group).toBeVisible();
  await expect(page.getByText(/^0 of \d+ complete$/)).toBeVisible();

  // Numbered on from the groups before it.
  const section = page.getByRole('region', { name: 'Transactions and durability' });
  await expect(section.getByRole('listitem')).toHaveCount(8);
  const first = await section.getByRole('listitem').first().innerText();
  expect(Number(/^\d+/.exec(first.trim())?.[0])).toBeGreaterThan(9);
  await section.getByRole('link', { name: /Let a dirty read happen/ }).click();
  await expect(page).toHaveURL(/\/learn\/dirty-read$/);
  await expect(page.getByText(/Lesson \d+ of \d+/)).toBeVisible();
});

for (const id of LESSON_IDS) {
  test(`lesson ${id}: every tool link opens a tool that runs, with no error`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`/learn/${id}`);
    const links = page.getByRole('link', { name: /→$/ });
    await expect(links.first()).toBeVisible();
    // The step links, not the "Next lesson" one at the foot of the page.
    const hrefs = (await links.evaluateAll((els) => els.map((el) => el.getAttribute('href') ?? ''))).filter(
      (h) => h.startsWith('/tools/') || h.startsWith('/playground'),
    );
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      await page.goto(href);
      await expect(page.locator('main, [role="main"], #root > *').first()).toBeVisible();
      await expect(page.getByRole('heading', { level: 2 }).first()).toBeVisible();
      // The error boundary's own words; a tool that fell over would say so.
      await expect(page.getByText(/hit a bug/)).toHaveCount(0);
    }
    expect(errors).toEqual([]);
  });
}

test('the dirty-read lesson’s link opens the schedule tool with its two sessions’ statements', async ({ page }) => {
  await page.goto('/learn/dirty-read');
  await page.getByRole('link', { name: /Open this schedule/ }).click();
  await expect(page).toHaveURL(/\/tools\/schedule\?/);
  await expect(page.getByRole('heading', { name: 'Transaction schedules' })).toBeVisible();
  await expect(page.getByText('UPDATE accounts SET balance = 0 WHERE id = 1').first()).toBeVisible();
  await expect(page.getByRole('radio', { name: 'No locking' })).toHaveAttribute('aria-checked', 'true');
});

test('the recovery lesson’s UPDATE opens the Playground, where Run makes the edit and Durability keeps it', async ({ page }) => {
  await page.goto('/learn/recovery');
  await page.getByRole('link', { name: /Open the UPDATE in the Playground/ }).click();
  await expect(page).toHaveURL(/\/playground\?/);
  // Opened at the end of the trace; the write is made, and logged, when Run is pressed.
  await expect(page.getByRole('button', { name: 'Durability', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Run/ }).click();
  await expect(page.getByRole('button', { name: /^Durability \(1\)$/ })).toBeVisible();
});

test('the challenge index has the two groups and a count over all of them', async ({ page }) => {
  await page.goto('/challenges');
  await expect(page.getByText(/^0 of \d+ solved$/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Queries', level: 2 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Transactions and durability', level: 2 })).toBeVisible();
  const section = page.getByRole('region', { name: 'Transactions and durability' });
  await expect(section.getByRole('listitem')).toHaveCount(16);
  await section.getByRole('link', { name: /Read a value that never existed/ }).click();
  await expect(page).toHaveURL(/\/challenges\/read-the-unreal$/);
  // Twenty-one query challenges come first, then two lock scripts, so this one is the twenty-fourth.
  await expect(page.getByText(/24 of \d+/)).toBeVisible();
});

test('a schedule challenge runs a script, says what each step did, and remembers the solve', async ({ page }) => {
  await page.goto('/challenges/read-the-unreal');
  await expect(page.getByText(/No concurrency control at all\./).first()).toBeVisible();

  // The starter commits before B reads: nothing dirty.
  await page.getByRole('button', { name: 'Run & check' }).click();
  await expect(page.getByText(/Not there yet/)).toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByText('anomalies flagged')).toBeVisible();

  await page.getByRole('button', { name: 'Show hint' }).click();
  await expect(page.getByText(/ROLLBACK comes after B/)).toBeVisible();

  await solve(
    page,
    [
      'A: BEGIN',
      'A: UPDATE accounts SET balance = 0 WHERE id = 1',
      'B: SELECT balance FROM accounts WHERE id = 1',
      'A: ROLLBACK',
    ].join('\n'),
  );
  await expect(page.getByText('✓ Solved.')).toBeVisible();
  await expect(page.getByRole('table').getByText('dirty-read')).toBeVisible();
  await expect(page.getByText(/The belief this checks/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Open this run in its tool/ })).toHaveAttribute('href', /\/tools\/schedule\?/);

  // The result, as it stands, passes axe.
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

  // Next goes on to the following challenge, and the index remembers.
  await page.getByRole('link', { name: /Next: Make a statement wait/ }).click();
  await expect(page).toHaveURL(/\/challenges\/make-it-wait$/);
  await page.goto('/challenges');
  await expect(page.getByText(/^1 of \d+ solved$/)).toBeVisible();
  await page.getByRole('button', { name: 'Reset progress' }).click();
  await expect(page.getByText(/^0 of \d+ solved$/)).toBeVisible();
});

test('a script that is not a script says which line, and runs nothing', async ({ page }) => {
  await page.goto('/challenges/make-it-wait');
  await solve(page, 'A: BEGIN\nUPDATE accounts SET balance = 1');
  await expect(page.getByRole('alert')).toContainText('Line 2: begin each step with A: or B:');
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(page.getByText('✓ Solved.')).toHaveCount(0);
});

test('Ctrl/Cmd+Enter in the script box runs it', async ({ page }) => {
  await page.goto('/challenges/pick-the-victim');
  await script(page).click();
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByText(/Not there yet/)).toBeVisible();
  await expect(page.getByText('deadlocks')).toBeVisible();
});

test('a log challenge shows the passes of the recovery it ran and links to the recovery tool', async ({ page }) => {
  await page.goto('/challenges/redo-a-commit');
  await expect(page.getByText(/Pages 1–4 hold the cells/)).toBeVisible();

  // The starter has no crash: nothing to recover.
  await page.getByRole('button', { name: 'Run & check' }).click();
  await expect(page.getByText(/Not there yet/)).toBeVisible();

  await solve(page, 'begin T1\nset T1 a = 99\ncommit T1\ncrash\nrecover');
  await expect(page.getByText('✓ Solved.')).toBeVisible();
  await expect(page.getByRole('table', { name: /The passes of the recovery/ })).toBeVisible();
  await expect(page.getByRole('table', { name: /What each step did/ })).toBeVisible();

  const open = page.getByRole('link', { name: /Open this run in its tool/ });
  await expect(open).toHaveAttribute('href', /\/tools\/recovery\?/);
  await open.click();
  await expect(page.getByRole('heading', { name: 'Crash recovery' })).toBeVisible();
});

test('a log challenge refuses a line that is not one of the log tool’s steps, naming it', async ({ page }) => {
  await page.goto('/challenges/undo-a-steal');
  await solve(page, 'begin T1\nfrobnicate');
  await expect(page.getByRole('alert')).toContainText('Line 2: “frobnicate” is not a step');
});

test('the protocol challenge shows the same schedule under all five protocols', async ({ page }) => {
  await page.goto('/challenges/aborted-by-the-clock');
  await page.getByRole('button', { name: 'Run & check' }).click();
  const table = page.getByRole('table', { name: /The same schedule under each protocol/ });
  await expect(table).toBeVisible();
  await expect(table.getByRole('row')).toHaveCount(6);
  await expect(table.getByRole('cell', { name: 'Timestamp ordering' })).toBeVisible();

  await solve(
    page,
    [
      'A: BEGIN',
      'A: SELECT balance FROM accounts WHERE id = 1',
      'B: UPDATE accounts SET balance = 150 WHERE id = 1',
      'A: UPDATE accounts SET balance = 120 WHERE id = 1',
      'A: COMMIT',
    ].join('\n'),
  );
  await expect(page.getByText('✓ Solved.')).toBeVisible();
});
