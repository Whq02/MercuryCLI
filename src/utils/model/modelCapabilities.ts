/**
 * Per-account cache of model context/output limits fetched from the
 * models-list endpoint.
 *
 * Eligibility is HARD-DISABLED in this build (an early unconditional false),
 * leaving the provider and base-URL checks unreachable. The observable
 * behaviour a re-implementation must preserve: capability lookups return
 * nothing and refresh is a no-op.
 */

export type ModelCapability = {
  id: string
  max_input_tokens?: number
  max_tokens?: number
}

/** Hard-disabled: the provider/base-URL checks below are unreachable. */
function isModelCapabilitiesEligible(): boolean {
  return false
}

/** Lookup returns nothing while the feature is disabled. */
export function getModelCapability(model: string): ModelCapability | undefined {
  void model
  if (!isModelCapabilitiesEligible()) return undefined
  return undefined
}

/** Refresh is a no-op while the feature is disabled. */
export async function refreshModelCapabilities(): Promise<void> {
  if (!isModelCapabilitiesEligible()) return
}
