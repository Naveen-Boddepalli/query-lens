import { useState } from 'react';
import { markSolved, readSolved } from '../../ui/challengeProgress.ts';
import { btnPrimary, inputField } from '../../ui/primitives.ts';
import { ChallengeHeader, ChallengeOutcomeView, SolvedPanel } from './ChallengeFrame.tsx';
import type { ChallengeOutcome } from './outcome.ts';
import type { SettingsChallenge } from './settingsChallenges.tsx';
import { runSettings } from './settingsRunner.ts';

/**
 * One settings challenge (`settingsChallenges.tsx`): the same few numbers the tool takes, in a form, run on the
 * tool's own driver and checked. A form rather than a text box because there is nothing to write — every control is
 * a number with a range or a choice from a short list — and a label and a number input is what a keyboard and a
 * screen reader already know. The loaded chunk is the drivers, which is why this view is opened lazily.
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

  function check() {
    const outcome = runSettings(challenge, values);
    setRun(outcome);
    if (outcome.passed && !solved) {
      markSolved(challenge.id);
      setSolved(true);
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
          check();
        }}
      >
        <p className="text-label text-ink-dim">
          Needed: <span className="text-ink">{challenge.needs}</span>.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {challenge.controls.map((control) => {
            // The range is a description of the input, not part of its name.
            const rangeId = `range-${control.key}`;
            return (
              <div key={control.key} className="flex flex-col gap-1 text-label text-ink-dim">
                <label htmlFor={`control-${control.key}`}>{control.label}</label>
                {control.kind === 'select' ? (
                  <select
                    id={`control-${control.key}`}
                    value={values[control.key] ?? ''}
                    onChange={(e) => { setValues((prev) => ({ ...prev, [control.key]: e.target.value })); }}
                    className={inputField}
                  >
                    {control.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <>
                    <input
                      id={`control-${control.key}`}
                      type="number"
                      inputMode="numeric"
                      min={control.min}
                      max={control.max}
                      value={values[control.key] ?? ''}
                      aria-describedby={rangeId}
                      onChange={(e) => { setValues((prev) => ({ ...prev, [control.key]: e.target.value })); }}
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
        <button type="submit" className={btnPrimary}>
          Run &amp; check
        </button>
      </form>

      <ChallengeOutcomeView outcome={run} notYet="compare the numbers with what is needed." />

      {solved && <SolvedPanel misconception={challenge.misconception} next={next} />}
    </div>
  );
}
