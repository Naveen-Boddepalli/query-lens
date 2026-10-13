import { useEffect, useState } from 'react';
import { markSolved, readSolved } from '../../ui/challengeProgress.ts';
import { btnPrimary, inputField } from '../../ui/primitives.ts';
import { ChallengeHeader, ChallengeOutcomeView, SolvedPanel } from './ChallengeFrame.tsx';
import type { ChallengeOutcome } from './outcome.ts';
import type { SettingsChallenge } from './settingsChallenges.tsx';
import { loadCheckers, runSettings } from './settingsRunner.ts';

/**
 * One settings challenge (`settingsChallenges.tsx`): the same few numbers the tool takes, in a form, run on the
 * tool's own driver and checked. A form rather than a text box because there is nothing to write — every control is
 * a number with a range or a choice from a short list — and a label and a number input is what a keyboard and a
 * screen reader already know. The tool's own driver is fetched when the challenge opens (and again, from the cache,
 * on Run), so a sort challenge does not carry the isolation engines.
 */

export interface SettingsChallengeViewProps {
  challenge: SettingsChallenge;
  /** Zero-based place in the whole list of challenges, and how many there are. */
  index: number;
  total: number;
  next: { id: string; title: string } | null;
}

export function SettingsChallengeView({ challenge, index, total, next }: SettingsChallengeViewProps) {
  const [values, setValues] = useState<Record<string, string>>({ ...challenge.starter });
  const [run, setRun] = useState<ChallengeOutcome | null>(null);
  const [solved, setSolved] = useState(() => readSolved().has(challenge.id));
  const [busy, setBusy] = useState(false);

  // Fetch the tool's driver now, so that the first Run is not the one that waits for it. A failure here is silent:
  // Run asks again and says so in words if it still cannot.
  useEffect(() => {
    loadCheckers(challenge.tool).catch(() => undefined);
  }, [challenge.tool]);

  async function check() {
    if (busy) return;
    setBusy(true);
    try {
      const outcome = await runSettings(challenge, values);
      setRun(outcome);
      if (outcome.passed && !solved) {
        markSolved(challenge.id);
        setSolved(true);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl p-6 sm:p-8">
      <ChallengeHeader
        index={index}
        total={total}
        title={challenge.title}
        brief={challenge.brief}
        hint={challenge.hint}
      />

      {/* noValidate: a number out of range is reported in words, beside the result, not by the browser's own bubble. */}
      <form
        noValidate
        className="mt-4 space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void check();
        }}
      >
        <p className="text-label text-ink-dim">
          Needed: <span className="text-ink">{challenge.needs}</span>.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {challenge.controls.map((control) => {
            const id = `control-${control.key}`;
            const rangeId = `range-${control.key}`;
            const set = (value: string) => { setValues((prev) => ({ ...prev, [control.key]: value })); };
            const value = values[control.key] ?? '';
            if (control.kind === 'checks') {
              const on = new Set(value.split(',').filter((v) => v.length > 0));
              return (
                <fieldset key={control.key} className="flex flex-col gap-1 text-label text-ink-dim sm:col-span-2">
                  <legend className="mb-1">{control.label}</legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-1">
                    {control.options.map((o) => (
                      <label key={o.value} className="flex items-center gap-1.5 font-mono text-ink">
                        <input
                          type="checkbox"
                          checked={on.has(o.value)}
                          onChange={(e) => {
                            const next = new Set(on);
                            if (e.target.checked) next.add(o.value);
                            else next.delete(o.value);
                            set(control.options.filter((x) => next.has(x.value)).map((x) => x.value).join(','));
                          }}
                          className="accent-[var(--color-accent)]"
                        />
                        {o.label}
                      </label>
                    ))}
                  </div>
                </fieldset>
              );
            }
            return (
              <div
                key={control.key}
                className={`flex flex-col gap-1 text-label text-ink-dim ${control.kind === 'text' ? 'sm:col-span-2' : ''}`}
              >
                <label htmlFor={id}>{control.label}</label>
                {control.kind === 'select' ? (
                  <select id={id} value={value} onChange={(e) => { set(e.target.value); }} className={inputField}>
                    {control.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : control.kind === 'text' ? (
                  <input
                    id={id}
                    type="text"
                    value={value}
                    maxLength={control.max}
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(e) => { set(e.target.value); }}
                    className={`${inputField} font-mono`}
                  />
                ) : (
                  <>
                    {/* The range is a description of the input, not part of its name. */}
                    <input
                      id={id}
                      type="number"
                      inputMode="numeric"
                      min={control.min}
                      max={control.max}
                      value={value}
                      aria-describedby={rangeId}
                      onChange={(e) => { set(e.target.value); }}
                      className={`${inputField} tabular-nums`}
                    />
                    <span id={rangeId} className="text-ink-dim">
                      {control.min}–{control.max}
                    </span>
                  </>
                )}
              </div>
            );
          })}
        </div>
        <button type="submit" aria-disabled={busy} className={btnPrimary}>
          Run &amp; check
        </button>
      </form>

      <ChallengeOutcomeView outcome={run} notYet="compare the numbers with what is needed." />

      {solved && <SolvedPanel misconception={challenge.misconception} next={next} />}
    </div>
  );
}
