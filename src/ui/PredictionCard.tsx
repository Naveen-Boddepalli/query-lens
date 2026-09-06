import { useState } from 'react';
import type { PredictionPrompt } from '../engine/index.ts';

export interface PredictionCardProps {
  prompt: PredictionPrompt;
  /** The answer already given, if this prompt has been answered. */
  answer: string | undefined;
  onAnswer: (optionId: string) => void;
  onSkip: () => void;
}

/**
 * Commit before the reveal. This is the one feature RESEARCH.md §1 argues the
 * evidence actually supports: a wrong guess you have committed to teaches more
 * than a correct animation you watched.
 */
export function PredictionCard({ prompt, answer, onAnswer, onSkip }: PredictionCardProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const answered = answer !== undefined;
  const correct = answer === prompt.correctOptionId;

  return (
    <section
      aria-live="polite"
      className="ql-sheen rounded-xl border border-accent/50 bg-accent/[0.07] p-3 shadow-e2"
    >
      <div className="mb-2 flex items-baseline gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/60 bg-accent-soft px-2.5 py-0.5 text-label font-medium tracking-[0.12em] text-accent uppercase">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-accent-strong shadow-[0_0_8px_var(--color-accent)]" />
          predict
        </span>
        {!answered && (
          <button
            type="button"
            onClick={onSkip}
            className="ml-auto text-label text-ink-dim underline-offset-2 hover:text-ink hover:underline"
          >
            skip
          </button>
        )}
      </div>

      <p className="text-body leading-relaxed">{prompt.question}</p>

      <ul className="mt-3 space-y-1.5">
        {prompt.options.map((option) => {
          const isCorrect = option.id === prompt.correctOptionId;
          const isChosen = option.id === answer;

          let tone = 'border-edge bg-surface-3 shadow-e1 hover:border-accent/70 hover:bg-surface-4';
          if (answered) {
            if (isCorrect) tone = 'border-hit bg-hit/15 text-hit shadow-e1';
            else if (isChosen) tone = 'border-evict bg-evict/15 text-evict shadow-e1';
            else tone = 'border-edge/50 bg-transparent text-ink-dim/60';
          }

          return (
            <li key={option.id}>
              <button
                type="button"
                disabled={answered}
                onClick={() => { onAnswer(option.id); }}
                onMouseEnter={() => { setHovered(option.id); }}
                onMouseLeave={() => { setHovered(null); }}
                className={[
                  'w-full rounded-lg border px-2.5 py-1.5 text-left font-mono text-label transition',
                  tone,
                  !answered && hovered === option.id ? 'bg-surface-4' : '',
                  answered ? 'cursor-default' : 'cursor-pointer',
                ].join(' ')}
              >
                <span className="flex items-baseline justify-between gap-2">
                  <span>{option.label}</span>
                  {answered && isCorrect && <span aria-hidden>✓</span>}
                  {answered && isChosen && !isCorrect && <span aria-hidden>✗</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {answered && (
        <div className="mt-3 space-y-1.5">
          <p className={`text-label font-medium ${correct ? 'text-hit' : 'text-evict'}`}>
            {correct ? 'Right.' : 'Not quite.'}
          </p>
          <p className="text-label leading-relaxed text-ink-dim">{prompt.explanation}</p>
          <p className="text-label text-ink-dim/80">
            Press <kbd className="rounded border border-edge px-1">→</kbd> to see it happen.
          </p>
        </div>
      )}
    </section>
  );
}
