import { btnGhost, controlLabel, inputField } from '../primitives.ts';

export interface Scenario {
  id: string;
  /** A short name for the menu ("Lost update"). */
  title: string;
  /** One line on what it shows, under the menu. */
  blurb: string;
}

export interface ScenarioPickerProps {
  id: string;
  scenarios: readonly Scenario[];
  /** The loaded scenario, or null once the reader has edited away from every one ("Custom"). */
  value: string | null;
  onPick: (id: string) => void;
  label?: string;
}

const CUSTOM = '';

/**
 * A tool's worked examples as one control (§4.2), replacing a wall of preset buttons. A native select keeps the
 * menu accessible and phone-friendly; the chosen scenario's blurb sits under it, and ‹ › walk the list in order so a
 * lesson can be stepped through without reopening the menu.
 */
export function ScenarioPicker({ id, scenarios, value, onPick, label = 'Scenario' }: ScenarioPickerProps) {
  const at = scenarios.findIndex((s) => s.id === value);
  const chosen = at >= 0 ? scenarios[at] : undefined;
  const blurbId = `${id}-blurb`;
  const go = (delta: number) => {
    const from = at >= 0 ? at : delta > 0 ? -1 : scenarios.length;
    const next = scenarios[(from + delta + scenarios.length) % scenarios.length];
    if (next) onPick(next.id);
  };

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className={controlLabel}>
        {label}
      </label>
      <div className="flex min-w-0 items-center gap-1">
        <select
          id={id}
          value={chosen ? chosen.id : CUSTOM}
          onChange={(e) => { if (e.target.value !== CUSTOM) onPick(e.target.value); }}
          aria-describedby={blurbId}
          className={`${inputField} min-w-0 flex-1`}
        >
          {!chosen && (
            <option value={CUSTOM} disabled>
              Custom
            </option>
          )}
          {scenarios.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <button type="button" className={`${btnGhost} px-2!`} onClick={() => { go(-1); }} aria-label={`Previous ${label.toLowerCase()}`}>
          ‹
        </button>
        <button type="button" className={`${btnGhost} px-2!`} onClick={() => { go(1); }} aria-label={`Next ${label.toLowerCase()}`}>
          ›
        </button>
      </div>
      <p id={blurbId} className="text-label text-ink-dim">
        {chosen ? chosen.blurb : 'Your own setup. Pick a scenario to load a worked example.'}
      </p>
    </div>
  );
}
