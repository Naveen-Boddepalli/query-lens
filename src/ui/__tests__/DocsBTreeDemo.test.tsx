import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BTreeMiniDemo } from '../DocsBTreeDemo.tsx';

describe('BTreeMiniDemo (plan.md §23.1 — interactive docs embed)', () => {
  it('renders with the default key search input initialized to 30', () => {
    render(<BTreeMiniDemo />);
    const input = screen.getByLabelText('Key to search for');
    expect(input).toBeInTheDocument();
    expect(input).toHaveValue('30');
    expect(screen.getByRole('button', { name: 'Find' })).toBeInTheDocument();
    expect(screen.getByText(/are in the tree — try one, or a key that isn't/)).toBeInTheDocument();
  });


  it('updates input and searches when the Find button is clicked', () => {
    render(<BTreeMiniDemo />);
    const input = screen.getByLabelText('Key to search for');
    fireEvent.change(input, { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(input).toHaveValue('20');
  });

  it('executes search on Enter keypress in the input', () => {
    render(<BTreeMiniDemo />);
    const input = screen.getByLabelText('Key to search for');
    fireEvent.change(input, { target: { value: '45' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input).toHaveValue('45');
  });

  it('handles searching for keys not present in the tree', () => {
    render(<BTreeMiniDemo />);
    const input = screen.getByLabelText('Key to search for');
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(input).toHaveValue('99');
  });

  it('handles invalid / non-integer input gracefully', () => {
    render(<BTreeMiniDemo />);
    const input = screen.getByLabelText('Key to search for');
    fireEvent.change(input, { target: { value: 'not-a-number' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    expect(input).toHaveValue('not-a-number');
  });
});

