import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DataEditor } from '../DataEditor.tsx';
import type { Table } from '../../engine/index.ts';

const TABLE: Table = {
  name: 'users',
  columns: ['id', 'name', 'age'],
  indexedColumn: 'id',
  rows: [
    { id: 1, name: 'ada', age: 36 },
    { id: 2, name: 'alan', age: 41 },
  ],
};

function setup(overrides: Partial<Parameters<typeof DataEditor>[0]> = {}) {
  const props = {
    table: TABLE,
    onApply: vi.fn(),
    onReset: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<DataEditor {...props} />);
  return { ...props, dialog: document.querySelector('dialog')! };
}

describe('DataEditor', () => {
  // plan.md §15.1 item 3 — the three defects the hand-rolled overlay had:
  // focus never entered, Escape did not close, Tab reached the background.
  it('opens with showModal, not show', () => {
    // The distinction is the whole fix: `show` leaves the page behind
    // focusable and Escape inert. Focus containment, the top layer and
    // focus restoration all follow from choosing the modal call.
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    const show = vi.spyOn(HTMLDialogElement.prototype, 'show');
    const { dialog } = setup();

    expect(showModal).toHaveBeenCalledOnce();
    expect(show).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);
  });

  it('closes on Escape, and nothing in the tree swallows the key', () => {
    const { dialog, onClose } = setup();
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
    expect(dialog.open).toBe(false);
    expect(onClose).toHaveBeenCalled();
  });

  it('closes when the backdrop is clicked, but not the dialog body', () => {
    const { dialog, onClose } = setup();
    fireEvent.click(screen.getByRole('button', { name: '+ Add row' }));
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('reports the close through onClose however it was dismissed', () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('applies edited rows and preserves each column type', () => {
    const { onApply } = setup();
    fireEvent.change(screen.getByLabelText('age row 1'), { target: { value: '99' } });
    fireEvent.change(screen.getByLabelText('name row 2'), { target: { value: 'grace' } });
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }));

    expect(onApply).toHaveBeenCalledWith([
      // "99" typed into a number column stays a number; a string stays a string.
      { id: 1, name: 'ada', age: 99 },
      { id: 2, name: 'grace', age: 41 },
    ]);
  });
});
