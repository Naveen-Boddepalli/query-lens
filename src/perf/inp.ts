/**
 * plan.md §25.4 A6 — field performance without telemetry.
 *
 * §14.2 left one number unmeasured: INP (Interaction to Next Paint) on a
 * lecture-hall laptop or a phone, the hardware this app is actually used on.
 * There is no telemetry (§14.4), so the number cannot be *collected* — it can
 * only be *volunteered*. A participant in the §9 study may opt in, on the
 * consent screen, to have their own device's interaction timing recorded in
 * their own browser and included in the result code they hand back by hand.
 * Nothing is transmitted by this module. It is never on for anyone who did not
 * tick the box, and it stops and forgets when the session finishes.
 *
 * INP, as web.dev defines it: for each *interaction* (a tap, a click, a
 * keypress — the several events one gesture fires share an `interactionId`)
 * take the longest event duration; INP is the worst interaction, except that
 * one outlier is forgiven per 50 interactions (so effectively the 98th
 * percentile). ≤ 200 ms is "good", ≤ 500 ms "needs improvement", above is "poor".
 *
 * The samples live in `localStorage`, not in a variable, because a study
 * participant works in *another tab* (the lessons open in a new tab) from the
 * study runner that later reports the number.
 */

export const OPT_IN_KEY = 'querylens:perf-optin';
const SAMPLES_KEY = 'querylens:perf';

/** How many of the slowest interactions are kept — enough for the 98th percentile of ~3,000 interactions. */
const KEEP = 60;
/** Interactions shorter than this are not worth an entry (the Event Timing API's own floor is 16 ms). */
const THRESHOLD_MS = 16;

export interface Samples {
  v: 1;
  /** Every interaction seen, including the short ones — the divisor for the percentile. */
  count: number;
  /** The `KEEP` slowest, descending. */
  top: number[];
}

/** What goes in the result code, alongside enough context to read the number. */
export interface PerfSummary {
  /** Milliseconds, or `null` when the browser has no Event Timing API or nothing was measured. */
  inp: number | null;
  interactions: number;
  /** Coarse device context — `hardwareConcurrency` — so 180 ms on 4 cores is not read as 180 ms on 16. */
  cores: number;
  /** Viewport width in CSS pixels. */
  viewportPx: number;
  touch: boolean;
}

export type InpBand = 'good' | 'needs-improvement' | 'poor';

export const inpBand = (ms: number): InpBand => (ms <= 200 ? 'good' : ms <= 500 ? 'needs-improvement' : 'poor');

/** The INP of `count` interactions whose slowest are `top` (descending): skip one outlier per 50. */
export function inpFrom(samples: Samples): number | null {
  if (samples.count === 0 || samples.top.length === 0) return null;
  const index = Math.min(samples.top.length - 1, Math.floor(samples.count / 50));
  return samples.top[index] ?? null;
}

/**
 * Merges newly finished interaction durations into the stored samples. Pure.
 *
 * `total` is how many interactions those durations stand for. The observer only
 * *reports* interactions slower than its threshold, but the percentile needs the
 * count of *all* of them (fast ones included — that is what makes "one outlier
 * per 50" mean one in fifty), so where the browser exposes
 * `performance.interactionCount` the caller passes the true delta here.
 */
export function mergeSamples(stored: Samples | null, durations: readonly number[], total = durations.length): Samples {
  const base: Samples = stored ?? { v: 1, count: 0, top: [] };
  const top = [...base.top, ...durations.filter((d) => d >= THRESHOLD_MS)].sort((a, b) => b - a).slice(0, KEEP);
  return { v: 1, count: base.count + Math.max(total, durations.length), top };
}

/* ----- storage (try/catch, degrade to "nothing measured") ------------------ */

export function parseSamples(raw: unknown): Samples | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || typeof r.count !== 'number' || !Number.isFinite(r.count) || r.count < 0 || !Array.isArray(r.top)) return null;
  const top = r.top.filter((d): d is number => typeof d === 'number' && Number.isFinite(d) && d >= 0).slice(0, KEEP);
  return { v: 1, count: Math.floor(r.count), top: top.sort((a, b) => b - a) };
}

export function readSamples(): Samples | null {
  try {
    const raw = localStorage.getItem(SAMPLES_KEY);
    return raw ? parseSamples(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

function writeSamples(s: Samples): void {
  try {
    localStorage.setItem(SAMPLES_KEY, JSON.stringify(s));
  } catch {
    // Storage blocked: no measurement, and nothing else is affected.
  }
}

/**
 * The opt-in is a *deadline*, not a bare flag: it lapses on its own, so a
 * participant who ticks the box and never finishes is not left measured for
 * ever. A study session is minutes long; this is a generous ceiling.
 */
export const OPT_IN_LIFETIME_MS = 3 * 60 * 60 * 1000;

export function isOptedIn(now = Date.now()): boolean {
  try {
    return Number(localStorage.getItem(OPT_IN_KEY)) > now;
  } catch {
    return false;
  }
}

export function setOptIn(on: boolean, now = Date.now()): void {
  try {
    if (on) localStorage.setItem(OPT_IN_KEY, String(now + OPT_IN_LIFETIME_MS));
    else localStorage.removeItem(OPT_IN_KEY);
  } catch {
    // Nothing to do — an unsettable flag just means nothing is measured.
  }
}

/** Stop and forget: the flag and every stored sample. */
export function clearPerf(): void {
  setOptIn(false);
  try {
    localStorage.removeItem(SAMPLES_KEY);
  } catch {
    // Nothing to clear.
  }
}

export function supportsEventTiming(): boolean {
  return typeof PerformanceObserver !== 'undefined' && (PerformanceObserver.supportedEntryTypes as readonly string[] | undefined)?.includes('event') === true;
}

/** The summary for the result code — read from storage, so it spans every tab and reload of the session. */
export function summarisePerf(): PerfSummary {
  const samples = readSamples();
  return {
    inp: samples ? inpFrom(samples) : null,
    interactions: samples?.count ?? 0,
    cores: typeof navigator === 'undefined' ? 0 : navigator.hardwareConcurrency,
    viewportPx: typeof window === 'undefined' ? 0 : Math.round(window.innerWidth),
    touch: typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0,
  };
}

/* ----- the observer ---------------------------------------------------------- */

/** The bit of a `PerformanceEventTiming` entry this needs — a structural type, so tests need no DOM. */
export interface TimingEntry {
  duration: number;
  interactionId?: number;
}

export interface Recorder {
  /** Feed entries as they arrive. */
  observe(entries: readonly TimingEntry[]): void;
  /** Persist the interactions finished since the last flush. */
  flush(): void;
}

/**
 * Groups entries by `interactionId` (the max duration wins) and merges the
 * finished interactions into storage on `flush`. Split from the observer
 * wiring so it can be driven by plain objects.
 *
 * `interactionCount` is `performance.interactionCount` where the browser has it
 * (the cumulative number of interactions in this document, fast ones too);
 * without it the count falls back to the interactions this observer saw.
 */
export function createRecorder(
  store: { read(): Samples | null; write(s: Samples): void } = { read: readSamples, write: writeSamples },
  interactionCount: () => number | null = () => null,
): Recorder {
  const pending = new Map<number, number>();
  let counted = 0;
  return {
    observe(entries) {
      for (const e of entries) {
        if (!e.interactionId) continue; // not part of a discrete interaction (a hover, a scroll frame)
        pending.set(e.interactionId, Math.max(pending.get(e.interactionId) ?? 0, e.duration));
      }
    },
    flush() {
      const now = interactionCount();
      const delta = now === null ? 0 : Math.max(0, now - counted);
      if (now !== null) counted = now;
      if (pending.size === 0 && delta === 0) return;
      store.write(mergeSamples(store.read(), [...pending.values()], delta));
      pending.clear();
    },
  };
}

/** Starts measuring in this tab. Returns a stop function. A no-op where the API is missing. */
export function startInpObserver(): () => void {
  if (!supportsEventTiming()) return () => undefined;
  // `interactionCount` (Chromium) is the whole count, fast interactions included.
  const recorder = createRecorder(undefined, () => {
    const n = (performance as unknown as { interactionCount?: unknown }).interactionCount;
    return typeof n === 'number' ? n : null;
  });
  const observer = new PerformanceObserver((list) => { recorder.observe(list.getEntries()); });
  // `durationThreshold` is the API's own floor for reporting an event at all.
  observer.observe({ type: 'event', buffered: true, durationThreshold: THRESHOLD_MS } as PerformanceObserverInit);

  const flush = () => { recorder.observe(observer.takeRecords()); recorder.flush(); };
  const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flush);
  const timer = window.setInterval(flush, 5000);

  return () => {
    flush();
    observer.disconnect();
    document.removeEventListener('visibilitychange', onHide);
    window.removeEventListener('pagehide', flush);
    window.clearInterval(timer);
  };
}
