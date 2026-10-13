import type { OutcomeTable } from '../outcome.ts';

/**
 * What the per-tool checkers in this folder have in common: the seed they all run under, the shape of what they read
 * and what they return, and the few formatters they share. No driver is imported here — the point of the split is that
 * a challenge loads its own tool's driver and no other.
 */

/** The seed every one of these runs under, and the tool's own default — so a link opens on the same numbers. */
export const SEED = 1;

/** What the form's controls read as: whole numbers, and the text of a choice. */
export type Values = Record<string, number | string>;

export interface Verdict {
  passed: boolean;
  facts: { label: string; value: string }[];
  tables?: OutcomeTable[];
  toolHref: string;
  /** Set when the settings were fine for the tool but not for the question: nothing to run. */
  problem?: string;
}

export type Checker = (values: Values) => Verdict;

/** A tool's checks, by challenge id. */
export type Checkers = Record<string, Checker>;

export const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
export const fixed = (x: number, d = 2): string => x.toFixed(d);
export const num = (v: Values, key: string): number => Number(v[key]);
export const str = (v: Values, key: string): string => String(v[key]);
