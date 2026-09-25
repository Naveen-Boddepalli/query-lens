import { describe, expect, it } from 'vitest';
import { BUILD_SHA, newFormIssueUrl, REPO_URL } from '../../buildInfo.ts';
import { formatMoment, MAX_REPORT_URL, stepReportUrl } from '../stepReport.ts';
import type { Moment } from '../stepReport.ts';

const moment = (over: Partial<Moment> = {}): Moment => ({
  sql: 'SELECT * FROM users WHERE id = 5',
  policy: 'clock',
  predictOn: true,
  step: 7,
  stepCount: 33,
  stage: 'buffer',
  narration: 'Page 3 is not in the pool — a miss, so the engine reads it from disk.',
  dataset: 'users',
  rowsEdited: false,
  shareUrl: 'https://example.test/playground?q=SELECT+*+FROM+users+WHERE+id+%3D+5&p=clock&x=1&s=7',
  ...over,
});

const fields = (url: string) => new URL(url).searchParams;

describe('newFormIssueUrl', () => {
  it('names the template and fills each field by id, and omits an empty title', () => {
    const url = new URL(newFormIssueUrl('confusing_step.yml', '', { moment: 'hello' }));
    expect(url.origin + url.pathname).toBe(`${REPO_URL}/issues/new`);
    expect(url.searchParams.get('template')).toBe('confusing_step.yml');
    expect(url.searchParams.get('moment')).toBe('hello');
    expect(url.searchParams.has('title')).toBe(false);
  });
});

describe('formatMoment', () => {
  it('carries the build, the step, the stage, the narration, the query and a link that reopens it', () => {
    const text = formatMoment(moment());
    expect(text).toContain('step 7 of 33');
    expect(text).toContain('stage `buffer`');
    expect(text).toContain(BUILD_SHA);
    expect(text).toContain('clock sweep policy');
    expect(text).toContain('predictions on');
    expect(text).toContain('> Page 3 is not in the pool');
    expect(text).toContain('```sql\nSELECT * FROM users WHERE id = 5\n```');
    expect(text).toContain('https://example.test/playground?q=');
  });

  it('says so before the first step, and when there is nothing to quote', () => {
    const text = formatMoment(moment({ step: 0, stage: null, narration: '   ' }));
    expect(text).toContain('before the first step');
    expect(text).toContain('_(nothing yet)_');
  });

  it('flattens a multi-line narration so the quote stays one blockquote line', () => {
    expect(formatMoment(moment({ narration: 'one\n\n two' }))).toContain('> one two');
  });

  it('flags edited data', () => {
    expect(formatMoment(moment({ rowsEdited: true, dataset: 'a custom database' }))).toContain('edited data (a custom database)');
  });

  it('can say the link was shortened, or left out', () => {
    expect(formatMoment(moment(), 'no-data')).toContain('the rows are not');
    expect(formatMoment(moment(), 'none')).toContain('Copy link');
    expect(formatMoment(moment(), 'none')).not.toContain('https://example.test');
  });
});

describe('stepReportUrl', () => {
  it('opens the confusing_step form with a title naming the stage and the narration, and the moment prefilled', () => {
    const params = fields(stepReportUrl(moment()));
    expect(params.get('template')).toBe('confusing_step.yml');
    expect(params.get('title')).toMatch(/^Confusing step: buffer — Page 3 is not in the pool/);
    expect(params.get('moment')).toContain('step 7 of 33');
  });

  it('truncates a long narration in the title, not in the body', () => {
    const long = 'word '.repeat(60).trim();
    const params = fields(stepReportUrl(moment({ narration: long })));
    expect(params.get('title')!.length).toBeLessThan(90);
    expect(params.get('title')).toMatch(/…$/);
    expect(params.get('moment')).toContain(long);
  });

  it('stays under the URL limit and falls back to a link without the edited rows', () => {
    const big = `https://example.test/playground?q=x&s=7&d=${'9'.repeat(7000)}`;
    const url = stepReportUrl(moment({ shareUrl: big, rowsEdited: true }));
    expect(url.length).toBeLessThanOrEqual(MAX_REPORT_URL);
    const body = fields(url).get('moment')!;
    expect(body).toContain('https://example.test/playground?q=x&s=7');
    expect(body).not.toContain('d=999');
    expect(body).toContain('the rows are not');
  });

  it('drops the link, keeping step, narration and build, when even that is too long', () => {
    const huge = `https://example.test/playground?q=${'x'.repeat(9000)}`;
    const url = stepReportUrl(moment({ shareUrl: huge }));
    expect(url.length).toBeLessThanOrEqual(MAX_REPORT_URL);
    const body = fields(url).get('moment')!;
    expect(body).not.toContain('xxxxxxxx');
    expect(body).toContain('step 7 of 33');
    expect(body).toContain('Page 3 is not in the pool');
    expect(body).toContain(BUILD_SHA);
  });

  it('survives a query too large to quote at all', () => {
    const url = stepReportUrl(moment({ sql: `SELECT ${'a, '.repeat(4000)}a FROM users`, shareUrl: 'https://example.test/p?q=x' }));
    expect(url.length).toBeLessThanOrEqual(MAX_REPORT_URL);
    expect(fields(url).get('moment')).toContain('step 7 of 33');
  });
});
