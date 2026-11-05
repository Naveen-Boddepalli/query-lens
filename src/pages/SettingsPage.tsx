import { useState } from 'react';
import { REPLACEMENT_POLICY_LABELS, REPLACEMENT_POLICY_NAMES } from '../engine/types.ts';
import type { ReplacementPolicyName } from '../engine/index.ts';
import {
  readDefaultPolicy,
  readDefaultPredictOn,
  writeDefaultPolicy,
  writeDefaultPredictOn,
} from '../ui/preferences.ts';
import { useThemeContext } from '../ui/ThemeContext.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';
import { btnGhost, card, segBase, segOff, segOn, segmentedTrack } from '../ui/primitives.ts';

const SPEED_KEY = 'querylens:default-speed';

function readDefaultSpeed(): string {
  try {
    return localStorage.getItem(SPEED_KEY) ?? 'default';
  } catch {
    return 'default';
  }
}

function writeDefaultSpeed(speed: string | null): void {
  try {
    if (speed === null || speed === 'default') localStorage.removeItem(SPEED_KEY);
    else localStorage.setItem(SPEED_KEY, speed);
  } catch {
    // Session-only fallback
  }
}

interface SectionProps<T extends string> {
  title: string;
  desc: string;
  label: string;
  value: T;
  onChange: (val: T) => void;
  options: readonly (readonly [T, string])[];
}

function SettingSection<T extends string>({ title, desc, label, value, onChange, options }: SectionProps<T>) {
  return (
    <section className={card}>
      <h3 className="mb-1 text-body font-semibold text-ink">{title}</h3>
      <p className="mb-3 text-label text-ink-dim leading-relaxed">{desc}</p>
      <div className={`${segmentedTrack} flex flex-wrap gap-1.5`} role="radiogroup" aria-label={label}>
        {options.map(([val, text]) => (
          <button
            key={val}
            type="button"
            role="radio"
            aria-checked={value === val}
            onClick={() => { onChange(val); }}
            className={`${segBase} ${value === val ? segOn : segOff}`}
          >
            {text}
          </button>
        ))}
      </div>
    </section>
  );
}

const THEME_OPTIONS = [
  ['system', 'System default'],
  ['dark', 'Dark'],
  ['light', 'Light'],
] as const;

const POLICY_OPTIONS = [
  ['default', 'Engine default (LRU)'],
  ...REPLACEMENT_POLICY_NAMES.map((name) => [name, REPLACEMENT_POLICY_LABELS[name]] as const),
] as const;

const PREDICT_OPTIONS = [
  ['default', 'Engine default (on)'],
  ['on', 'Always on'],
  ['off', 'Always off'],
] as const;

const SPEED_OPTIONS = [
  ['default', 'Engine default (1×)'],
  ['0.5', '0.5× Slow'],
  ['1', '1× Normal'],
  ['2', '2× Fast'],
] as const;

export function SettingsPage() {
  const { choice: themeChoice, setChoice: setThemeChoice } = useThemeContext();

  const [policy, setPolicy] = useState<ReplacementPolicyName | 'default'>(
    () => readDefaultPolicy() ?? 'default',
  );
  const [predictOn, setPredictOn] = useState<'default' | 'on' | 'off'>(() => {
    const stored = readDefaultPredictOn();
    return stored === undefined ? 'default' : stored ? 'on' : 'off';
  });
  const [speed, setSpeed] = useState<string>(readDefaultSpeed);

  function choosePolicy(next: ReplacementPolicyName | 'default') {
    setPolicy(next);
    writeDefaultPolicy(next === 'default' ? null : next);
  }

  function choosePredict(next: 'default' | 'on' | 'off') {
    setPredictOn(next);
    writeDefaultPredictOn(next === 'default' ? null : next === 'on');
  }

  function chooseSpeed(next: string) {
    setSpeed(next);
    writeDefaultSpeed(next);
  }

  function resetAll() {
    choosePolicy('default');
    choosePredict('default');
    chooseSpeed('default');
    setThemeChoice('system');
  }

  return (
    <div className="mx-auto w-full max-w-2xl p-6 sm:p-8">
      <PageHeader eyebrow="Preferences" title="Settings">
        Defaults for cold visits to the Playground. Shared links always override these preferences.
      </PageHeader>

      <div className="space-y-4 mt-6">
        <SettingSection
          title="Color theme"
          desc="Workspace color scheme."
          label="Color theme"
          value={themeChoice}
          onChange={setThemeChoice}
          options={THEME_OPTIONS}
        />

        <SettingSection
          title="Default eviction policy"
          desc="Buffer pool replacement algorithm when none is specified."
          label="Default eviction policy"
          value={policy}
          onChange={choosePolicy}
          options={POLICY_OPTIONS}
        />

        <SettingSection
          title="Predict-then-reveal mode"
          desc="Require prediction commitments before revealing each step."
          label="Default predict-then-reveal"
          value={predictOn}
          onChange={choosePredict}
          options={PREDICT_OPTIONS}
        />

        <SettingSection
          title="Animation playback speed"
          desc="Pacing multiplier for automatic step playback."
          label="Default playback speed"
          value={speed}
          onChange={chooseSpeed}
          options={SPEED_OPTIONS}
        />
      </div>

      <div className="mt-6 flex items-center justify-between border-t border-edge pt-4">
        <button
          type="button"
          onClick={resetAll}
          className={btnGhost}
        >
          Reset to engine defaults
        </button>
        <span className="font-mono text-[11px] text-ink-dim">Stored locally in browser</span>
      </div>
    </div>
  );
}
