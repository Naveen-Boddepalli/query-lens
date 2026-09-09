/**
 * Record a stretch of a QueryLens trace as a GIF and a WebM (plan.md §20.3,
 * §20.8 — the third and last M12 artefact, after Copy-as-Mermaid and the panel
 * PNG export).
 *
 *   pnpm record "<shareable link or query>" [--from N] [--to M] [options]
 *
 *   pnpm record "SELECT * FROM users WHERE age > 30" --from 60 --to 100
 *   pnpm record "http://localhost:5173/playground?q=...&p=clock" --selector '[data-app-shell]'
 *
 * Why a script and not a button
 * -----------------------------
 * §20.3 settled this: a GIF encoder is ~40 kB of bundle for something used once
 * a month, 256 colours wreck the OKLCH palette and the anti-aliased type, and a
 * 131-step scan takes 20-30 s to encode on the main thread. The script has none
 * of those problems — it drives the *real built app* in a real browser, so it
 * gets the production CSS, the shipped font files and the exact `oklch()`
 * colours, and it hands ffmpeg a clean frame sequence to mux. It is also, per
 * §18.2, the launch artefact: "watch a query become a B+Tree traversal" wants a
 * moving picture next to it.
 *
 * One renderer path (§20.2 #1, §20.8)
 * -----------------------------------
 * This captures the same rendered panel DOM that the on-screen "Download PNG"
 * button rasterises — the app's own components, tokens and fonts, screenshotted
 * live. There is no second drawing of the diagram to drift from the first: a
 * token or layout change moves the button's output and this script's output
 * together, the same way `scripts/build-og.ts` (the still-frame sibling of this
 * file) tracks the design automatically.
 *
 * ffmpeg
 * ------
 * The WebM is muxed by whatever ffmpeg is found — `$FFMPEG_PATH`, then one on
 * `PATH`, then the copy Playwright bundles for its own video recording (VP8,
 * which is all that build has). The GIF needs `palettegen`/`paletteuse`, which
 * the Playwright build omits, so it is produced only when a full ffmpeg is
 * available; without one the script still writes the WebM and the frame
 * sequence and prints the exact command to finish the GIF. Same "document the
 * degradation rather than work around it" line the FAQ takes on Safari's PNG.
 */

import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

interface Options {
  from: number | undefined;
  to: number | undefined;
  out: string;
  width: number;
  height: number;
  scale: number;
  fps: number;
  dwellMs: number;
  holdMs: number;
  gifWidth: number | undefined;
  selector: string | undefined;
  theme: 'dark' | 'light';
  port: number;
  skipGif: boolean;
  skipWebm: boolean;
  keepFrames: boolean;
}

const HELP = `Record a QueryLens trace as a GIF and a WebM.

Usage:
  pnpm record "<link | /playground?… | q=…>" [options]

Options:
  --from <n>        first step to capture         (default: the link's s=, else 0)
  --to <n>          last step to capture          (default: the final step)
  --out <path>      output basename              (default: build/recording)
  --width <px>      viewport width               (default: 1280)
  --height <px>     viewport height              (default: 800)
  --scale <n>       device pixel ratio           (default: 2)
  --fps <n>         output frame rate            (default: 6)
  --dwell <ms>      time held on each step       (default: 900)
  --hold <ms>       extra hold on first + last   (default: 1600)
  --gif-width <px>  downscale the GIF to this    (default: min(width, 960))
  --selector <css>  capture one element only     (default: the whole viewport)
  --theme <name>    dark | light                 (default: dark)
  --port <n>        preview server port          (default: 4176)
  --skip-gif        write only the WebM
  --skip-webm       write only the GIF
  --no-keep-frames  delete the frame JPEGs when done
  --help

Needs a production build first (pnpm build). The GIF needs a full ffmpeg on
PATH; the WebM falls back to the one Playwright bundles.`;

function parse(): { url: string; opts: Options } {
  // `util.parseArgs` has no `--no-<flag>` negation and throws on unknown flags,
  // so pull this one out before it sees the list.
  const rawArgs = process.argv.slice(2);
  const dropFrames = rawArgs.includes('--no-keep-frames');

  const { values, positionals } = parseArgs({
    args: rawArgs.filter((a) => a !== '--no-keep-frames'),
    allowPositionals: true,
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      out: { type: 'string', default: 'build/recording' },
      width: { type: 'string', default: '1280' },
      height: { type: 'string', default: '800' },
      scale: { type: 'string', default: '2' },
      fps: { type: 'string', default: '6' },
      dwell: { type: 'string', default: '900' },
      hold: { type: 'string', default: '1600' },
      'gif-width': { type: 'string' },
      selector: { type: 'string' },
      theme: { type: 'string', default: 'dark' },
      port: { type: 'string', default: '4176' },
      'skip-gif': { type: 'boolean', default: false },
      'skip-webm': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }

  const num = (raw: string | undefined, name: string): number | undefined => {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      console.error(`--${name} must be a number, got "${raw}"`);
      process.exit(1);
    }
    return n;
  };

  const theme = values.theme === 'light' ? 'light' : 'dark';

  return {
    url: positionals[0] ?? '',
    opts: {
      from: num(values.from, 'from'),
      to: num(values.to, 'to'),
      out: values.out,
      width: num(values.width, 'width') ?? 1280,
      height: num(values.height, 'height') ?? 800,
      scale: num(values.scale, 'scale') ?? 2,
      fps: num(values.fps, 'fps') ?? 6,
      dwellMs: num(values.dwell, 'dwell') ?? 900,
      holdMs: num(values.hold, 'hold') ?? 1600,
      gifWidth: num(values['gif-width'], 'gif-width'),
      selector: values.selector,
      theme,
      port: num(values.port, 'port') ?? 4176,
      skipGif: values['skip-gif'],
      skipWebm: values['skip-webm'],
      keepFrames: !dropFrames,
    },
  };
}

/**
 * Turn whatever the caller pasted — a full app URL, a `/playground?…` path, or a
 * bare `q=…` query string — into a local URL against the preview server.
 * Prediction is forced off (`x=0`): its gates would stop the playhead dead, and
 * a prompt card would cover the panel. An assignment lock (`l=1`) is stripped
 * for the same reason. Param names are `src/ui/urlState.ts`'s.
 */
function buildUrl(input: string, origin: string, from: number | undefined): string {
  let params: URLSearchParams;
  if (/^https?:\/\//i.test(input)) {
    params = new URL(input).searchParams;
  } else if (input.startsWith('/')) {
    params = new URL(input, origin).searchParams;
  } else if (input.startsWith('?') || /^[qpxsdl]=/.test(input)) {
    params = new URLSearchParams(input.startsWith('?') ? input.slice(1) : input);
  } else {
    // A bare string is the SQL itself.
    params = new URLSearchParams();
    params.set('q', input);
  }

  params.set('x', '0');
  params.delete('l');
  if (from !== undefined) params.set('s', String(from));
  return `${origin}/playground?${params.toString()}`;
}

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  throw new Error(`preview server never came up at ${url}`);
}

/** `$FFMPEG_PATH` → one on PATH → the copy Playwright bundles. */
function resolveFfmpeg(): { path: string; bundled: boolean } | null {
  const fromEnv = process.env.FFMPEG_PATH;
  if (fromEnv && existsSync(fromEnv)) return { path: fromEnv, bundled: false };

  const onPath = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], {
    encoding: 'utf8',
  });
  if (onPath.status === 0) {
    const first = onPath.stdout.split('\n')[0]?.trim();
    if (first) return { path: first, bundled: false };
  }

  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Caches', 'ms-playwright')
      : process.platform === 'win32'
        ? join(homedir(), 'AppData', 'Local', 'ms-playwright')
        : join(homedir(), '.cache', 'ms-playwright'));

  if (existsSync(cache)) {
    const dirs = readdirSync(cache)
      .filter((d) => d.startsWith('ffmpeg-'))
      .sort()
      .reverse();
    for (const dir of dirs) {
      for (const bin of ['ffmpeg-mac', 'ffmpeg-linux', 'ffmpeg-win64.exe', 'ffmpeg.exe', 'ffmpeg']) {
        const candidate = join(cache, dir, bin);
        if (existsSync(candidate)) return { path: candidate, bundled: true };
      }
    }
  }
  return null;
}

interface FfmpegCaps {
  gif: boolean;
  vp9: boolean;
}

function probeFfmpeg(ffPath: string): FfmpegCaps {
  const muxers = spawnSync(ffPath, ['-hide_banner', '-muxers'], { encoding: 'utf8' }).stdout ?? '';
  const filters = spawnSync(ffPath, ['-hide_banner', '-filters'], { encoding: 'utf8' }).stdout ?? '';
  const encoders = spawnSync(ffPath, ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout ?? '';
  return {
    gif: /\bgif\b/.test(muxers) && filters.includes('palettegen') && filters.includes('paletteuse'),
    vp9: encoders.includes('libvpx-vp9'),
  };
}

/** Run ffmpeg, feeding `input` (concatenated as one mjpeg pipe) to stdin. */
function runFfmpeg(ffPath: string, args: string[], input: Buffer[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(ffPath, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    proc.stdin.on('error', () => undefined); // swallow EPIPE if ffmpeg exits first
    proc.on('error', reject);
    proc.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`ffmpeg exited ${String(code)}\n${stderr.slice(-1600)}`));
    });

    void (async () => {
      try {
        for (const buf of input) {
          if (!proc.stdin.write(buf)) await once(proc.stdin, 'drain');
        }
        proc.stdin.end();
      } catch {
        // ffmpeg closed the pipe early (EPIPE) — the non-zero 'exit' above
        // carries the real reason.
      }
    })();
  });
}

async function readStep(scrubber: Locator): Promise<number> {
  return Number(await scrubber.inputValue());
}

async function stepForwardTo(page: Page, scrubber: Locator, target: number): Promise<number> {
  const forward = page.getByRole('button', { name: 'Step forward' });
  let step = await readStep(scrubber);
  while (step < target) {
    if (await forward.isDisabled()) break;
    await forward.click();
    const want = step + 1;
    await page
      .waitForFunction(
        (v) => {
          const el = document.querySelector<HTMLInputElement>('input[aria-label="Scrub to step"]');
          return el !== null && Number(el.value) >= v;
        },
        want,
        { timeout: 5000 },
      )
      .catch(() => undefined);
    const now = await readStep(scrubber);
    if (now === step) break; // didn't advance — trace is shorter than asked
    step = now;
  }
  return step;
}

async function main(): Promise<void> {
  const { url: rawUrl, opts } = parse();
  const origin = `http://localhost:${String(opts.port)}`;

  if (!existsSync('dist/index.html')) {
    console.error('dist/ is missing or stale — run `pnpm build` first.');
    process.exit(1);
  }

  const ff = opts.skipWebm && opts.skipGif ? null : resolveFfmpeg();
  if (!ff && !(opts.skipWebm && opts.skipGif)) {
    console.error(
      'No ffmpeg found. Install one (`brew install ffmpeg`), set $FFMPEG_PATH, or run\n' +
        '`pnpm exec playwright install` so its bundled copy is present.',
    );
    process.exit(1);
  }
  const caps = ff ? probeFfmpeg(ff.path) : { gif: false, vp9: false };

  const framesDir = `${opts.out}-frames`;
  const webmPath = `${opts.out}.webm`;
  const gifPath = `${opts.out}.gif`;
  mkdirSync(resolve(framesDir), { recursive: true });
  for (const stale of readdirSync(resolve(framesDir))) {
    if (stale.endsWith('.jpg')) rmSync(resolve(framesDir, stale));
  }

  const server = spawn('pnpm', ['preview', '--port', String(opts.port), '--strictPort'], {
    stdio: 'ignore',
  });

  /** Unique capture per step; `repeat` spends the dwell at a constant frame rate. */
  const shots: { buf: Buffer; repeat: number }[] = [];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

  try {
    await waitForServer(origin);

    browser = await chromium.launch();
    const page = await browser.newPage({
      viewport: { width: opts.width, height: opts.height },
      deviceScaleFactor: opts.scale,
      colorScheme: opts.theme,
    });

    const first = buildUrl(rawUrl, origin, opts.from);
    await page.goto(first, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);

    const scrubber = page.getByLabel('Scrub to step');
    await scrubber.waitFor({ state: 'visible', timeout: 10_000 });

    const length = Number(await scrubber.getAttribute('max'));
    if (!Number.isFinite(length) || length <= 0) {
      throw new Error('this query produced no trace to record (a parse error?).');
    }

    const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(n, hi));
    const current = await readStep(scrubber);
    const from = clamp(opts.from ?? current, 0, length);
    const to = clamp(opts.to ?? length, from, length);

    if (from !== current) {
      await page.goto(buildUrl(rawUrl, origin, from), { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
    }

    const target: Locator = opts.selector ? page.locator(opts.selector).first() : page.locator('body');
    if (opts.selector) await target.waitFor({ state: 'visible', timeout: 10_000 });

    const perStep = Math.max(1, Math.round((opts.dwellMs / 1000) * opts.fps));
    const holdExtra = Math.max(0, Math.round((opts.holdMs / 1000) * opts.fps));

    const capture = async (): Promise<Buffer> =>
      opts.selector
        ? await target.screenshot({ type: 'jpeg', quality: 95, animations: 'disabled' })
        : await page.screenshot({ type: 'jpeg', quality: 95, animations: 'disabled' });

    let step = await readStep(scrubber);
    console.log(`recording steps ${String(from)}–${String(to)} of ${String(length)}…`);

    for (;;) {
      // A short beat so a just-applied step's transitions have settled before
      // the frame is taken (`animations: 'disabled'` freezes them, but layout
      // still needs a tick).
      await page.waitForTimeout(80);
      const atEdge = step === from || step === to;
      shots.push({ buf: await capture(), repeat: perStep + (atEdge ? holdExtra : 0) });

      if (step >= to) break;
      const next = await stepForwardTo(page, scrubber, step + 1);
      if (next === step) break;
      step = next;
    }
  } finally {
    await browser?.close();
    server.kill();
  }

  if (shots.length === 0) {
    throw new Error('captured no frames.');
  }

  // Expand to the on-disk sequence: `frame-00001.jpg` … at a constant --fps, so
  // `ffmpeg -framerate <fps> -i frame-%05d.jpg` reproduces this exactly.
  const pipeInput: Buffer[] = [];
  let n = 0;
  for (const { buf, repeat } of shots) {
    for (let i = 0; i < repeat; i++) {
      n += 1;
      pipeInput.push(buf);
      writeFileSync(resolve(framesDir, `frame-${String(n).padStart(5, '0')}.jpg`), buf);
    }
  }
  console.log(`✓ ${String(shots.length)} steps → ${String(n)} frames  ${framesDir}/`);

  const even = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  const feed = ['-f', 'image2pipe', '-c:v', 'mjpeg', '-r', String(opts.fps), '-i', 'pipe:0'];

  if (ff && !opts.skipWebm) {
    const codec = caps.vp9
      ? ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '32', '-row-mt', '1']
      : ['-c:v', 'libvpx', '-b:v', '1M', '-crf', '10'];
    await runFfmpeg(
      ff.path,
      ['-hide_banner', '-loglevel', 'error', '-y', ...feed, '-vf', even, ...codec, '-pix_fmt', 'yuv420p', '-an', `file:${resolve(webmPath)}`],
      pipeInput,
    );
    console.log(`✓ ${webmPath}  (${caps.vp9 ? 'VP9' : 'VP8'}${ff.bundled ? ', via Playwright ffmpeg' : ''})`);
  }

  if (!opts.skipGif) {
    if (ff && caps.gif) {
      const gifW = opts.gifWidth ?? Math.min(opts.width, 960);
      const palette = resolve(framesDir, 'palette.png');
      await runFfmpeg(
        ff.path,
        ['-hide_banner', '-loglevel', 'error', '-y', ...feed, '-vf', `scale=${String(gifW)}:-1:flags=lanczos,palettegen=stats_mode=full`, `file:${palette}`],
        pipeInput,
      );
      await runFfmpeg(
        ff.path,
        [
          '-hide_banner', '-loglevel', 'error', '-y', ...feed, '-i', `file:${palette}`,
          '-lavfi', `scale=${String(gifW)}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a`,
          '-loop', '0', `file:${resolve(gifPath)}`,
        ],
        pipeInput,
      );
      rmSync(palette, { force: true });
      console.log(`✓ ${gifPath}  (${String(gifW)} px wide, palettegen/paletteuse)`);
    } else {
      const gifW = opts.gifWidth ?? Math.min(opts.width, 960);
      console.log(
        `· ${gifPath} skipped — the ${ff?.bundled ? 'Playwright' : 'available'} ffmpeg has no palettegen.\n` +
          `  Install a full ffmpeg (\`brew install ffmpeg\`), then:\n` +
          `    ffmpeg -framerate ${String(opts.fps)} -i ${framesDir}/frame-%05d.jpg -vf "scale=${String(gifW)}:-1:flags=lanczos,palettegen=stats_mode=full" ${framesDir}/palette.png\n` +
          `    ffmpeg -framerate ${String(opts.fps)} -i ${framesDir}/frame-%05d.jpg -i ${framesDir}/palette.png -lavfi "scale=${String(gifW)}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a" -loop 0 ${gifPath}`,
      );
    }
  }

  if (!opts.keepFrames) {
    rmSync(resolve(framesDir), { recursive: true, force: true });
    console.log(`· ${framesDir}/ removed (--no-keep-frames)`);
  }
}

try {
  await main();
} catch (err) {
  console.error(`\nrecord failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
