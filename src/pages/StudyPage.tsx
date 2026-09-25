import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { BUILD_SHA } from '../buildInfo.ts';
import { clearPerf, setOptIn, summarisePerf } from '../perf/inp.ts';
import type { PerfSummary } from '../perf/inp.ts';
import { CopyButton } from '../ui/CopyButton.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';
import { btnPrimary, btnSecondary, card, inputField } from '../ui/primitives.ts';
import { parseBlocks, parseInline } from '../study/blocks.ts';
import { decodePack, packCodeFromHash } from '../study/pack.ts';
import type { StudyPack } from '../study/pack.ts';
import { encodeResult, MAX_ANSWER } from '../study/result.ts';
import {
  agree, canStartTest, clearSession, finish, formatClock, materialLeft, newSession, readSession,
  setAnswer, startTest, testLeft, tick, toResult, writeSession,
} from '../study/session.ts';
import type { Session } from '../study/session.ts';

/**
 * plan.md §25.4 A2 — the §9 study kit's runner: `/study#p=<pack>`.
 *
 * Unlisted (not in the nav or footer, `Disallow`ed in robots.txt, `noindex`),
 * and *inert without a pack*: the consent text, the control-arm reading and the
 * five mechanism questions arrive in the link's fragment, never in this bundle
 * (`src/study/pack.ts` says why). Nothing is transmitted — the fragment is not
 * sent to a server and the participant copies their own result code back.
 */

type Load =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; pack: StudyPack; session: Session };

export function StudyPage() {
  const { hash } = useLocation();
  const navigate = useNavigate();
  const [load, setLoad] = useState<Load>({ kind: 'loading' });

  // A research page must not be indexed, whatever robots.txt says.
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex';
    document.head.appendChild(meta);
    return () => { meta.remove(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const code = packCodeFromHash(hash);
      const stored = readSession();
      const source = code ?? stored?.code ?? null;
      if (source === null) {
        if (!cancelled) setLoad({ kind: 'none' });
        return;
      }
      const decoded = await decodePack(source);
      if (cancelled) return;
      if (!decoded.ok) {
        // A damaged saved session is dropped; a damaged *link* is reported.
        if (code === null) {
          clearSession();
          setLoad({ kind: 'none' });
        } else {
          setLoad({ kind: 'error', message: decoded.error });
        }
        return;
      }
      // The same link resumes; a different link is a different participant.
      const base = stored?.code === source ? stored : newSession(source, decoded.pack);
      const session = tick(base, Date.now());
      writeSession(session);
      setLoad({ kind: 'ready', pack: decoded.pack, session });
    })();
    return () => { cancelled = true; };
  }, [hash]);

  const shell = 'mx-auto w-full max-w-2xl p-6 sm:p-8';

  if (load.kind === 'loading') {
    return <div className={shell} aria-busy="true"><p className="text-body text-ink-dim">Loading your session…</p></div>;
  }

  if (load.kind === 'ready') {
    return (
      <div className={shell}>
        <Runner
          key={load.session.code}
          pack={load.pack}
          initial={load.session}
          onCleared={() => {
            setLoad({ kind: 'none' });
            void navigate('/study', { replace: true });
          }}
        />
      </div>
    );
  }

  return (
    <div className={shell}>
      <PageHeader eyebrow="Study session" title={load.kind === 'error' ? 'This link did not work' : 'Nothing to do here'}>
        {load.kind === 'error'
          ? load.message
          : 'This page runs a short research session for people who were sent a personal study link. If you have one, open it again — the link contains everything this page needs.'}
      </PageHeader>
      <p className="mt-6 text-label text-ink-dim">
        <Link to="/" className="underline underline-offset-2 hover:text-ink">Back to QueryLens</Link>
      </p>
    </div>
  );
}

function Prose({ text }: { text: string }) {
  return (
    <div className="space-y-3 text-body text-ink-dim">
      {parseBlocks(text).map((block, i) =>
        block.kind === 'heading' ? (
          <h3 key={i} className="pt-2 text-heading font-semibold text-ink">{block.text}</h3>
        ) : (
          <p key={i}><Inline text={block.text} /></p>
        ),
      )}
    </div>
  );
}

function Inline({ text }: { text: string }) {
  return (
    <>
      {parseInline(text).map((part, i) =>
        part.kind === 'strong' ? <strong key={i} className="font-semibold text-ink">{part.text}</strong>
        : part.kind === 'em' ? <em key={i}>{part.text}</em>
        : part.kind === 'code' ? <code key={i} className="rounded bg-surface-3 px-1 font-mono text-label text-ink">{part.text}</code>
        : <span key={i}>{part.text}</span>,
      )}
    </>
  );
}

function Timer({ label, seconds }: { label: string; seconds: number }) {
  return (
    <p className="text-label text-ink-dim">
      {label}:{' '}
      <span role="timer" aria-label={label} className="font-mono text-body tabular-nums text-ink">
        {formatClock(seconds)}
      </span>
    </p>
  );
}

function Runner({ pack, initial, onCleared }: { pack: StudyPack; initial: Session; onCleared: () => void }) {
  const [session, setSession] = useState<Session>(initial);
  const [now, setNow] = useState(() => Date.now());
  const [agreed, setAgreed] = useState(false);
  // plan.md §25.4 A6 — a separate, optional box; off unless the participant ticks it.
  const [perfChecked, setPerfChecked] = useState(false);

  // One wall-clock tick: the time left is always `start + allowance − now`, so
  // a throttled tab cannot stretch a session, and an expired test finishes here.
  useEffect(() => {
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t);
      setSession((s) => tick(s, t));
    }, 1000);
    return () => { window.clearInterval(id); };
  }, []);

  useEffect(() => { writeSession(session); }, [session]);

  // Compression is async, so the result code arrives a beat after `done`.
  //
  // plan.md §25.4 A6: the responsiveness timing is read here, once, when the
  // session has ended — then the measurement is switched off and its samples
  // deleted. It is held in a ref so a second run of this effect (StrictMode, or
  // the session changing before the code is ready) reuses the reading instead
  // of finding the samples already gone.
  const perfRef = useRef<PerfSummary | null>(null);
  useEffect(() => {
    if (session.phase !== 'done' || session.resultCode !== null) return;
    if (session.perfOptIn && perfRef.current === null) {
      perfRef.current = summarisePerf();
      clearPerf();
    }
    const result = toResult(session, BUILD_SHA, perfRef.current);
    if (!result) return;
    let cancelled = false;
    void encodeResult(result).then((code) => {
      if (!cancelled) setSession((s) => (s.resultCode === null ? { ...s, resultCode: code } : s));
    });
    return () => { cancelled = true; };
  }, [session]);

  const header = (title: string, lede?: string) => (
    <PageHeader eyebrow="Study session" title={title}>{lede}</PageHeader>
  );

  if (session.phase === 'consent') {
    return (
      <>
        {header('Before you begin')}
        <div className={`${card} mt-6 space-y-3 text-body text-ink-dim`}>
          {pack.consent.map((paragraph, i) => <p key={i}>{paragraph}</p>)}
        </div>
        <label className="mt-5 flex items-start gap-2.5 text-body text-ink">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => { setAgreed(e.target.checked); }}
            className="mt-1 size-4"
          />
          I have read this and I agree to take part.
        </label>
        <div className={`${card} mt-4 text-body text-ink-dim`}>
          <label className="flex items-start gap-2.5 text-ink">
            <input
              type="checkbox"
              checked={perfChecked}
              onChange={(e) => { setPerfChecked(e.target.checked); }}
              className="mt-1 size-4"
            />
            Optional: also record how responsive QueryLens feels on this device.
          </label>
          <p className="mt-2 text-label">
            While this session runs, your browser measures how long the app takes to respond to your clicks and taps
            (a standard measure called INP) — timings only, never your queries, answers or anything on the page. It
            is kept on this device and added to the result code you send back, with a rough description of the
            device: its number of processor cores, its screen width, and whether it has a touch screen. This page
            sends nothing. Leaving it unticked changes nothing else about your session.
          </p>
        </div>
        <div className="mt-5">
          <button
            type="button"
            className={btnPrimary}
            disabled={!agreed}
            onClick={() => {
              // The flag is what the app's other tabs (the lessons) read to start measuring.
              if (perfChecked) setOptIn(true);
              setSession((s) => agree(s, Date.now(), perfChecked));
            }}
          >
            Begin
          </button>
        </div>
      </>
    );
  }

  if (session.phase === 'material') {
    const left = materialLeft(session, now);
    const ready = canStartTest(session, now);
    return (
      <>
        {header(pack.material.title, pack.material.intro)}
        <div className="mt-5"><Timer label="Time with the material" seconds={left} /></div>

        {pack.arm === 'text' ? (
          <div className={`${card} mt-5`}><Prose text={pack.material.body} /></div>
        ) : (
          <ul className="mt-5 space-y-3">
            {pack.material.tasks.map((task) => (
              <li key={task.href}>
                <a
                  href={task.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={`${card} block text-body text-ink hover:border-accent/50`}
                >
                  {task.label} <span className="text-label text-ink-dim">(opens in a new tab)</span>
                </a>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-6 space-y-3">
          <p role="status" className="text-label text-ink-dim">
            {ready
              ? 'Time is up. Whenever you are ready, continue to the questions.'
              : 'You can continue to the questions when the time is up. Keep this tab open.'}
          </p>
          <button
            type="button"
            className={btnPrimary}
            disabled={!ready}
            onClick={() => { setSession((s) => startTest(s, Date.now())); }}
          >
            Continue to the questions
          </button>
        </div>
      </>
    );
  }

  if (session.phase === 'test') {
    const left = testLeft(session, now);
    return (
      <>
        {header('Questions', 'Answer in your own words, from what you remember. You cannot go back to the material.')}
        <div className="mt-5"><Timer label="Time left" seconds={left} /></div>
        <div className="mt-5 space-y-5">
          {pack.test.questions.map((q, i) => (
            <div key={q.id} className={`${card} space-y-3`}>
              <label htmlFor={`answer-${q.id}`} className="block text-heading font-semibold text-ink">
                Question {i + 1} — {q.title}
              </label>
              <div id={`prompt-${q.id}`}><Prose text={q.text} /></div>
              <textarea
                id={`answer-${q.id}`}
                aria-describedby={`prompt-${q.id}`}
                rows={5}
                maxLength={MAX_ANSWER}
                value={session.answers[q.id] ?? ''}
                onChange={(e) => { setSession((s) => setAnswer(s, q.id, e.target.value)); }}
                className={`${inputField} w-full`}
              />
            </div>
          ))}
        </div>
        <div className="mt-6">
          <button
            type="button"
            className={btnPrimary}
            onClick={() => { setSession((s) => finish(s, Date.now(), false)); }}
          >
            Finish
          </button>
        </div>
      </>
    );
  }

  const code = session.resultCode;
  return (
    <>
      {header(
        'Thank you',
        session.timedOut
          ? 'Time ran out, so your answers so far were saved. That is fine.'
          : 'Your answers are saved in this browser only.',
      )}
      <div className={`${card} mt-6 space-y-3`}>
        <p className="text-body text-ink-dim">
          Copy the code below and send it to the researcher who gave you the link — by message or email. It holds
          your answers and how long each part took
          {session.perfOptIn ? ', plus the responsiveness timing and device description you opted in to' : ''}, and
          nothing else. This page has not sent it anywhere.
        </p>
        {code === null ? (
          <p className="text-label text-ink-dim">Preparing your code…</p>
        ) : (
          <>
            <label htmlFor="result-code" className="block text-label font-medium text-ink">Your result code</label>
            <textarea
              id="result-code"
              readOnly
              rows={6}
              value={code}
              onFocus={(e) => { e.currentTarget.select(); }}
              className={`${inputField} w-full font-mono text-label`}
            />
            <div className="flex flex-wrap gap-2">
              <CopyButton text={code} label="Copy code" title="Copy your result code to the clipboard" />
              <a
                className={btnSecondary}
                download={`querylens-study-${session.pid}.txt`}
                href={`data:text/plain;charset=utf-8,${encodeURIComponent(code)}`}
              >
                Download as a file
              </a>
            </div>
          </>
        )}
      </div>
      <div className="mt-6">
        <button
          type="button"
          className={btnSecondary}
          onClick={() => {
            clearSession();
            clearPerf(); // belt and braces: the flag and samples are already gone once a session ends
            onCleared();
          }}
        >
          Clear this from my browser
        </button>
        <p className="mt-2 max-w-prose text-label text-ink-dim">
          Do this once you have sent your code. It deletes your session from this device; the code you copied is
          unaffected.
        </p>
      </div>
    </>
  );
}
