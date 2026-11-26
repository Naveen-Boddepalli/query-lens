/**
 * plan.md §27.5 L2: the narration's three levels of detail, by name — kept apart from `narrationDetail.ts`'s
 * catalogue so that `/settings`, which only stores a choice, does not carry every line of it.
 */

export type DetailLevel = 'novice' | 'standard' | 'expert';

export const DETAIL_LEVELS: readonly DetailLevel[] = ['novice', 'standard', 'expert'];

export const DETAIL_LABELS: Record<DetailLevel, string> = { novice: 'Novice', standard: 'Standard', expert: 'Expert' };

export const isDetailLevel = (value: unknown): value is DetailLevel => typeof value === 'string' && (DETAIL_LEVELS as readonly string[]).includes(value);

/** `?detail=novice|expert` — standard is the absence of the parameter. */
export function readDetailParam(search: string): DetailLevel | undefined {
  const value = new URLSearchParams(search).get('detail');
  return isDetailLevel(value) ? value : undefined;
}
