import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SchemaEditor } from '../SchemaEditor.tsx';
import type { Database } from '../../engine/index.ts';

const DB: Database = {
  tables: {
    authors: { name: 'authors', columns: ['id', 'name'], rows: [{ id: 1, name: 'ada' }], indexedColumn: 'id' },
    posts: { name: 'posts', columns: ['id', 'authorId'], rows: [{ id: 1, authorId: 1 }] },
  },
};

function setup(overrides: Partial<Parameters<typeof SchemaEditor>[0]> = {}) {
  const props = { db: DB, onApply: vi.fn(), onClose: vi.fn(), ...overrides };
  render(<SchemaEditor {...props} />);
  return { ...props, dialog: document.querySelector('dialog')! };
}

describe('SchemaEditor', () => {
  it('opens with showModal and lists every table', () => {
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    const { dialog } = setup();
    expect(showModal).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(true);
    expect(screen.getByText('authors')).toBeInTheDocument();
    expect(screen.getByText('posts')).toBeInTheDocument();
    expect(screen.getByText('2 tables')).toBeInTheDocument();
  });

  it('closes on Escape and reports it through onClose, without applying', () => {
    const { dialog, onClose, onApply } = setup();
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });
    expect(dialog.open).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('adds a well-formed table and shows it in the list, staged until Apply', () => {
    const { onApply } = setup();
    fireEvent.click(screen.getByRole('button', { name: '+ Add table' }));
    fireEvent.change(screen.getByPlaceholderText('reviews'), { target: { value: 'reviews' } });
    fireEvent.change(screen.getByPlaceholderText('id, rating, comment'), {
      target: { value: 'id, rating' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add table' }));

    expect(screen.getByText('reviews')).toBeInTheDocument();
    expect(screen.getByText('3 tables')).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Apply/ }));
    expect(onApply).toHaveBeenCalledWith({
      tables: {
        ...DB.tables,
        reviews: { name: 'reviews', columns: ['id', 'rating'], rows: [] },
      },
    });
  });

  it('declares an index on the new table when one is picked', () => {
    const { onApply } = setup();
    fireEvent.click(screen.getByRole('button', { name: '+ Add table' }));
    fireEvent.change(screen.getByPlaceholderText('reviews'), { target: { value: 'reviews' } });
    fireEvent.change(screen.getByPlaceholderText('id, rating, comment'), {
      target: { value: 'id, rating' },
    });
    fireEvent.change(screen.getByLabelText('Index'), { target: { value: 'id' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add table' }));
    fireEvent.click(screen.getByRole('button', { name: /Apply/ }));

    expect(onApply).toHaveBeenCalledWith({
      tables: {
        ...DB.tables,
        reviews: { name: 'reviews', columns: ['id', 'rating'], rows: [], indexedColumn: 'id' },
      },
    });
  });

  it('rejects a duplicate table name with a visible error, and does not add it', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: '+ Add table' }));
    fireEvent.change(screen.getByPlaceholderText('reviews'), { target: { value: 'authors' } });
    fireEvent.change(screen.getByPlaceholderText('id, rating, comment'), { target: { value: 'id' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add table' }));

    expect(screen.getByRole('alert')).toHaveTextContent(/already exists/);
    expect(screen.getByText('2 tables')).toBeInTheDocument();
  });

  it('removes a table from the staged copy', () => {
    const { onApply } = setup();
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    expect(screen.getByText('1 table')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Apply/ }));
    expect(onApply).toHaveBeenCalledWith({ tables: { posts: DB.tables.posts } });
  });

  it("opens a table's rows in a nested DataEditor with no Reset button, and merges an edit back in", () => {
    const { onApply } = setup();
    fireEvent.click(screen.getAllByRole('button', { name: 'Edit rows' })[0]!);

    const nested = screen.getByRole('dialog', { name: 'Edit seed data' });
    expect(within(nested).queryByRole('button', { name: /Reset to seed/ })).not.toBeInTheDocument();

    fireEvent.change(within(nested).getByLabelText('name row 1'), { target: { value: 'grace' } });
    fireEvent.click(within(nested).getByRole('button', { name: /Apply & re-run/ }));

    // Back at the table list, with the nested editor gone.
    expect(screen.queryByRole('dialog', { name: 'Edit seed data' })).not.toBeInTheDocument();

    const outer = screen.getByRole('dialog', { name: 'Manage tables' });
    fireEvent.click(within(outer).getByRole('button', { name: /Apply & re-run/ }));
    expect(onApply).toHaveBeenCalledWith({
      tables: { ...DB.tables, authors: { ...DB.tables.authors, rows: [{ id: 1, name: 'grace' }] } },
    });
  });
});
