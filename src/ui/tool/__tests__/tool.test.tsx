import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Playback } from '../../usePlayback.ts';
import {
  CommandBar,
  ControlGroup,
  ControlRow,
  Inspector,
  MetricStrip,
  ResponsiveTable,
  ScenarioPicker,
  Segmented,
  StagePanel,
  Stepper,
  Switch,
  ToolHeader,
  ToolSection,
  ToolShell,
  Transport,
  hintIdFor,
} from '../index.ts';

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

/** Makes `matchMedia` report a wide (≥1024px) or narrow screen for the components that read it. */
function screenIs(wide: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: wide,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

describe('Segmented', () => {
  const OPTIONS = [
    { value: 'lru', label: 'LRU' },
    { value: 'clock', label: 'Clock' },
    { value: 'fifo', label: 'FIFO', disabled: true },
    { value: 'opt', label: 'OPT' },
  ] as const;
  type Policy = (typeof OPTIONS)[number]['value'];

  function Harness({ initial = 'lru' as Policy }) {
    const [value, setValue] = useState<Policy>(initial);
    return <Segmented label="Policy" value={value} onChange={setValue} options={OPTIONS} />;
  }

  it('is a radio group with one tab stop, on the chosen option', () => {
    render(<Harness initial="clock" />);
    const group = screen.getByRole('radiogroup', { name: 'Policy' });
    const radios = within(group).getAllByRole('radio');
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, 0, -1, -1]);
    expect(screen.getByRole('radio', { name: 'Clock' })).toHaveAttribute('aria-checked', 'true');
  });

  it('moves and chooses with the arrows, skipping a disabled option and wrapping', () => {
    render(<Harness initial="clock" />);
    fireEvent.keyDown(screen.getByRole('radio', { name: 'Clock' }), { key: 'ArrowRight' });
    const opt = screen.getByRole('radio', { name: 'OPT' });
    expect(opt).toHaveAttribute('aria-checked', 'true');
    expect(opt).toHaveFocus();
    fireEvent.keyDown(opt, { key: 'ArrowRight' });
    expect(screen.getByRole('radio', { name: 'LRU' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(screen.getByRole('radio', { name: 'LRU' }), { key: 'End' });
    expect(screen.getByRole('radio', { name: 'OPT' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(screen.getByRole('radio', { name: 'OPT' }), { key: 'Home' });
    expect(screen.getByRole('radio', { name: 'LRU' })).toHaveAttribute('aria-checked', 'true');
  });

  it('chooses on click', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('radio', { name: 'OPT' }));
    expect(screen.getByRole('radio', { name: 'OPT' })).toHaveAttribute('aria-checked', 'true');
  });
});

describe('Stepper', () => {
  function Harness() {
    const [n, setN] = useState(3);
    return <Stepper id="frames" value={n} onChange={setN} min={1} max={4} unit="frames" />;
  }

  it('steps within its range and disables the button at each end', () => {
    render(<Harness />);
    const more = screen.getByRole('button', { name: 'More frames' });
    fireEvent.click(more);
    expect(screen.getByRole('spinbutton')).toHaveValue(4);
    expect(more).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Fewer frames' }));
    expect(screen.getByRole('spinbutton')).toHaveValue(3);
  });

  it('clamps a typed value and ignores a blank one', () => {
    render(<Harness />);
    const field = screen.getByRole('spinbutton');
    fireEvent.change(field, { target: { value: '99' } });
    expect(field).toHaveValue(4);
    fireEvent.change(field, { target: { value: '' } });
    expect(field).toHaveValue(4);
  });
});

describe('Switch', () => {
  it('is a switch whose label states the rule, and toggles', () => {
    function Harness() {
      const [on, setOn] = useState(true);
      return <Switch checked={on} onChange={setOn} label="Write the log before the page" />;
    }
    render(<Harness />);
    const sw = screen.getByRole('switch', { name: 'Write the log before the page' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    expect(sw).toHaveAttribute('aria-checked', 'false');
  });
});

describe('ScenarioPicker', () => {
  const SCENARIOS = [
    { id: 'a', title: 'Lost update', blurb: 'Two writers, one wins.' },
    { id: 'b', title: 'Dirty read', blurb: 'A reader sees an uncommitted write.' },
  ];

  it('shows the chosen scenario with its blurb, and walks the list with the arrows', () => {
    const onPick = vi.fn();
    render(<ScenarioPicker id="sc" scenarios={SCENARIOS} value="b" onPick={onPick} />);
    const select = screen.getByRole('combobox', { name: 'Scenario' });
    expect(select).toHaveValue('b');
    expect(select).toHaveAccessibleDescription('A reader sees an uncommitted write.');
    fireEvent.click(screen.getByRole('button', { name: 'Next scenario' }));
    expect(onPick).toHaveBeenLastCalledWith('a');
    fireEvent.click(screen.getByRole('button', { name: 'Previous scenario' }));
    expect(onPick).toHaveBeenLastCalledWith('a');
  });

  it('reads "Custom" once the setup matches no scenario', () => {
    const onPick = vi.fn();
    render(<ScenarioPicker id="sc" scenarios={SCENARIOS} value={null} onPick={onPick} />);
    expect(screen.getByRole('combobox')).toHaveDisplayValue('Custom');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } });
    expect(onPick).toHaveBeenCalledWith('b');
    fireEvent.click(screen.getByRole('button', { name: 'Next scenario' }));
    expect(onPick).toHaveBeenLastCalledWith('a');
  });
});

describe('CommandBar', () => {
  it('renders exactly one primary, critical actions in their own style, and an overflow menu', () => {
    const crash = vi.fn();
    const clear = vi.fn();
    render(
      <CommandBar
        primary={{ label: 'Insert', onClick: () => {} }}
        secondary={[{ label: 'Delete', onClick: () => {} }, { label: 'Find', onClick: () => {} }]}
        critical={[{ label: 'Crash', onClick: crash }]}
        overflow={[{ label: 'Clear the log', onClick: clear }]}
      >
        <input aria-label="Key" />
      </CommandBar>,
    );
    const bar = screen.getByRole('group', { name: 'Operations' });
    expect(bar.querySelectorAll('.ql-fill-accent')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Insert' })).toHaveClass('ql-fill-accent');
    expect(screen.getByRole('button', { name: 'Crash' })).toHaveClass('text-evict');
    fireEvent.click(screen.getByRole('button', { name: 'Crash' }));
    expect(crash).toHaveBeenCalledOnce();

    const menu = bar.querySelector('details')!;
    menu.open = true;
    fireEvent.click(screen.getByRole('button', { name: 'Clear the log' }));
    expect(clear).toHaveBeenCalledOnce();
    expect(menu.open).toBe(false);
  });

  it('closes the overflow menu on Escape and on a press elsewhere', () => {
    render(<CommandBar overflow={[{ label: 'Reset', onClick: () => {} }]} />);
    const menu = document.querySelector('details')!;
    menu.open = true;
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(menu.open).toBe(false);
    menu.open = true;
    fireEvent.pointerDown(document.body);
    expect(menu.open).toBe(false);
  });
});

describe('ControlRow and ControlGroup', () => {
  it('labels its control and gives the hint the id the control points at', () => {
    render(
      <ControlGroup legend="Pool">
        <ControlRow label="Frames" htmlFor="frames" hint="Linear hashing only">
          <input id="frames" aria-describedby={hintIdFor('frames')} />
        </ControlRow>
      </ControlGroup>,
    );
    expect(screen.getByRole('group', { name: 'Pool' })).toBeInTheDocument();
    const field = screen.getByLabelText('Frames');
    expect(field).toHaveAccessibleDescription('Linear hashing only');
  });

  it('names a non-labelable control through labelId', () => {
    render(
      <ControlRow label="Policy" labelId="policy-label">
        <Segmented labelledBy="policy-label" value="a" onChange={() => {}} options={[{ value: 'a', label: 'A' }]} />
      </ControlRow>,
    );
    expect(screen.getByRole('radiogroup', { name: 'Policy' })).toBeInTheDocument();
  });

  it('collapses an advanced group behind its legend and count', () => {
    render(
      <ControlGroup legend="Advanced" advanced count={2}>
        <input aria-label="Seed" />
      </ControlGroup>,
    );
    const details = screen.getByText('Advanced').closest('details')!;
    expect(details.open).toBe(false);
    expect(details).toHaveTextContent('(2)');
  });
});

describe('Inspector', () => {
  it('is a sticky side rail on a wide screen', () => {
    screenIs(true);
    render(<Inspector summary="LRU · 4 frames"><input aria-label="Frames" /></Inspector>);
    const rail = screen.getByRole('complementary', { name: 'Settings' });
    expect(rail).toHaveClass('sticky');
    expect(within(rail).getByLabelText('Frames')).toBeVisible();
  });

  it('is a collapsed summary bar below lg, so a phone sees the output first', () => {
    screenIs(false);
    render(<Inspector summary="LRU · 4 frames"><input aria-label="Frames" /></Inspector>);
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    const details = screen.getByText('LRU · 4 frames').closest('details')!;
    expect(details.open).toBe(false);
    expect(screen.getAllByLabelText('Frames')).toHaveLength(1);
  });
});

describe('ToolHeader', () => {
  const renderHeader = () =>
    render(
      <MemoryRouter>
        <ToolHeader id="buffer-pool" title="Buffer pool sandbox" summary="Watch a policy evict." about={<p>Long story.</p>} />
      </MemoryRouter>,
    );

  it('breadcrumbs back to the Tools index', () => {
    renderHeader();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumbs' });
    expect(within(crumbs).getByRole('link', { name: 'Tools' })).toHaveAttribute('href', '/tools');
  });

  it('opens About on the first visit and keeps it collapsed after', () => {
    const first = renderHeader();
    expect(screen.getByText('About this tool').closest('details')!.open).toBe(true);
    first.unmount();
    renderHeader();
    expect(screen.getByText('About this tool').closest('details')!.open).toBe(false);
  });

  it('still opens About when storage is blocked', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    renderHeader();
    expect(screen.getByText('About this tool').closest('details')!.open).toBe(true);
  });
});

describe('ToolShell and its regions', () => {
  it('sets the family stage colour and announces the narration', () => {
    const { container } = render(
      <ToolShell category="storage" header={<h2>Tool</h2>} stage={<div>stage</div>} narration="Page 3 misses." />,
    );
    const shell = container.querySelector('[data-tool-shell]') as HTMLElement;
    expect(shell.style.getPropertyValue('--stage')).toBe('var(--color-stage-buffer)');
    expect(screen.getByRole('status')).toHaveTextContent('Page 3 misses.');
  });

  it('puts the stage panel under its title, with a view switch in the header', () => {
    const onView = vi.fn();
    render(
      <StagePanel
        title="Frames"
        views={[{ value: 'diagram', label: 'Diagram' }, { value: 'table', label: 'Table' }]}
        view="diagram"
        onView={onView}
      >
        <svg />
      </StagePanel>,
    );
    expect(screen.getByRole('region', { name: 'Frames' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Table' }));
    expect(onView).toHaveBeenCalledWith('table');
  });

  it('reads metrics as a description list', () => {
    render(<MetricStrip items={[{ label: 'Hit ratio', value: '40%', tone: 'hit' }, { label: 'Evictions', value: 3 }]} />);
    const list = screen.getByLabelText('Readout');
    expect(within(list).getAllByRole('term').map((t) => t.textContent)).toEqual(['Hit ratio', 'Evictions']);
    expect(within(list).getByText('40%')).toHaveClass('text-hit!');
  });

  it('names a deep-dive section by its title and keeps its own controls in the header', () => {
    render(
      <ToolSection title="Speedup" controls={<button type="button">Workers</button>}>
        <ResponsiveTable label="Speedup by workers">
          <table><tbody><tr><td>1</td></tr></tbody></table>
        </ResponsiveTable>
      </ToolSection>,
    );
    const section = screen.getByRole('region', { name: 'Speedup' });
    expect(within(section).getByRole('button', { name: 'Workers' })).toBeInTheDocument();
    expect(within(section).getByRole('region', { name: 'Speedup by workers' })).toHaveClass('ql-sticky-first');
  });
});

describe('Transport', () => {
  const playback = (step: number): Playback => ({
    step,
    playing: false,
    speed: 1,
    atStart: step === 0,
    atEnd: false,
    blocked: false,
    play: vi.fn(),
    pause: vi.fn(),
    toggle: vi.fn(),
    stepForward: vi.fn(),
    stepBack: vi.fn(),
    reset: vi.fn(),
    seek: vi.fn(),
    land: vi.fn(),
    setSpeed: vi.fn(),
  });
  const PHASES = [{ label: 'Analysis', step: 0 }, { label: 'Redo', step: 4 }, { label: 'Undo', step: 9 }];

  it('marks the phase the current step is in, and a chip jumps to its start', () => {
    const pb = playback(6);
    render(<Transport playback={pb} length={12} phases={PHASES} />);
    expect(screen.getByRole('button', { name: 'Redo' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(pb.seek).toHaveBeenCalledWith(9);
  });
});
