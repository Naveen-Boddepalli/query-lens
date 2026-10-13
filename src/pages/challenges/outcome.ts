/**
 * What running a challenge hands back to the page, whatever the challenge is about (a schedule, a log script, a
 * setting of a tool): a verdict, a few labelled numbers, some tables, and a link to the tool that shows it in full.
 * A type module only, so that the views and the runners that are loaded lazily can share it without sharing code.
 */

export interface OutcomeTable {
  caption: string;
  columns: string[];
  rows: string[][];
}

export interface ChallengeOutcome {
  /** Why nothing could be run: a line that is not a step, a setting out of range. */
  problem: string | null;
  passed: boolean;
  /** A few numbers about the run, labelled — what the page shows beside the verdict. */
  facts: { label: string; value: string }[];
  tables: OutcomeTable[];
  /** The tool that shows this very run in full. */
  toolHref: string | null;
}
