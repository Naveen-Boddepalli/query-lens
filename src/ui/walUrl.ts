/**
 * A write-ahead-log script as a share URL (plan.md §25.4 E1): the steps in order, as the same short text the page
 * shows (`set T1 a = 99`), in one JSON query parameter. Decoding is total — a pasted link is untrusted input — so
 * anything that is not a short list of well-formed steps decodes to nothing rather than throwing.
 */

import { MAX_WAL_STEPS, formatWalStep, parseWalStep } from '../engine/recovery/wal.ts';
import type { WalStep } from '../engine/recovery/wal.ts';

export function encodeWalSteps(steps: readonly WalStep[]): string {
  return JSON.stringify(steps.map(formatWalStep));
}

export function decodeWalSteps(raw: string | null): WalStep[] | null {
  if (raw === null || raw.length === 0 || raw.length > 4_000) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length > MAX_WAL_STEPS) return null;
  const steps: WalStep[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string' || item.length > 60) return null;
    const step = parseWalStep(item);
    if (!step) return null;
    steps.push(step);
  }
  return steps;
}
