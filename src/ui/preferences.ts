import { isReplacementPolicyName } from '../engine/types.ts';
import type { ReplacementPolicyName } from '../engine/index.ts';

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
