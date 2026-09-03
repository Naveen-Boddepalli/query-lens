import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from '../ErrorBoundary.tsx';
import { formatReport, publishRepro } from '../errorReport.ts';

function Boom(): never {
  throw new Error('the buffer pool renderer exploded');
}

describe('ErrorBoundary', () => {
  beforeEach(() => {
    // React logs every caught error itself; the boundary logs the report. Both
    // are wanted in production and neither is wanted in the test output.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    publishRepro({
      sql: 'SELECT * FROM users WHERE id = 5;',
      policy: 'clock',
      step: 13,
      predictOn: true,
      rows: [{ id: 1, name: 'ada', age: 36 }],
      rowsEdited: true,
    });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  it('renders a fallback instead of unmounting the tree', () => {
    render(
      <ErrorBoundary variant="panel" label="Buffer Pool">
        <Boom />
      </ErrorBoundary>,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('The Buffer Pool view hit a bug');
    expect(alert).toHaveTextContent('the buffer pool renderer exploded');
  });

  it('shows the repro on screen, not only behind the copy button', () => {
    render(
      <ErrorBoundary variant="page">
        <Boom />
      </ErrorBoundary>,
    );

    // A Copy that silently failed still has to leave the user something to
    // select, which is why this is asserted against the visible text.
    const report = screen.getByRole('alert').textContent ?? '';
    expect(report).toContain('SELECT * FROM users WHERE id = 5;');
    expect(report).toContain('"policy": "clock"');
    expect(report).toContain('"step": 13');
    expect(report).toContain('Build:');

    expect(screen.getByRole('button', { name: 'Copy report' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open an issue' })).toHaveAttribute(
      'href',
      expect.stringContaining('github.com'),
    );
  });

  it('renders children untouched when nothing throws', () => {
    render(
      <ErrorBoundary variant="panel">
        <p>the trace</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('the trace')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('omits unedited seed rows from the report but keeps edited ones', () => {
    publishRepro({
      sql: 'SELECT * FROM users;',
      policy: 'lru',
      step: 0,
      predictOn: false,
      rows: [{ id: 1, name: 'ada', age: 36 }],
      rowsEdited: false,
    });
    expect(formatReport(new Error('x'))).toContain('(unedited seed data)');

    publishRepro({
      sql: 'SELECT * FROM users;',
      policy: 'lru',
      step: 0,
      predictOn: false,
      rows: [{ id: 9, name: 'grace', age: 45 }],
      rowsEdited: true,
    });
    expect(formatReport(new Error('x'))).toContain('grace');
  });
});
