/** plan.md §27.5 L2 — every step event as a key and the params its body holds (the half of §25.4 H5 L2 shares). */

import { describe, expect, it } from 'vitest';
import { eventKey, planLine } from '../eventKey.ts';
import { DATASETS, DEFAULT_ENGINE_OPTIONS, runQuery } from '../index.ts';
import type { PlanNode, StepEvent, StepEventBody } from '../types.ts';

const ev = (body: StepEventBody): StepEvent => ({ id: 0, label: 'a label', ...body });
const scan: PlanNode = { id: 's', op: 'SeqScan', label: 'SeqScan users', detail: 'filter: age > 30', estRows: 37 };

describe('eventKey (plan.md §27.5 L2)', () => {
  it('names each kind of step by its stage and what distinguishes it, with the body’s own fields as params', () => {
    expect(eventKey(ev({ stage: 'parse', ast: { id: 'a', kind: 'select', label: 'SELECT' }, span: { from: 7, to: 8 } }))).toEqual({ key: 'parse', params: { from: 7, to: 8 } });
    expect(eventKey(ev({ stage: 'parse', ast: { id: 'a', kind: 'select', label: 'SELECT' } }))).toEqual({ key: 'parse', params: {} });
    expect(eventKey(ev({ stage: 'plan', planTree: scan }))).toEqual({ key: 'plan', params: { plan: 'SeqScan users [filter: age > 30]', estRows: 37 } });
    expect(
      eventKey(ev({ stage: 'optimize', rule: 'index-selection', before: scan, after: scan, whyNot: { chosen: { label: 'an index', estPages: 4 }, runnerUp: { label: 'a scan', estPages: 12 } } })),
    ).toEqual({ key: 'optimize.index-selection', params: { rule: 'index-selection', plan: 'SeqScan users [filter: age > 30]', estRows: 37, chosen: 'an index', chosenPages: 4, runnerUp: 'a scan', runnerUpPages: 12 } });
    expect(eventKey(ev({ stage: 'execute', op: 'SeqScan', rowsProduced: 3, table: 'users' }))).toEqual({ key: 'execute.SeqScan', params: { op: 'SeqScan', rows: 3, table: 'users' } });
    expect(eventKey(ev({ stage: 'execute', op: 'Project', rowsProduced: 1 }))).toEqual({ key: 'execute.Project', params: { op: 'Project', rows: 1 } });
    expect(eventKey(ev({ stage: 'buffer', action: 'hit', pageId: 4, frameId: 2 }))).toEqual({ key: 'buffer.hit', params: { page: 4, frame: 2 } });
    expect(eventKey(ev({ stage: 'buffer', action: 'miss', pageId: 4 }))).toEqual({ key: 'buffer.miss', params: { page: 4 } });
    expect(eventKey(ev({ stage: 'buffer', action: 'write', pageId: 34, frameId: 1 }))).toEqual({ key: 'buffer.write', params: { page: 34, frame: 1 } });
    expect(eventKey(ev({ stage: 'buffer', action: 'evict', frameId: 0, victimPageId: 3, pageId: 8, clockHand: 1, writtenBack: true }))).toEqual({
      key: 'buffer.evict',
      params: { frame: 0, victim: 3, page: 8, hand: 1, writtenBack: true },
    });
    expect(eventKey(ev({ stage: 'buffer', action: 'evict', frameId: 0, victimPageId: 3, pageId: 8, ring: true }))).toEqual({ key: 'buffer.evict', params: { frame: 0, victim: 3, page: 8, ring: true } });
    expect(eventKey(ev({ stage: 'buffer', action: 'sweep', frameId: 2, usageCountAfter: 0, clockHand: 3 }))).toEqual({ key: 'buffer.sweep', params: { frame: 2, usage: 0, hand: 3 } });
    expect(eventKey(ev({ stage: 'index', action: 'open', tree: { id: 'n1', kind: 'leaf', label: '', pageId: 1 }, nodeId: 'n1', height: 3 }))).toEqual({ key: 'index.open', params: { node: 'n1', height: 3 } });
    expect(eventKey(ev({ stage: 'index', action: 'traverse', nodeId: 'n8', key: 5, childIndex: 0 }))).toEqual({ key: 'index.traverse', params: { node: 'n8', key: 5, child: 0 } });
    expect(eventKey(ev({ stage: 'index', action: 'not-found', nodeId: 'n1', key: null }))).toEqual({ key: 'index.not-found', params: { node: 'n1', key: 'NULL' } });
    expect(eventKey(ev({ stage: 'index', action: 'chain-next', fromNodeId: 'n1', toNodeId: 'n2' }))).toEqual({ key: 'index.chain-next', params: { from: 'n1', to: 'n2' } });
    expect(eventKey(ev({ stage: 'lock', action: 'acquire', pageId: 20, mode: 'exclusive' }))).toEqual({ key: 'lock.acquire', params: { page: 20, mode: 'exclusive' } });
    expect(eventKey(ev({ stage: 'result', rows: [{ a: 1 }, { a: 2 }] }))).toEqual({ key: 'result', params: { rows: 2 } });
  });

  it('writes a plan on one line, root first, a join’s two inputs in brackets', () => {
    const join: PlanNode = {
      id: 'j',
      op: 'Join',
      label: 'Join (hash) customers × orders',
      children: [
        { id: 'a', op: 'SeqScan', label: 'SeqScan customers' },
        { id: 'b', op: 'SeqScan', label: 'SeqScan orders' },
      ],
    };
    expect(planLine({ id: 'p', op: 'Project', label: 'Project', detail: 'name', children: [join] })).toBe('Project [name] ← Join (hash) customers × orders ← (SeqScan customers, SeqScan orders)');
  });

  it('keys every event of a real trace under its own stage', () => {
    const r = runQuery('SELECT name FROM users WHERE age > 30 ORDER BY name LIMIT 3', DATASETS.users.make(), DEFAULT_ENGINE_OPTIONS);
    for (const e of r.events) {
      const { key, params } = eventKey(e);
      expect(key.split('.')[0]).toBe(e.stage);
      for (const v of Object.values(params)) expect(['string', 'number', 'boolean']).toContain(typeof v);
    }
  });
});
