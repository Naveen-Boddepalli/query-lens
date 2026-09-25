import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * plan.md §25.4 A2 — the §9 study kit, in a real browser against `dist/`.
 *
 * Packs are built here with Node's own `zlib`, not with the app's codec: that
 * makes every test below also a cross-check that the wire format is plain raw
 * deflate + base64url — what a browser's `DecompressionStream` reads and what
 * `pnpm study` writes — rather than something two copies of one function agree on.
 */

const b64 = (value: unknown): string => deflateRawSync(Buffer.from(JSON.stringify(value))).toString('base64url');
const fromB64 = (code: string): Record<string, unknown> =>
  JSON.parse(inflateRawSync(Buffer.from(code, 'base64url')).toString()) as Record<string, unknown>;

interface PackOverrides { arm?: 'app' | 'text'; materialSeconds?: number; testSeconds?: number; tasks?: { label: string; href: string }[] }

function pack(o: PackOverrides = {}) {
  const arm = o.arm ?? 'text';
  return {
    v: 1,
    study: 'e2e-study',
    pid: 'P07',
    arm,
    consent: ['You may stop at any time by closing this tab.', 'Nothing is sent anywhere by this page.'],
    material: {
      seconds: o.materialSeconds ?? 5,
      title: arm === 'text' ? 'Read this carefully' : 'Learn with QueryLens',
      intro: 'A fixed amount of time.',
      body: arm === 'text' ? '### The reading heading\n\nA paragraph about **frames** and `pages`.' : '',
      tasks: arm === 'app' ? (o.tasks ?? [{ label: 'Lesson: Watch a page get evicted', href: '/learn/eviction' }]) : [],
    },
    test: {
      seconds: o.testSeconds ?? 60,
      questions: [
        { id: 'q1', title: 'First question', text: 'What does `LRU` evict?' },
        { id: 'q2', title: 'Second question', text: 'Why does it *matter*?' },
      ],
    },
  };
}

const open = (page: Page, p: unknown) => page.goto(`/study#p=${b64(p)}`);

async function axeClean(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((v) => `${v.id}: ${String(v.nodes.length)} node(s) — ${v.help}`)).toEqual([]);
}

async function throughConsent(page: Page) {
  const begin = page.getByRole('button', { name: 'Begin' });
  await expect(begin).toBeDisabled();
  await page.getByRole('checkbox', { name: /I have read this/ }).check();
  await expect(begin).toBeEnabled();
  await begin.click();
}

// Start each test from a clean browser — once per tab. An init script runs on
// *every* navigation, including `reload()`, so it must not clear the very
// session a test is trying to resume.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      if (sessionStorage.getItem('e2e-fresh') === null) {
        localStorage.removeItem('querylens:study');
        sessionStorage.setItem('e2e-fresh', '1');
      }
    } catch { /* storage blocked: nothing to clear */ }
  });
});

test('a bare /study is inert — no instrument, no way in — and is kept out of search', async ({ page }) => {
  await page.goto('/study');
  await expect(page.getByRole('heading', { name: 'Nothing to do here' })).toBeVisible();
  await expect(page.getByText(/question/i)).toHaveCount(0);
  await expect(page.locator('meta[name="robots"][content="noindex"]')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Back to QueryLens' })).toBeVisible();
  await axeClean(page);
});

test('the shipped bundle contains none of the study instrument', () => {
  const md = readFileSync('STUDY.md', 'utf-8');
  // Distinctive to the *study* — not to the app's own lessons, which teach the same mechanisms.
  const phrases = [
    'How a database decides what to keep in memory',
    'Why a B+Tree needs two different splitting rules',
    'Misapplying the split rule',
    'Why LRU and clock sweep can disagree',
    'A `users` table is stored across 12 disk pages',
    'Someone builds a B+Tree where',
  ];
  for (const phrase of phrases) expect(md, `STUDY.md no longer says "${phrase}" — update this list`).toContain(phrase);

  const dir = join(process.cwd(), 'dist', 'assets');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js') || f.endsWith('.css'))) {
    const text = readFileSync(join(dir, file), 'utf-8');
    for (const phrase of phrases) expect(text, `${file} contains study text: "${phrase}"`).not.toContain(phrase);
  }
});

test('a text-arm participant runs the whole protocol, and can resume mid-test', async ({ page }) => {
  await open(page, pack());

  // Consent first; nothing else is reachable.
  await expect(page.getByRole('heading', { name: 'Before you begin' })).toBeVisible();
  await expect(page.getByText('Nothing is sent anywhere by this page.')).toBeVisible();
  await axeClean(page);
  await throughConsent(page);

  // A kiosk: no nav, no footer, no disclaimer bar — nothing to wander off to mid-study.
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Docs' })).toHaveCount(0);
  await expect(page.getByRole('contentinfo')).toHaveCount(0);

  // The material, rendered from the pack: a heading, bold and code as real elements.
  await expect(page.getByRole('heading', { name: 'Read this carefully' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The reading heading' })).toBeVisible();
  await expect(page.locator('strong', { hasText: 'frames' })).toBeVisible();
  await expect(page.locator('code', { hasText: 'pages' })).toBeVisible();
  const cont = page.getByRole('button', { name: 'Continue to the questions' });
  await expect(cont).toBeDisabled();
  await axeClean(page);

  // Everyone gets the fixed time; the button opens when it is up.
  await expect(cont).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByRole('status')).toContainText('Time is up');
  await cont.click();

  // The test: the reading is gone and cannot be revisited.
  await expect(page.getByRole('heading', { name: 'Questions' })).toBeVisible();
  await expect(page.getByText('A paragraph about')).toHaveCount(0);
  await expect(page.getByRole('timer', { name: 'Time left' })).toBeVisible();
  const q1 = page.getByRole('textbox', { name: /First question/ });
  await q1.fill('the least recently used page');
  await axeClean(page);

  // A reload mid-test resumes rather than restarts: same phase, answer kept.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Questions' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /First question/ })).toHaveValue('the least recently used page');
  await page.getByRole('textbox', { name: /Second question/ }).fill('it avoids a disk read');

  await page.getByRole('button', { name: 'Finish' }).click();

  // The result code: a copyable string that decodes to exactly what was entered.
  await expect(page.getByRole('heading', { name: 'Thank you' })).toBeVisible();
  const box = page.getByRole('textbox', { name: 'Your result code' });
  await expect(box).toHaveValue(/^QLS1\./);
  const code = await box.inputValue();
  const result = fromB64(code.slice('QLS1.'.length));
  expect(result).toMatchObject({ v: 1, study: 'e2e-study', pid: 'P07', arm: 'text', timedOut: false, materialSeconds: 5 });
  expect(result.answers).toEqual([
    { id: 'q1', text: 'the least recently used page' },
    { id: 'q2', text: 'it avoids a disk read' },
  ]);
  expect(String(result.build).length).toBeGreaterThan(0);
  await expect(page.getByRole('link', { name: 'Download as a file' })).toHaveAttribute('download', 'querylens-study-P07.txt');
  await axeClean(page);

  // Clearing deletes the session from this browser.
  await page.getByRole('button', { name: 'Clear this from my browser' }).click();
  await expect(page.getByRole('heading', { name: 'Nothing to do here' })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('querylens:study'))).toBeNull();
});

test('an app-arm participant gets the lessons, each opening in its own tab', async ({ page }) => {
  await open(page, pack({ arm: 'app', tasks: [
    { label: 'Lesson: Watch a page get evicted', href: '/learn/eviction' },
    { label: 'Lesson: Watch a B+Tree split', href: '/learn/btree-split' },
  ] }));
  await throughConsent(page);
  await expect(page.getByRole('heading', { name: 'Learn with QueryLens' })).toBeVisible();
  const lesson = page.getByRole('link', { name: /Watch a page get evicted/ });
  await expect(lesson).toHaveAttribute('href', '/learn/eviction');
  await expect(lesson).toHaveAttribute('target', '_blank');
  await expect(lesson).toHaveAttribute('rel', /noopener/);
  await expect(page.getByRole('link', { name: /Watch a B\+Tree split/ })).toHaveAttribute('href', '/learn/btree-split');
  await axeClean(page);
});

test('when the clock runs out the test ends and the answers so far are kept', async ({ page }) => {
  await page.clock.install();
  await open(page, pack({ testSeconds: 20 }));
  await throughConsent(page);

  await page.clock.fastForward(6_000);
  await page.getByRole('button', { name: 'Continue to the questions' }).click();
  await page.getByRole('textbox', { name: /First question/ }).fill('half an answer');

  await page.clock.fastForward(25_000);
  await expect(page.getByRole('heading', { name: 'Thank you' })).toBeVisible();
  await expect(page.getByText('Time ran out')).toBeVisible();
  const code = await page.getByRole('textbox', { name: 'Your result code' }).inputValue();
  const result = fromB64(code.slice('QLS1.'.length));
  expect(result).toMatchObject({ timedOut: true, testSeconds: 20, testUsedSeconds: 20 });
  expect((result.answers as { id: string; text: string }[])[0]).toEqual({ id: 'q1', text: 'half an answer' });
});

test('a damaged link, or one pointing off-site, is refused with a reason', async ({ page }) => {
  await page.goto('/study#p=AAAA');
  await expect(page.getByRole('heading', { name: 'This link did not work' })).toBeVisible();
  await expect(page.getByText(/damaged or incomplete/)).toBeVisible();

  await open(page, pack({ arm: 'app', tasks: [{ label: 'Elsewhere', href: 'https://evil.test/login' }] }));
  await expect(page.getByRole('heading', { name: 'This link did not work' })).toBeVisible();
  await expect(page.getByText(/must be a path on this site/)).toBeVisible();
});

/**
 * plan.md §25.4 A6 — field performance without telemetry. A participant may
 * opt in, separately from consenting to the study, to have their own device's
 * interaction timing (INP) recorded and included in the result code they hand
 * back by hand. Nothing is transmitted; the measurement runs in the *app's*
 * tabs (the lessons open in a new one), reads through localStorage, and is
 * switched off and forgotten when the session ends.
 */
test('opting in records INP in the lesson tab, adds it to the result code, and forgets it afterwards', async ({ page, context }) => {
  await open(page, pack({ materialSeconds: 5 }));

  // The optional box is separate from consent, unticked, and Begin does not depend on it.
  const optional = page.getByRole('checkbox', { name: /Optional: also record how responsive/ });
  await expect(optional).not.toBeChecked();
  await axeClean(page);
  await page.getByRole('checkbox', { name: /I have read this/ }).check();
  await optional.check();
  await page.getByRole('button', { name: 'Begin' }).click();

  const deadline = () => page.evaluate(() => Number(localStorage.getItem('querylens:perf-optin')));
  expect(await deadline()).toBeGreaterThan(Date.now());

  // The lesson tab: a click that blocks for 80 ms is an interaction slow enough for the Event Timing API to report.
  const app = await context.newPage();
  await app.goto('/playground');
  await app.evaluate(() => {
    document.addEventListener('click', () => {
      const t = performance.now();
      while (performance.now() - t < 80) { /* an 80 ms handler */ }
    });
  });
  await expect
    .poll(async () => {
      await app.locator('body').click({ position: { x: 5, y: 5 } });
      await app.evaluate(() => { window.dispatchEvent(new Event('pagehide')); }); // the recorder's flush
      return app.evaluate(() => (JSON.parse(localStorage.getItem('querylens:perf') ?? '{"count":0}') as { count: number }).count);
    }, { timeout: 15_000 })
    .toBeGreaterThan(0);
  await app.close();

  // Finish the session and read the result code — decoded with Node's zlib, not the app's codec.
  await expect(page.getByRole('button', { name: 'Continue to the questions' })).toBeEnabled({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Continue to the questions' }).click();
  await page.getByRole('button', { name: 'Finish' }).click();
  const code = await page.getByRole('textbox', { name: 'Your result code' }).inputValue();
  const result = fromB64(code.replace(/^QLS1\./, ''));
  const perf = result.perf as { inp: number | null; interactions: number; cores: number; viewportPx: number; touch: boolean };
  expect(perf.inp).toBeGreaterThanOrEqual(60);
  expect(perf.interactions).toBeGreaterThan(0);
  expect(perf.cores).toBeGreaterThan(0);
  expect(Object.keys(perf).sort()).toEqual(['cores', 'inp', 'interactions', 'touch', 'viewportPx']);
  await expect(page.getByText(/plus the responsiveness timing and device description you opted in to/)).toBeVisible();

  // Ended: measurement off, samples gone.
  expect(await page.evaluate(() => [localStorage.getItem('querylens:perf-optin'), localStorage.getItem('querylens:perf')])).toEqual([null, null]);
});

test('without opting in, nothing is measured and the result code has no perf block', async ({ page, context }) => {
  await open(page, pack({ materialSeconds: 5 }));
  await throughConsent(page);
  expect(await page.evaluate(() => localStorage.getItem('querylens:perf-optin'))).toBeNull();

  const app = await context.newPage();
  await app.goto('/playground');
  await app.locator('body').click({ position: { x: 5, y: 5 } });
  await app.evaluate(() => { window.dispatchEvent(new Event('pagehide')); });
  expect(await app.evaluate(() => localStorage.getItem('querylens:perf'))).toBeNull();
  await app.close();

  await expect(page.getByRole('button', { name: 'Continue to the questions' })).toBeEnabled({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Continue to the questions' }).click();
  await page.getByRole('button', { name: 'Finish' }).click();
  const code = await page.getByRole('textbox', { name: 'Your result code' }).inputValue();
  expect(fromB64(code.replace(/^QLS1\./, ''))).not.toHaveProperty('perf');
  await expect(page.getByText(/and nothing else\. This page has not sent it anywhere/)).toBeVisible();
});
