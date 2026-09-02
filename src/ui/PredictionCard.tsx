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
      className="rounded-lg border border-accent/60 bg-accent/5 p-3"
    >
      <div className="mb-2 flex items-baseline gap-2">
        <span className="rounded-full border border-accent/60 px-2 py-0.5 text-[10px] tracking-wide text-accent uppercase">
          predict
        </span>
        {!answered && (
          <button
            type="button"
            onClick={onSkip}
            className="ml-auto text-[11px] text-ink-dim underline-offset-2 hover:underline"
          >
            skip
          </button>
        )}
      </div>

      <p className="text-sm leading-relaxed">{prompt.question}</p>

      <ul className="mt-2.5 space-y-1.5">
        {prompt.options.map((option) => {
          const isCorrect = option.id === prompt.correctOptionId;
          const isChosen = option.id === answer;

          let tone = 'border-edge bg-surface-3 hover:border-accent/70';
          if (answered) {
            if (isCorrect) tone = 'border-hit bg-hit/15 text-hit';
            else if (isChosen) tone = 'border-evict bg-evict/15 text-evict';
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
                  'w-full rounded-md border px-2.5 py-1.5 text-left font-mono text-xs transition-colors',
                  tone,
                  !answered && hovered === option.id ? 'bg-surface-3' : '',
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
        <div className="mt-2.5 space-y-1.5">
          <p className={`text-xs font-medium ${correct ? 'text-hit' : 'text-evict'}`}>
            {correct ? 'Right.' : 'Not quite.'}
          </p>
          <p className="text-xs leading-relaxed text-ink-dim">{prompt.explanation}</p>
          <p className="text-[11px] text-ink-dim/80">
            Press <kbd className="rounded border border-edge px-1">→</kbd> to see it happen.
          </p>
        </div>
      )}
    </section>
  );
}
