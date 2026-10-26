import type { Page } from '@playwright/test';

/**
 * Shared by the two accessibility specs (`audit.spec.ts`, `auditStates.spec.ts`): how to open a route so that what is
 * scanned is the page at rest, in a chosen theme and width. A helper module, not a spec, so Playwright does not
 * register the tests of one file twice by importing it from another.
 */

export const THEMES_AND_WIDTHS = [
  { theme: 'light', width: 1280 },
  { theme: 'dark', width: 1280 },
  { theme: 'light', width: 360 },
  { theme: 'dark', width: 360 },
] as const;

export async function openForAudit(page: Page, route: string, theme: 'light' | 'dark', width: number) {
  await page.addInitScript((t) => {
    try {
      localStorage.setItem('querylens:theme', t);
    } catch {
      // Site data blocked: the page follows the system, which is what a visitor with it blocked gets.
    }
  }, theme);
  await page.setViewportSize({ width, height: 800 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(route);
  await page.waitForLoadState('networkidle');
  await page.getByRole('heading').first().waitFor();
  // The last frame of any entry transition, so a contrast is read at rest.
  await page.waitForTimeout(200);
}
