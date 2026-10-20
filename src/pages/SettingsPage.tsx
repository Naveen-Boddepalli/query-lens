import { useState } from 'react';
import { REPLACEMENT_POLICY_LABELS, REPLACEMENT_POLICY_NAMES } from '../engine/types.ts';
import type { ReplacementPolicyName } from '../engine/index.ts';
import {
  readDefaultDetail,
  readDefaultPolicy,
  readDefaultPredictOn,
  writeDefaultDetail,
  writeDefaultPolicy,
  writeDefaultPredictOn,
} from '../ui/preferences.ts';
import { DETAIL_LABELS, DETAIL_LEVELS } from '../ui/detailLevel.ts';
import type { DetailLevel } from '../ui/detailLevel.ts';
import { PageHeader } from '../ui/PageHeader.tsx';
import { btnGhost, card, segBase, segOff, segOn } from '../ui/primitives.ts';

/**
 * plan.md §21.3. Small on purpose: the things worth defaulting are the
 * eviction policy, whether prediction is on, and how much the narration says
 * (plan.md §27.5 L2), because everything else
 * that could be a "setting" — theme, reduced motion — already has its own
 * control (the header toggle; the OS-level media query, respected directly).
 * A preference here never overrides a shareable link (§15.2): the link is
 * what reproduces a *moment*, and a stored default would silently break that
 * for anyone who set one and then opened someone else's link.
 */
export function SettingsPage() {
  const [policy, setPolicy] = useState<ReplacementPolicyName | 'default'>(
    () => readDefaultPolicy() ?? 'default',
  );
  const [predictOn, setPredictOn] = useState<'default' | 'on' | 'off'>(() => {
    const stored = readDefaultPredictOn();
    return stored === undefined ? 'default' : stored ? 'on' : 'off';
  });

  const [detail, setDetail] = useState<DetailLevel>(() => readDefaultDetail() ?? 'standard');

  function chooseDetail(next: DetailLevel) {
    setDetail(next);
    writeDefaultDetail(next);
  }

  function choosePolicy(next: ReplacementPolicyName | 'default') {
    setPolicy(next);
    writeDefaultPolicy(next === 'default' ? null : next);
  }

  function choosePredict(next: 'default' | 'on' | 'off') {
    setPredictOn(next);
    writeDefaultPredictOn(next === 'default' ? null : next === 'on');
  }

  return (
    <div className="mx-auto w-full max-w-2xl p-6 sm:p-8">
      <PageHeader title="Settings">
        Defaults for a bare visit to the Playground. A{' '}
        <a href="/docs/reference/url-parameters" className="underline underline-offset-2 hover:text-ink">
          shared link
        </a>{' '}
        always wins over these — that is what makes it reproduce the exact moment it points to.
      </PageHeader>

      <section className={`mt-8 mb-4 ${card}`}>
        <h3 className="mb-1 text-body font-semibold text-ink">Default eviction policy</h3>
        <p className="mb-3 text-label text-ink-dim">
          Which replacement policy the buffer pool uses when a query does not specify one.
        </p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Default eviction policy">
          {[
            { value: 'default' as const, label: 'Engine default (LRU)' },
            ...REPLACEMENT_POLICY_NAMES.map((name) => ({ value: name, label: REPLACEMENT_POLICY_LABELS[name] })),
          ].map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={policy === opt.value}
              onClick={() => { choosePolicy(opt.value); }}
              className={`${segBase} ${policy === opt.value ? segOn : segOff}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </section>

      <section className={`mb-6 ${card}`}>
        <h3 className="mb-1 text-body font-semibold text-ink">Predict-then-reveal</h3>
        <p className="mb-3 text-label text-ink-dim">
          Whether the Playground asks you to commit to an answer before revealing each step, by
          default.
        </p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Default predict-then-reveal">
          {(
            [
              { value: 'default', label: 'Engine default (on)' },
              { value: 'on', label: 'Always on' },
              { value: 'off', label: 'Always off' },
            ] as const
          ).map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={predictOn === opt.value}
              onClick={() => { choosePredict(opt.value); }}
              className={`${segBase} ${predictOn === opt.value ? segOn : segOff}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </section>

      <section className={`mb-6 ${card}`}>
        <h3 className="mb-1 text-body font-semibold text-ink">Narration detail</h3>
        <p className="mb-3 text-label text-ink-dim">
          How much each step of the trace tells you. Novice adds a sentence in plain words the first time each kind of
          step happens; expert gives a terse line of the step’s own numbers instead.
        </p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Default narration detail">
          {DETAIL_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              role="radio"
              aria-checked={detail === level}
              onClick={() => { chooseDetail(level); }}
              className={`${segBase} ${detail === level ? segOn : segOff}`}
            >
              {level === 'standard' ? 'Standard (default)' : DETAIL_LABELS[level]}
            </button>
          ))}
        </div>
      </section>

      <button
        type="button"
        onClick={() => { choosePolicy('default'); choosePredict('default'); chooseDetail('standard'); }}
        className={btnGhost}
      >
        Reset to engine defaults
      </button>
    </div>
  );
}
