import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DataEditor } from '../DataEditor.tsx';
import type { Table } from '../../engine/index.ts';

const TABLE: Table = {
  name: 'users',
  columns: ['id', 'name', 'age'],
  indexedColumns: ['id'],
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

  describe('undo/redo', () => {
    it('starts with both disabled — nothing to undo or redo yet', () => {
      setup();
      expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
    });

    it('undoes a row edit back to the previous value, and redo restores it', () => {
      const { onApply } = setup();
      fireEvent.change(screen.getByLabelText('age row 1'), { target: { value: '99' } });
      expect(screen.getByRole('button', { name: 'Undo' })).not.toBeDisabled();

      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Redo' })).not.toBeDisabled();

      fireEvent.click(screen.getByRole('button', { name: 'Apply & re-run' }));
      expect(onApply).toHaveBeenCalledWith([
        { id: 1, name: 'ada', age: 36 },
        { id: 2, name: 'alan', age: 41 },
      ]);
    });

    it('redo replays the undone edit', () => {
      const { onApply } = setup();
      fireEvent.change(screen.getByLabelText('age row 1'), { target: { value: '99' } });
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      fireEvent.click(screen.getByRole('button', { name: 'Redo' }));
      expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();

      fireEvent.click(screen.getByRole('button', { name: 'Apply & re-run' }));
      expect(onApply).toHaveBeenCalledWith([
        { id: 1, name: 'ada', age: 99 },
        { id: 2, name: 'alan', age: 41 },
      ]);
    });

    it('coalesces repeated keystrokes into the same cell into one undo step', () => {
      setup();
      const input = screen.getByLabelText('name row 1');
      fireEvent.change(input, { target: { value: 'a' } });
      fireEvent.change(input, { target: { value: 'ad' } });
      fireEvent.change(input, { target: { value: 'ada!' } });

      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(screen.getByLabelText('name row 1')).toHaveValue('ada');
      expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    });

    it('a new edit clears the redo stack', () => {
      setup();
      fireEvent.change(screen.getByLabelText('age row 1'), { target: { value: '99' } });
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(screen.getByRole('button', { name: 'Redo' })).not.toBeDisabled();

      fireEvent.change(screen.getByLabelText('name row 2'), { target: { value: 'grace' } });
      expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();
    });

    it('undoes adding a row', () => {
      setup();
      fireEvent.click(screen.getByRole('button', { name: '+ Add row' }));
      expect(screen.getAllByLabelText(/^id row/)).toHaveLength(3);

      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(screen.getAllByLabelText(/^id row/)).toHaveLength(2);
    });

    it('undoes removing a row', () => {
      setup();
      fireEvent.click(screen.getByRole('button', { name: 'Delete row 1' }));
      expect(screen.getAllByLabelText(/^id row/)).toHaveLength(1);

      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
      expect(screen.getAllByLabelText(/^id row/)).toHaveLength(2);
      expect(screen.getByLabelText('id row 1')).toHaveValue('1');
    });
  });
});
