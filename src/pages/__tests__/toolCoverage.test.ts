import { describe, expect, it } from 'vitest';
import { CHALLENGES } from '../challenges/challenges.tsx';
import { SCRIPT_CHALLENGES } from '../challenges/scriptChallenges.tsx';
import { SETTINGS_CHALLENGES } from '../challenges/settingsChallenges.tsx';
import { runScript } from '../challenges/scriptRunner.ts';
import { runSettings } from '../challenges/settingsRunner.ts';
import { LESSONS } from '../learn/lessons.tsx';
import indexSource from '../ToolsIndexPage.tsx?raw';

/**
 * plan.md release checklist §2.4: "every shipped tool has a lesson, a challenge, a data-table view and its own budget
 * row". The budget row and the table views are held where they are made; this holds the other two, from the tools
 * index outward, so a tool added to the index without a lesson or a challenge fails here instead of being found at
 * release.
 */

const TOOL_PATHS = [...indexSource.matchAll(/href: '(\/tools\/[a-z-]+)'/g)].map((m) => m[1]!);

const pathOf = (href: string) => new URL(href, 'https://x').pathname;

describe('every tool in the tools index', () => {
  it('is found by the pattern this test reads the index with', () => {
    expect(TOOL_PATHS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(TOOL_PATHS).size).toBe(TOOL_PATHS.length);
  });

  const lessonTools = new Set(
    LESSONS.flatMap((l) => l.steps.map((s) => s.link?.href)).flatMap((h) => (h ? [pathOf(h)] : [])),
  );

  const challengeTools = new Set<string>();
  for (const c of CHALLENGES) {
    const href = c.tool?.href('SELECT 1');
    if (href) challengeTools.add(pathOf(href));
  }
  for (const c of SCRIPT_CHALLENGES) {
    const href = runScript(c, c.starter).toolHref;
    if (href) challengeTools.add(pathOf(href));
  }
  for (const c of SETTINGS_CHALLENGES) {
    const starter = Object.fromEntries(Object.entries(c.starter));
    const href = runSettings(c, starter).toolHref;
    if (href) challengeTools.add(pathOf(href));
  }

  for (const path of TOOL_PATHS) {
    it(`${path} has a lesson that opens it`, () => {
      expect(lessonTools.has(path), `no lesson step links to ${path}`).toBe(true);
    });
    it(`${path} has a challenge that opens it`, () => {
      expect(challengeTools.has(path), `no challenge links to ${path}`).toBe(true);
    });
  }
});
