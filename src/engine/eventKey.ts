/**
 * Every step event as a **key** and the **params** its structured body already holds — `buffer.miss {page: 20}`,
 * `optimize.index-selection {…}` — for plan.md §27.5 L2's detail levels, and the half of §25.4 H5's event-label
 * refactor that L2 shares. They are derived here, from the body, rather than added at each of the engine's emit sites,
 * so no event can be missing one and none can disagree with the event it describes. The English `label` stays the
 * narration; a key is what a variant of it is looked up by — a detail level now, a locale if H5 ever lands.
 *
 * What a key cannot carry is whatever a label says beyond its event's body: the separators a traverse compared, the
 * rows a scan has rejected so far. A line built from `params` alone therefore never claims more than the event
 * recorded — and a locale (H5) would need those extra params added where the label is written.
 */

import type { PlanNode, SqlValue, StepEvent, WhyNot } from './types.ts';

export type EventParams = Record<string, string | number | boolean>;

export interface EventKey {
  /** `stage`, then the action, rule or operator that distinguishes one kind of step from another in that stage. */
  key: string;
  params: EventParams;
}

/** A plan as one line, root first: `Project [name] ← Sort [name ASC] ← SeqScan users`; two inputs in brackets. */
export function planLine(node: PlanNode): string {
  const self = node.detail ? `${node.label} [${node.detail}]` : node.label;
  const kids = node.children ?? [];
  if (kids.length === 0) return self;
  if (kids.length === 1) return `${self} ← ${planLine(kids[0]!)}`;
  return `${self} ← (${kids.map(planLine).join(', ')})`;
}

const keyParam = (key: SqlValue | undefined): EventParams => (key === undefined ? {} : { key: key === null ? 'NULL' : key });

const whyNotParams = (w: WhyNot | undefined): EventParams =>
  w ? { chosen: w.chosen.label, chosenPages: w.chosen.estPages, runnerUp: w.runnerUp.label, runnerUpPages: w.runnerUp.estPages } : {};

export function eventKey(e: StepEvent): EventKey {
  switch (e.stage) {
    case 'parse':
      return { key: 'parse', params: e.span ? { from: e.span.from, to: e.span.to } : {} };
    case 'plan':
      return {
        key: 'plan',
        params: { plan: planLine(e.planTree), ...(e.planTree.estRows === undefined ? {} : { estRows: e.planTree.estRows }), ...whyNotParams(e.whyNot) },
      };
    case 'optimize':
      return {
        key: `optimize.${e.rule}`,
        params: { rule: e.rule, plan: planLine(e.after), ...(e.after.estRows === undefined ? {} : { estRows: e.after.estRows }), ...whyNotParams(e.whyNot) },
      };
    case 'execute':
      return { key: `execute.${e.op}`, params: { op: e.op, rows: e.rowsProduced, ...(e.table === undefined ? {} : { table: e.table }) } };
    case 'buffer':
      switch (e.action) {
        case 'miss':
          return { key: 'buffer.miss', params: { page: e.pageId } };
        case 'evict':
          return {
            key: 'buffer.evict',
            params: {
              frame: e.frameId,
              victim: e.victimPageId,
              page: e.pageId,
              ...(e.clockHand === undefined ? {} : { hand: e.clockHand }),
              ...(e.writtenBack ? { writtenBack: true } : {}),
              ...(e.ring ? { ring: true } : {}),
            },
          };
        case 'sweep':
          return { key: 'buffer.sweep', params: { frame: e.frameId, usage: e.usageCountAfter, hand: e.clockHand } };
        case 'log':
        case 'flush':
          return { key: `buffer.${e.action}`, params: { page: e.pageId, lsn: e.lsn } };
        default:
          return { key: `buffer.${e.action}`, params: { page: e.pageId, frame: e.frameId } };
      }
    case 'index':
      switch (e.action) {
        case 'open':
          return { key: 'index.open', params: { node: e.nodeId, height: e.height } };
        case 'traverse':
          return { key: 'index.traverse', params: { node: e.nodeId, ...keyParam(e.key), ...(e.childIndex === undefined ? {} : { child: e.childIndex }) } };
        case 'chain-next':
          return { key: 'index.chain-next', params: { from: e.fromNodeId, to: e.toNodeId } };
        default:
          return { key: `index.${e.action}`, params: { node: e.nodeId, ...keyParam(e.key) } };
      }
    case 'lock':
      return { key: `lock.${e.action}`, params: { page: e.pageId, mode: e.mode } };
    case 'result':
      return { key: 'result', params: { rows: e.rows.length } };
  }
}
