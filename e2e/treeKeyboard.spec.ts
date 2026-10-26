import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('a tree diagram is one tab stop, and the arrow keys walk the tree (plan.md §H6)', async ({ page }) => {
  await page.goto('/tools/btree?keys=1,2,3,4,5,6,7,8,9,10,11,12&fanout=4');
  const tree = page.getByRole('tree', { name: 'B+Tree' });
  await expect(tree).toBeVisible();

  await tree.locator('[aria-level="1"]').focus();
  const focused = page.locator(':focus');
  await expect(focused).toHaveAttribute('aria-level', '1');

  await page.keyboard.press('ArrowDown');
  await expect(focused).toHaveAttribute('aria-level', '2');

  await page.keyboard.press('ArrowRight');
  await expect(focused).toHaveAttribute('aria-posinset', '2');

  await page.keyboard.press('ArrowUp');
  await expect(focused).toHaveAttribute('aria-level', '1');

  await expect(tree.locator('[tabindex="0"]')).toHaveCount(1);
});

test('a tree diagram has no detectable WCAG A/AA violations (plan.md §H6)', async ({ page }) => {
  await page.goto('/tools/btree?keys=1,2,3,4,5,6,7,8,9,10,11,12&fanout=4');
  await expect(page.getByRole('tree', { name: 'B+Tree' })).toBeVisible();
  const results = await new AxeBuilder({ page })
    .include('[role="tree"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});
