import { useState } from 'react';
import type { PredictionPrompt } from '../engine/index.ts';
import { CONFIDENCE_LABELS, CONFIDENCE_LEVELS } from './progress.ts';
import type { Confidence } from './progress.ts';

export interface PredictionCardProps {
  prompt: PredictionPrompt;
  answer: string | undefined;
  onAnswer: (optionId: string, confidence: Confidence | undefined) => void;
  onSkip: () => void;
  canSkip?: boolean;
}

const Icon = ({ ok }: { ok: boolean }) => (
  <span aria-hidden="true" className={`text-label font-bold ${ok ? 'text-hit' : 'text-evict'}`}>
    {ok ? '✓' : '✗'}
  </span>
);

const card = 'rounded-xl border border-edge bg-surface-2/80 shadow-neu-rest backdrop-blur-md';
const kbdCls = 'rounded border border-edge bg-surface-3 px-1.5 py-0.5 font-mono text-micro text-ink shadow-neu-rest';

export function PredictionCard({
  prompt,
  answer,
  onAnswer,
  onSkip,
  canSkip = true,
}: PredictionCardProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [confidence, setConfidence] = useState<Confidence | undefined>(undefined);
  const answered = answer !== undefined;
  const correct = answer === prompt.correctOptionId;

  return (
    <section className={`ql-sheen p-4 ${card}`}>
      <div className="mb-2.5 flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/60 bg-accent-soft px-3 py-0.5 text-micro font-semibold tracking-[0.14em] text-accent uppercase shadow-glow">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent-strong shadow-glow animate-pulse" />
          predict
        </span>
        {!answered && canSkip && (
          <button
            type="button"
            onClick={onSkip}
            className="ml-auto text-label text-ink-dim underline-offset-2 transition-colors hover:text-ink hover:underline"
          >
            skip
          </button>
        )}
        {!answered && !canSkip && (
          <span className="ml-auto text-label text-ink-dim/80">answer to continue</span>
        )}
      </div>

      <p className="text-body font-medium leading-relaxed text-ink">{prompt.question}</p>

      {!answered && (
        <div role="group" aria-label="How sure are you?" className="mt-3 flex flex-wrap items-center gap-1.5">
          <span className="text-label text-ink-dim">How sure?</span>
          {CONFIDENCE_LEVELS.map((level) => (
            <button
              key={level}
              type="button"
              aria-pressed={confidence === level}
              onClick={() => { setConfidence(confidence === level ? undefined : level); }}
              className={[
                'rounded-full border px-2.5 py-0.5 text-label transition',
                confidence === level
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-edge text-ink-dim hover:border-accent/70 hover:text-ink',
              ].join(' ')}
            >
              {CONFIDENCE_LABELS[level]}
            </button>
          ))}
        </div>
      )}

      <ul className="mt-3.5 space-y-1.5">
        {prompt.options.map((option) => {
          const isCorrect = option.id === prompt.correctOptionId;
          const isChosen = option.id === answer;

          let tone = 'border-edge bg-surface-3 hover:border-accent/70 hover:bg-surface-4';
          if (answered) {
            tone = isCorrect
              ? 'border-hit bg-hit/15 text-hit'
              : isChosen
                ? 'border-evict bg-evict/15 text-evict'
                : 'border-edge/50 bg-transparent text-ink-dim/60';
          }

          return (
            <li key={option.id}>
              <button
                type="button"
                disabled={answered}
                onClick={() => { onAnswer(option.id, confidence); }}
                onMouseEnter={() => { setHovered(option.id); }}
                onMouseLeave={() => { setHovered(null); }}
                className={`flex w-full items-center justify-between gap-3 rounded-lg border px-2.5 py-1.5 text-left font-mono text-label transition select-none shadow-e1 ${tone} ${
                  !answered && hovered === option.id ? 'bg-surface-4' : ''
                } ${answered ? 'cursor-default' : 'cursor-pointer active:scale-[0.99] active:shadow-neu-pressed'}`}
              >
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className={`h-2 w-2 rounded-full transition-colors ${
                      answered
                        ? isCorrect ? 'bg-hit' : isChosen ? 'bg-evict' : 'bg-transparent'
                        : hovered === option.id ? 'bg-accent' : 'bg-edge'
                    }`}
                  />
                  <span>{option.label}</span>
                </span>
                {answered && (isCorrect || isChosen) && <Icon ok={isCorrect} />}
              </button>
            </li>
          );
        })}
      </ul>

      {answered && (
        <div className={`mt-3 space-y-1.5 p-3 ${card}`}>
          <p className={`text-label font-semibold ${correct ? 'text-hit' : 'text-evict'}`}>
            {correct ? 'Right.' : 'Not quite.'}
            {confidence && <span className="font-normal text-ink-dim"> You were {CONFIDENCE_LABELS[confidence].toLowerCase()}.</span>}
          </p>
          <p className="text-label leading-relaxed text-ink-dim">{prompt.explanation}</p>
          <p className="text-label text-ink-dim/80">
            Press <kbd className={kbdCls}>Right</kbd> to see it happen.
          </p>
        </div>
      )}
    </section>
  );
}
