import { isReplacementPolicyName } from '../engine/types.ts';
import type { ReplacementPolicyName } from '../engine/index.ts';
import { isDetailLevel } from './detailLevel.ts';
import type { DetailLevel } from './detailLevel.ts';

/**
 * Session-spanning defaults, set from `/settings` (plan.md §21.3). Same
 * try/catch discipline as `theme.ts`: private mode or blocked site data must
 * degrade to the built-in default, never throw.
 *
 * These are *defaults only* — a shareable URL (`src/ui/urlState.ts`) always
 * wins when present, the same precedence `PlaygroundPage` already gives the
 * URL over `DEFAULT_ENGINE_OPTIONS`. Changing a preference does not rewrite
 * links already handed out.
 */

const POLICY_KEY = 'querylens:default-policy';
const PREDICT_KEY = 'querylens:default-predict';

export function readDefaultPolicy(): ReplacementPolicyName | undefined {
  try {
    const stored = localStorage.getItem(POLICY_KEY);
    return isReplacementPolicyName(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

export function writeDefaultPolicy(policy: ReplacementPolicyName | null): void {
  try {
    if (policy === null) localStorage.removeItem(POLICY_KEY);
    else localStorage.setItem(POLICY_KEY, policy);
  } catch {
    // Preference does not stick this session; nothing else depends on it.
  }
}

export function readDefaultPredictOn(): boolean | undefined {
  try {
    const stored = localStorage.getItem(PREDICT_KEY);
    return stored === '1' ? true : stored === '0' ? false : undefined;
  } catch {
    return undefined;
  }
}

export function writeDefaultPredictOn(predictOn: boolean | null): void {
  try {
    if (predictOn === null) localStorage.removeItem(PREDICT_KEY);
    else localStorage.setItem(PREDICT_KEY, predictOn ? '1' : '0');
  } catch {
    // Same as above.
  }
}

const DETAIL_KEY = 'querylens:default-detail';

/** plan.md §27.5 L2: the narration's detail level. `null` is standard — the engine's own words. */
export function readDefaultDetail(): DetailLevel | undefined {
  try {
    const stored = localStorage.getItem(DETAIL_KEY);
    return isDetailLevel(stored) ? stored : undefined;
  } catch {
    return undefined;
  }
}

export function writeDefaultDetail(level: DetailLevel | null): void {
  try {
    if (level === null || level === 'standard') localStorage.removeItem(DETAIL_KEY);
    else localStorage.setItem(DETAIL_KEY, level);
  } catch {
    // Same as above.
  }
}
