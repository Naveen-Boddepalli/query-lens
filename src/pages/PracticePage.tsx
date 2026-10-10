import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageHeader } from '../ui/PageHeader.tsx';
import { btnGhost, btnPrimary, btnSecondary, card, panelSurface } from '../ui/primitives.ts';
import { SKILLS, generate } from '../ui/quiz/generators.ts';
import type { Question } from '../ui/quiz/generators.ts';
import {
  BOXES,
  clearDeck,
  dueSkills,
  emptyDeck,
  learningCurve,
  nextDueAt,
  nextSkill,
  readDeck,
  recordAnswer,
  writeDeck,
} from '../ui/quiz/leitner.ts';

/**
 * plan.md §25.4 G4: generated, graded questions and a Leitner schedule. Each question is made from a seed and its answer
 * computed by the engine it is about; a skill answered right moves up a box and comes back less often, one answered
 * wrong comes back at once. Kept in this browser only. It is an experiment — whether a schedule like this helps is not
 * known, and the page's own small measurement says so rather than claiming it.
 */

function PromptLines({ prompt }: { prompt: string }) {
  return (
    <div className="flex flex-col gap-1">
      {prompt.split('\n').map((line, i) => {
        const mono = /^[\d, ]+$/.test(line) || /^\d+\. /.test(line) || /^SELECT /.test(line);
        return (
          <p key={i} className={mono ? 'font-mono text-label text-ink' : 'text-body text-ink'}>
            {line}
          </p>
        );
      })}
    </div>
  );
}

function when(due: number, now: number): string {
  if (due <= now) return 'now';
  const hours = (due - now) / 3_600_000;
  if (hours < 1) return 'in under an hour';
  if (hours < 36) return `in ${String(Math.round(hours))} hours`;
  return `in ${String(Math.round(hours / 24))} days`;
}

export function PracticePage() {
  // What the deck says on arrival decides the first question, once.
  const [arrival] = useState(() => {
    const at = Date.now();
    const stored = readDeck(at);
    const first = nextSkill(stored, at, false);
    return { at, stored, question: first ? generate(first, Math.floor(Math.random() * 2_000_000_000)) : null };
  });
  const [deck, setDeck] = useState(arrival.stored);
  const [now, setNow] = useState(arrival.at);
  const [question, setQuestion] = useState<Question | null>(arrival.question);
  const [choice, setChoice] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [anyway, setAnyway] = useState(false);

  // A skill is chosen once per question, and its seed is fresh each time so that the same skill is a new instance.
  function ask(from: typeof deck, force: boolean) {
    const at = Date.now();
    setNow(at);
    const skill = nextSkill(from, at, force);
    if (!skill) {
      setQuestion(null);
      return;
    }
    setQuestion(generate(skill, Math.floor(Math.random() * 2_000_000_000)));
    setChoice(null);
    setChecked(false);
  }

  const due = useMemo(() => dueSkills(deck, now), [deck, now]);
  const curve = useMemo(() => learningCurve(deck), [deck]);
  const correct = checked && question !== null && choice === question.answer;
  const skill = question ? SKILLS.find((s) => s.id === question.skill) : undefined;
  const later = nextDueAt(deck, now);
  const total = SKILLS.reduce((n, s) => n + deck.skills[s.id].asked, 0);

  function check() {
    if (!question || choice === null) return;
    const next = recordAnswer(deck, question.skill, choice === question.answer, Date.now());
    setDeck(next);
    writeDeck(next);
    setChecked(true);
  }

  function reset() {
    clearDeck();
    const fresh = emptyDeck(Date.now());
    setDeck(fresh);
    setAnyway(false);
    ask(fresh, false);
  }

  const pct = (t: { asked: number; right: number }) => (t.asked === 0 ? '—' : `${String(Math.round((t.right / t.asked) * 100))}%`);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6 sm:p-8">
      <PageHeader title="Practice">
        Questions made fresh each time, each answered by the engine itself — the clock hand&rsquo;s real victim, the real
        planner&rsquo;s real choice, the recovery passes of a real script. A skill you get right comes back less often; one you
        get wrong comes back at once. Kept in this browser only, and not part of the{' '}
        <Link to="/progress" className="underline underline-offset-2 hover:text-ink">
          progress
        </Link>{' '}
        numbers.
      </PageHeader>

      <div className={`${panelSurface} p-4`}>
        {question ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!checked) check();
            }}
          >
            <fieldset className="flex flex-col gap-3">
              <legend className="mb-2 text-label font-medium text-ink-dim">
                {skill?.title} · {String(deck.skills[question.skill].box)} of {String(BOXES)} boxes
              </legend>
              <PromptLines prompt={question.prompt} />
              <div className="mt-1 flex flex-col gap-2" role="radiogroup" aria-label="Answer">
                {question.options.map((o) => {
                  const right = checked && o.id === question.answer;
                  const wrong = checked && o.id === choice && o.id !== question.answer;
                  return (
                    <label
                      key={o.id}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-body ${
                        right ? 'border-hit text-ink' : wrong ? 'border-evict text-ink' : 'border-edge text-ink'
                      } ${choice === o.id ? 'bg-surface-2' : ''}`}
                    >
                      <input
                        type="radio"
                        name="answer"
                        value={o.id}
                        checked={choice === o.id}
                        disabled={checked}
                        onChange={() => { setChoice(o.id); }}
                        className="accent-[var(--color-accent)]"
                      />
                      <span>{o.label}</span>
                      {right && <span className="ml-auto text-label text-hit">correct</span>}
                      {wrong && <span className="ml-auto text-label text-evict">your answer</span>}
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {/* One button, so that keyboard focus stays where it was when the answer is checked. */}
              <button
                type={checked ? 'button' : 'submit'}
                disabled={!checked && choice === null}
                onClick={checked ? () => { ask(deck, anyway); } : undefined}
                className={btnPrimary}
              >
                {checked ? 'Next question' : 'Check answer'}
              </button>
              {checked && question.link && (
                <Link to={question.link.to} className={btnSecondary}>
                  {question.link.label}
                </Link>
              )}
            </div>

            {checked && (
              <div className="mt-3 text-label" role="status">
                <p className={correct ? 'text-hit' : 'text-evict'}>
                  {correct ? 'Right.' : 'Not quite.'}{' '}
                  {correct
                    ? `${skill?.title} moves up to box ${String(deck.skills[question.skill].box)}.`
                    : `${skill?.title} goes back to box 1 and will come round again at once.`}
                </p>
                <p className="mt-1 text-ink-dim">{question.explanation}</p>
              </div>
            )}
          </form>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-body text-ink">Nothing is due. Every skill is resting in a higher box.</p>
            {later !== null && (
              <p className="text-label text-ink-dim">The next one is due {when(later, now)}.</p>
            )}
            <div>
              <button
                type="button"
                onClick={() => {
                  setAnyway(true);
                  ask(deck, true);
                }}
                className={btnSecondary}
              >
                Practise anyway
              </button>
            </div>
          </div>
        )}
      </div>

      <div className={card}>
        <h2 className="mb-2 text-body font-semibold text-ink">Where each skill stands</h2>
        {/* A scrollable region must be reachable from the keyboard, and a table of text has nothing focusable in it. */}
        {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex */}
        <div className="overflow-x-auto" role="region" aria-label="The skills and their boxes" tabIndex={0}>
          <table className="w-full min-w-[30rem] text-left text-label tabular-nums">
            <caption className="sr-only">Each skill, its Leitner box, when it is next due, and how often it was right</caption>
            <thead>
              <tr className="text-ink-dim">
                <th scope="col" className="pr-3 font-medium">Skill</th>
                <th scope="col" className="pr-3 font-medium">Box</th>
                <th scope="col" className="pr-3 font-medium">Due</th>
                <th scope="col" className="font-medium">Right</th>
              </tr>
            </thead>
            <tbody>
              {SKILLS.map((s) => {
                const st = deck.skills[s.id];
                return (
                  <tr key={s.id} className="text-ink">
                    <th scope="row" className="py-0.5 pr-3 text-left font-normal">
                      {s.title} <span className="text-ink-dim">— {s.about}</span>
                    </th>
                    <td className="pr-3">
                      {st.box} of {BOXES}
                    </td>
                    <td className="pr-3">{due.includes(s.id) ? 'now' : when(st.due, now)}</td>
                    <td>
                      {st.asked === 0 ? 'not asked' : `${String(st.right)} of ${String(st.asked)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className={card}>
        <h2 className="mb-1 text-body font-semibold text-ink">An experiment, and what it measures</h2>
        <p className="text-label text-ink-dim">
          Whether spacing questions like this helps anyone remember how the engine works is not known, and nothing here
          claims it. What the page can show you is its own small measurement, from your answers alone:
        </p>
        <p className="mt-2 text-label text-ink">
          Right the first time a skill was asked: <strong>{pct(curve.first)}</strong> ({curve.first.right} of{' '}
          {curve.first.asked}). Right on every later ask: <strong>{pct(curve.later)}</strong> ({curve.later.right} of{' '}
          {curve.later.asked}). {total} {total === 1 ? 'answer' : 'answers'} kept, up to the last 300.
        </p>
        <p className="mt-2 text-label text-ink-dim">
          The questions are generated, so none of them is the fixed set the project&rsquo;s own study asks — that set is
          never shown here.
        </p>
        <button type="button" onClick={reset} className={`mt-3 ${btnGhost}`}>
          Reset practice
        </button>
      </div>
    </div>
  );
}
