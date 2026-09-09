import type { PredictionPrompt } from '../engine/index.ts';

export interface StepAnnouncementInput {
  /** The current step's narration line (`ViewState.narration`). */
  narration: string;
  /** True when the query failed to run. */
  error?: boolean;
  /**
   * The prediction gating this step, if playback is held on one: the prompt,
   * plus the answer already committed — `undefined` unanswered, `''` skipped.
   */
  prediction?: { prompt: PredictionPrompt; answer: string | undefined } | undefined;
}

/**
 * plan.md §22.6: what a screen-reader user hears each time the trace moves. On
 * an ordinary step this is just the narration the event already carries; on a
 * gated step it is the prediction they are being asked to make, then the
 * verdict — the moment the visible narration `<p>` is covered by the prediction
 * card and so cannot speak for itself.
 *
 * Pure and total, so it is unit-tested rather than inferred from the DOM. The
 * caller prepends the step position (`Step N of M`) in a visually-hidden span.
 */
export function stepAnnouncement(input: StepAnnouncementInput): string {
  const { narration, error, prediction } = input;

  if (error) return "The query didn't run. Fix it in the editor and run again.";

  if (prediction) {
    const { prompt, answer } = prediction;
    if (answer === undefined) {
      const options = prompt.options.map((o) => o.label).join('; ');
      return `Predict before revealing. ${prompt.question} ${String(prompt.options.length)} options: ${options}.`;
    }
    if (answer === '') {
      return 'Prediction skipped. Press the right arrow to reveal the step.';
    }
    const verdict = answer === prompt.correctOptionId ? 'Correct.' : 'Not quite.';
    return `${verdict} ${prompt.explanation} Press the right arrow to continue.`;
  }

  return narration || 'Step forward to start the trace.';
}
