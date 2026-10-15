import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import indexHtml from '../../../index.html?raw';
import { DEFAULT_TITLE, titleFor } from '../documentTitle.ts';
import { PageHeader } from '../PageHeader.tsx';

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('titleFor', () => {
  it('names the page, then the site, for a top-level route', () => {
    expect(titleFor('Compare', '/compare')).toBe('Compare · QueryLens');
    expect(titleFor('Tools', '/tools')).toBe('Tools · QueryLens');
  });

  it('puts the section between them one level down, by the nav’s own label', () => {
    expect(titleFor('Crash recovery', '/tools/recovery')).toBe('Crash recovery · Tools · QueryLens');
    expect(titleFor('FAQ', '/docs/faq')).toBe('FAQ · Docs · QueryLens');
    expect(titleFor('Supported SQL', '/docs/reference/sql/')).toBe('Supported SQL · Docs · QueryLens');
    expect(titleFor('Parser', '/stages/parse')).toBe('Parser · Stages · QueryLens');
  });

  it('adds no section for a path whose first part is not in the nav', () => {
    expect(titleFor('Create an assignment', '/assignments/new')).toBe('Create an assignment · QueryLens');
  });
});

describe('the default title', () => {
  it('is index.html’s own <title> and og:title, so the landing page does not change what loaded', () => {
    expect(indexHtml).toContain(`<title>${DEFAULT_TITLE}</title>`);
    expect(indexHtml).toContain(`<meta property="og:title" content="${DEFAULT_TITLE}" />`);
  });
});

describe('PageHeader', () => {
  it('names the tab from its heading, under the section of the address it is on', () => {
    window.history.replaceState(null, '', '/tools/wal');
    render(<PageHeader title="Write-ahead log" />);
    expect(document.title).toBe('Write-ahead log · Tools · QueryLens');
  });

  it('takes a separate tab name where the heading should not be one, and follows a change to it', () => {
    window.history.replaceState(null, '', '/study');
    const { rerender } = render(<PageHeader title="This link did not work" documentTitle="Study session" />);
    expect(document.title).toBe('Study session · QueryLens');
    rerender(<PageHeader title="This link did not work" documentTitle="Study done" />);
    expect(document.title).toBe('Study done · QueryLens');
  });
});
