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
  await page.goto(`/playground?q=${LOOKUP}&p=lru&x=0&s=1`);
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
  await page.goto(`/playground?q=${LOOKUP}&p=lru&x=0&s=4`);
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

test('the tree zoom controls sit outside the canvas and work', async ({ page }) => {
  // They used to be React Flow's own <Controls>, floating in the pane's
  // bottom-right — which for a B+Tree is exactly where the leaf row is drawn.
  await page.goto(`/playground?q=${LOOKUP}&p=lru&x=0&s=24`);
  const canvas = page.locator('.react-flow');
  const zoomIn = page.getByRole('button', { name: 'Zoom in' });
  await expect(zoomIn).toBeVisible();

  // Outside the canvas box: no node can ever be underneath them.
  const [controls, pane] = await Promise.all([
    zoomIn.boundingBox(),
    canvas.boundingBox(),
  ]);
  expect(controls!.y + controls!.height).toBeLessThanOrEqual(pane!.y + 1);

  const zoom = () => page.evaluate(() => {
    const t = (document.querySelector('.react-flow__viewport') as HTMLElement).style.transform;
    return Number(/scale\(([\d.]+)\)/.exec(t)?.[1] ?? 0);
  });

  const before = await zoom();
  await zoomIn.click();
  await page.waitForTimeout(400);
  const zoomedIn = await zoom();
  expect(zoomedIn).toBeGreaterThan(before);

  await page.getByRole('button', { name: 'Zoom out' }).click();
  await page.waitForTimeout(400);
  expect(await zoom()).toBeLessThan(zoomedIn);

  // Fit uses our own d3 maths, not React Flow's fitView, which needs measured
  // node dimensions these graphs never report.
  await page.getByRole('button', { name: 'Fit the whole tree' }).click();
  await page.waitForTimeout(500);
  expect(await zoom()).toBeGreaterThan(0);
});

test('no page overflow at any step, desktop or mobile', async ({ page }) => {
  // Reported as results "extending the page" instead of scrolling in place.
  // The horizontal half was found here: a long email column made the phone
  // scroll sideways, because grid and flex children default to
  // `min-width: auto` and refuse to shrink below their content.
  //
  // The Playground shell (`Layout.tsx`'s `lg:h-dvh` block, marked
  // `[data-app-shell]`) is deliberately one viewport tall on desktop, with the
  // footer below it. What must never happen is the *app shell itself* growing:
  // it is measured directly here, so the check is footer-agnostic and stays
  // about the one invariant that matters — a large result scrolls inside its
  // panel instead of stretching the shell.
  const problems: string[] = [];
  for (const [name, size] of [['desktop', { width: 1360, height: 900 }], ['mobile', { width: 375, height: 812 }]] as const) {
    await page.setViewportSize(size);
    for (const url of [`/playground?q=${LOOKUP}&p=lru&x=0&s=33`, `/playground?q=${SCAN}&p=clock&x=0&s=9999`]) {
      await page.goto(url);
      await page.waitForTimeout(400);
      const m = await page.evaluate(() => ({
        x: document.documentElement.scrollWidth > innerWidth + 1,
        shellHeight: document.querySelector('[data-app-shell]')!.getBoundingClientRect().height,
      }));
      if (m.x) problems.push(`${name} ${url}: horizontal overflow`);
      // Only the desktop shell is fixed-height; the phone is meant to scroll,
      // since content there is not height-constrained at all.
      if (name === 'desktop' && m.shellHeight > size.height + 2) {
        problems.push(`${name} ${url}: app shell is ${String(Math.round(m.shellHeight))}px, past the ${String(size.height)}px viewport`);
      }
    }
  }
  expect(problems).toEqual([]);
});

test('a long result scrolls inside its panel', async ({ page }) => {
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto(`/playground?q=${SCAN}&p=lru&x=0&s=9999`);
  await page.waitForTimeout(500);
  // The desktop Playground shell is exactly one viewport, so if the result did
  // *not* scroll inside its own panel the playback controls would be pushed
  // off the bottom.
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
  await page.goto(`/playground?q=${LOOKUP}&p=lru&x=1&s=8`);
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
  await page.goto(`/playground?q=${LOOKUP}&p=lru&x=0&s=1`);
  for (let i = 0; i < 6; i++) await page.getByRole('button', { name: 'Step forward' }).click();
  await page.waitForTimeout(500);
  // replaceState, not pushState: stepping adds no history entries, so one Back
  // returns to wherever the visitor came from (here, the landing page).
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
});

test('editing seed data re-runs the trace', async ({ page }) => {
  await page.goto('/playground');
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

  await page.goto(`/playground?q=${LOOKUP}&p=lru&x=0&s=1`);
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

/**
 * Framing the tree on load.
 *
 * The symptom was an unframed tree — viewport left at `translate(0px, 0px)
 * scale(1)`, the graph in the pane's top-left corner — on some cold loads but
 * not others. The cause was that the framing was applied with a duration, and
 * a duration makes React Flow move the viewport through a d3 transition, which
 * only advances on `requestAnimationFrame`. On a cold load the first animation
 * frame can arrive arbitrarily late, and until it does the transition has not
 * started: the transform stays at the identity it was initialised with, and
 * nothing re-runs the framing afterwards.
 *
 * These two tests come at it from both ends — the symptom, and the cause.
 */

const IDENTITY = 'translate(0px, 0px) scale(1)';

/** The viewport transform, and where the nodes sit inside the pane. */
const readFraming = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const pane = document.querySelector('.react-flow') as HTMLElement;
    const view = pane.querySelector('.react-flow__viewport') as HTMLElement;
    const nodes = [...pane.querySelectorAll('.react-flow__node')].map((n) =>
      n.getBoundingClientRect(),
    );
    const paneBox = pane.getBoundingClientRect();
    const box = {
      left: Math.min(...nodes.map((n) => n.left)),
      right: Math.max(...nodes.map((n) => n.right)),
      top: Math.min(...nodes.map((n) => n.top)),
      bottom: Math.max(...nodes.map((n) => n.bottom)),
    };
    return {
      transform: view.style.transform,
      count: nodes.length,
      // How far the nodes' centre sits from the pane's, as a fraction of the
      // pane. 0 is dead centre; the unframed corner case is about 0.3–0.5.
      offX: Math.abs((box.left + box.right) / 2 - (paneBox.left + paneBox.right) / 2) / paneBox.width,
      offY: Math.abs((box.top + box.bottom) / 2 - (paneBox.top + paneBox.bottom) / 2) / paneBox.height,
    };
  });

test('the parse tree is framed on every cold load, not left at the origin', async ({ page }) => {
  // Reported as intermittent, so one load proves nothing: reload repeatedly.
  await page.setViewportSize({ width: 1360, height: 900 });
  const problems: string[] = [];

  for (let i = 0; i < 8; i++) {
    await page.goto(`/playground?q=${LOOKUP}&p=lru&x=0&s=1`);
    await expect(page.locator('.react-flow__node').first()).toBeVisible();
    await page.waitForTimeout(600);

    const f = await readFraming(page);
    if (f.transform === IDENTITY) problems.push(`load ${i}: viewport never moved (${f.transform})`);
    // Framed means centred, not merely moved.
    if (f.offX > 0.08 || f.offY > 0.08) {
      problems.push(`load ${i}: off centre by ${f.offX.toFixed(2)}/${f.offY.toFixed(2)}`);
    }
  }

  expect(problems).toEqual([]);
});

test.describe('framing does not depend on an animation frame arriving', () => {
  // The bug only exists when the framing is animated, and it is animated only
  // when the viewer has not asked for reduced motion. Pin that here: under
  // `reduce` the duration is 0, the move is synchronous, and this test would
  // pass without ever exercising the thing it is about.
  test.use({ contextOptions: { reducedMotion: 'no-preference' } });

  test('the tree is framed before the first animation frame runs', async ({ page }) => {
    // Hold every animation-frame callback, the way a tab that has not started
    // painting does, and release them well after the assertion below. With the
    // framing applied through a d3 transition the tree stays in the corner for
    // the whole hold; applied directly it is framed immediately.
    await page.addInitScript(() => {
      const real = window.requestAnimationFrame.bind(window);
      const held: FrameRequestCallback[] = [];
      let holding = true;
      let handle = 1e6;
      window.requestAnimationFrame = (cb: FrameRequestCallback) => {
        if (!holding) return real(cb);
        held.push(cb);
        return handle++;
      };
      setTimeout(() => {
        holding = false;
        for (const cb of held) real(cb);
      }, 6000);
    });

    await page.setViewportSize({ width: 1360, height: 900 });
    await page.goto(`/playground?q=${LOOKUP}&p=lru&x=0&s=1`);
    await expect(page.locator('.react-flow__node').first()).toBeVisible();

    // Comfortably inside the hold, so a pass cannot come from rAF resuming.
    await expect.poll(async () => (await readFraming(page)).transform, { timeout: 2500 })
      .not.toBe(IDENTITY);

    const f = await readFraming(page);
    expect(f.count).toBeGreaterThan(0);
    expect(f.offX).toBeLessThan(0.08);
    expect(f.offY).toBeLessThan(0.08);
  });
});

test('a re-frame also survives a tab that is not painting', async ({ page }) => {
  /**
   * The sibling of the test above, for every framing after the first.
   *
   * The fix has two halves. The first framing is unconditionally instant, which
   * the test above pins. Later framings animate — but a shared link is routinely
   * opened with ⌘-click or "open in new tab", playback timers keep running in a
   * hidden tab, and a re-frame that happens there would animate into the same
   * dead d3 transition. `FlowTree` guards that with `document.hidden`, and this
   * pins it.
   *
   * Both halves of a background tab are modelled, because either alone proves
   * nothing: rAF held (so an animated move cannot land) *and* `document.hidden`
   * true (so the guard is the only thing that can save it).
   */
  await page.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'hidden', { get: () => true, configurable: true });
    Object.defineProperty(Document.prototype, 'visibilityState', {
      get: () => 'hidden',
      configurable: true,
    });
    const real = window.requestAnimationFrame.bind(window);
    const held: FrameRequestCallback[] = [];
    let holding = true;
    let handle = 1e6;
    window.requestAnimationFrame = (cb: FrameRequestCallback) => {
      if (!holding) return real(cb);
      held.push(cb);
      return handle++;
    };
    setTimeout(() => {
      holding = false;
      for (const cb of held) real(cb);
    }, 8000);
  });

  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto(`/playground?q=${LOOKUP}&p=lru&x=0&s=1`);
  await expect(page.locator('.react-flow__node').first()).toBeVisible();
  await expect.poll(async () => (await readFraming(page)).transform, { timeout: 3000 })
    .not.toBe(IDENTITY);

  // Resizing re-measures the pane, which re-runs the framing — this time as a
  // *re-frame*, the animated path. A much narrower pane, so a move that is lost
  // leaves the tree visibly off centre rather than coincidentally near it.
  await page.setViewportSize({ width: 700, height: 900 });

  await expect
    .poll(async () => (await readFraming(page)).offX, { timeout: 3000 })
    .toBeLessThan(0.08);
  expect((await readFraming(page)).offY).toBeLessThan(0.08);
});

/**
 * Deep links resolve to the app, not the 404 page (plan.md §21.5 / §21.8).
 *
 * Client routing landed in `5c7ef5d` but the deploy never got an SPA rewrite,
 * so a hard load of any route but `/` — a refresh, a shared link, a new tab —
 * had nothing to serve. `public/_redirects` closes that on Cloudflare Pages;
 * `vite preview` has always had its own history fallback, so what this pins is
 * the half that lives in the app: every route renders the shell and its own
 * content on a cold load, rather than React Router's NotFoundPage or the
 * standalone `public/404.html`. (The Cloudflare rewrite itself can only be
 * checked against the live URL — playwright.config.ts's note on `_headers`
 * applies to `_redirects` too.)
 */
test('every route renders the app on a cold load, not the 404 page', async ({ page }) => {
  const routes: [string, RegExp][] = [
    ['/', /Reading a trace/],
    ['/playground', /steps in this trace/],
    ['/stages', /Pipeline stages/i],
    ['/stages/parse', /Parser/],
    ['/examples', /Examples/],
    ['/docs/faq', /Frequently Asked|FAQ|data/i],
    // The §21.3 feature routes (built after M13, on the same manifest/lazy
    // wiring — a route missing its own Suspense boundary would blank here).
    ['/gallery', /Gallery/],
    ['/tools', /Tools/],
    ['/tools/buffer-pool', /Buffer pool sandbox/],
    ['/tools/parser', /Parser sandbox/],
    ['/compare', /Compare replacement policies/],
    ['/settings', /Settings/],
    ['/assignments/new', /Create an assignment/],
  ];
  for (const [path, marker] of routes) {
    const response = await page.goto(path);
    expect(response?.status(), `${path} status`).toBeLessThan(400);
    // The disclaimer bar is in Layout, so it is on every in-app route and on
    // none of the fallback pages. `.first()`: the footer's own closing line
    // (Footer.tsx) repeats similar wording further down the same page.
    await expect(
      page.getByText(/simplified educational model/).first(),
      `${path}: app shell missing`,
    ).toBeVisible();
    await expect(page.locator('body'), `${path}: content missing`).toContainText(marker);
    // The standalone fallback would have this exact copy; the app never does.
    await expect(page.getByText("QueryLens didn’t load")).toHaveCount(0);
  }
});

test('/examples does not pull the CodeMirror or Playground chunk', async ({ page }) => {
  // plan.md §21.8: a prose-only route that drags in the editor means the lazy
  // split (App.tsx) is not holding. CodeMirror is the 367 kB one that must not
  // leak; `PlaygroundPage`, `StageDetail` and `docs` must not either.
  //
  // React Flow (`flow-*.js`) is deliberately not asserted here: the deprecated
  // `advancedChunks` config in vite.config.ts hoists that chunk into the entry
  // graph, so every route preloads it. Un-sharing it is a chunk-config change
  // with its own blast radius (every hash moves, §14.2's caching story) — a
  // separate task, tracked apart from M13.
  const leaked: string[] = [];
  page.on('request', (r) => {
    const file = r.url().split('/').pop() ?? '';
    if (/^(codemirror|PlaygroundPage|StageDetail|docs)-/.test(file)) leaked.push(file);
  });
  await page.goto('/examples');
  await expect(page.getByRole('heading', { name: 'Examples' })).toBeVisible();
  await page.waitForTimeout(300);
  expect(leaked).toEqual([]);
});
