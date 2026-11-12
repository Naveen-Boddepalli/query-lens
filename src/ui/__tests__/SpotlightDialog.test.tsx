import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { SpotlightDialog } from '../SpotlightDialog.tsx';
import { openSpotlight, OPEN_SPOTLIGHT_EVENT } from '../spotlight.ts';
import { ThemeProvider } from '../ThemeContext.tsx';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function renderSpotlight(onClose = vi.fn()) {
  const result = render(
    <ThemeProvider>
      <MemoryRouter>
        <SpotlightDialog onClose={onClose} />
      </MemoryRouter>
    </ThemeProvider>,
  );
  return { ...result, onClose };
}

describe('Spotlight Search', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    vi.clearAllMocks();
  });

  describe('openSpotlight helper', () => {
    it('dispatches the OPEN_SPOTLIGHT_EVENT custom event on window', () => {
      const listener = vi.fn();
      window.addEventListener(OPEN_SPOTLIGHT_EVENT, listener);

      openSpotlight();

      expect(listener).toHaveBeenCalledOnce();
      window.removeEventListener(OPEN_SPOTLIGHT_EVENT, listener);
    });
  });

  describe('SpotlightDialog UI & Accessibility', () => {
    it('renders with accessible dialog, combobox, and listbox roles', () => {
      renderSpotlight();

      const dialog = screen.getByRole('dialog', { name: 'Search QueryLens' });
      expect(dialog).toBeInTheDocument();
      expect(dialog).toHaveAttribute('aria-modal', 'true');

      const input = screen.getByRole('combobox');
      expect(input).toBeInTheDocument();
      expect(input).toHaveAttribute('aria-autocomplete', 'list');

      const listbox = screen.getByRole('listbox', { name: 'Search results' });
      expect(listbox).toBeInTheDocument();
    });

    it('renders quick suggestion chips when query is empty', () => {
      renderSpotlight();

      expect(screen.getByRole('button', { name: 'B+Tree' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Buffer Pool' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Playground' })).toBeInTheDocument();
    });

    it('populates search query when a suggestion chip is clicked', () => {
      renderSpotlight();

      const btreeChip = screen.getByRole('button', { name: 'B+Tree' });
      fireEvent.click(btreeChip);

      const input = screen.getByRole('combobox');
      expect(input).toHaveValue('B+Tree');

      // Results should contain B+Tree visualizer
      expect(screen.getByText('B+Tree visualizer')).toBeInTheDocument();
    });

    it('calls onClose when close button is clicked', () => {
      const { onClose } = renderSpotlight();

      const closeBtn = screen.getByRole('button', { name: 'Close search' });
      fireEvent.click(closeBtn);

      expect(onClose).toHaveBeenCalledOnce();
    });

    it('calls onClose when Escape key is pressed', () => {
      const { onClose } = renderSpotlight();

      fireEvent.keyDown(window, { key: 'Escape' });

      expect(onClose).toHaveBeenCalledOnce();
    });
  });

  describe('Search & Filtering', () => {
    it('filters items in real time as user types', () => {
      renderSpotlight();

      const input = screen.getByRole('combobox');
      fireEvent.change(input, { target: { value: 'recovery' } });

      expect(screen.getByText('Crash recovery (ARIES)')).toBeInTheDocument();
      expect(screen.queryByText('SQL grammar diagrams')).not.toBeInTheDocument();
    });

    it('shows empty state when no results match', () => {
      renderSpotlight();

      const input = screen.getByRole('combobox');
      fireEvent.change(input, { target: { value: 'xyznonexistent123' } });

      expect(screen.getByText(/No results found for/)).toBeInTheDocument();
    });

    it('filters by category tabs (Tools, Stages, Docs)', () => {
      renderSpotlight();

      const toolsTab = screen.getByRole('button', { name: /Tools/ });
      fireEvent.click(toolsTab);

      // In Tools category tab, tools should be shown
      expect(screen.getByText('Buffer pool sandbox')).toBeInTheDocument();

      const stagesTab = screen.getByRole('button', { name: /Stages/ });
      fireEvent.click(stagesTab);

      // In Stages tab, stages should be shown
      expect(screen.getByText('Parser stage')).toBeInTheDocument();
      expect(screen.queryByText('Buffer pool sandbox')).not.toBeInTheDocument();
    });

    it('switches filter tab using keyboard shortcuts (Cmd+1..4)', () => {
      renderSpotlight();

      // Cmd+2 switches to Tools
      fireEvent.keyDown(window, { key: '2', metaKey: true });
      expect(screen.getByRole('button', { name: /Tools/ })).toHaveAttribute('aria-pressed', 'true');

      // Cmd+3 switches to Stages
      fireEvent.keyDown(window, { key: '3', metaKey: true });
      expect(screen.getByRole('button', { name: /Stages/ })).toHaveAttribute('aria-pressed', 'true');

      // Cmd+4 switches to Docs
      fireEvent.keyDown(window, { key: '4', metaKey: true });
      expect(screen.getByRole('button', { name: /Docs/ })).toHaveAttribute('aria-pressed', 'true');

      // Cmd+1 switches back to All
      fireEvent.keyDown(window, { key: '1', metaKey: true });
      expect(screen.getByRole('button', { name: /All/ })).toHaveAttribute('aria-pressed', 'true');
    });
  });

  describe('Keyboard Navigation & Execution', () => {
    it('moves selection with ArrowDown and ArrowUp', () => {
      renderSpotlight();

      const input = screen.getByRole('combobox');
      const options = screen.getAllByRole('option');
      expect(options[0]).toHaveAttribute('aria-selected', 'true');

      // Arrow down moves to next option
      fireEvent.keyDown(input, { key: 'ArrowDown' });
      expect(options[1]).toHaveAttribute('aria-selected', 'true');

      // Arrow up moves back
      fireEvent.keyDown(input, { key: 'ArrowUp' });
      expect(options[0]).toHaveAttribute('aria-selected', 'true');
    });

    it('navigates to selected item on Enter and closes dialog', () => {
      const { onClose } = renderSpotlight();

      const input = screen.getByRole('combobox');
      fireEvent.change(input, { target: { value: 'btree' } });

      fireEvent.keyDown(input, { key: 'Enter' });

      expect(mockNavigate).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledOnce();
    });

    it('executes theme toggle action when selected', () => {
      const { onClose } = renderSpotlight();

      const input = screen.getByRole('combobox');
      fireEvent.change(input, { target: { value: 'theme' } });

      const themeOption = screen.getByRole('option', { name: /mode/i });
      fireEvent.click(themeOption);

      expect(onClose).toHaveBeenCalledOnce();
    });
  });
});
