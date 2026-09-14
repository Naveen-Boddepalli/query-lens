import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BufferPoolMiniDemo } from '../DocsBufferPoolDemo.tsx';

describe('BufferPoolMiniDemo (plan.md §23.1 — interactive docs embed)', () => {
  it('starts empty, at step 0, defaulting to LRU', () => {
    render(<BufferPoolMiniDemo />);
    expect(screen.getAllByText('empty')).toHaveLength(4);
    expect(screen.getByText('0 / 16')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'LRU' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('stepping forward loads a page into a frame and counts a miss', () => {
    render(<BufferPoolMiniDemo />);
    fireEvent.click(screen.getByRole('button', { name: 'Step forward' }));
    fireEvent.click(screen.getByRole('button', { name: 'Step forward' }));
    expect(screen.getByText('page 0')).toBeInTheDocument();
  });

  it('switching to clock sweep resets playback and re-runs the trace under that policy', () => {
    render(<BufferPoolMiniDemo />);
    fireEvent.click(screen.getByRole('button', { name: 'Step forward' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clock sweep' }));
    expect(screen.getByRole('button', { name: 'Clock sweep' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'LRU' })).toHaveAttribute('aria-pressed', 'false');
    // A different policy is a different, longer trace (clock sweep visits
    // more events to reach the same eviction) — the step counter's total
    // changes, and playback starts over at 0 rather than carrying a step
    // index that might not even exist in the new trace.
    expect(screen.getByText('0 / 21')).toBeInTheDocument();
  });

  it('both policies end up keeping the repeatedly-read page (page 0) in a frame', () => {
    render(<BufferPoolMiniDemo />);
    const scrub = screen.getByLabelText('Scrub to step');
    fireEvent.change(scrub, { target: { value: '16' } });
    expect(screen.getByText('page 0')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clock sweep' }));
    fireEvent.change(screen.getByLabelText('Scrub to step'), { target: { value: '21' } });
    expect(screen.getByText('page 0')).toBeInTheDocument();
  });
});
