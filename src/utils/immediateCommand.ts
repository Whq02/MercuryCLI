import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/featureGates.js'

/**
 * Should the inference-config commands (/model, /effort) take effect
 * mid-query, instead of queueing until the running turn completes?
 * Answered by the mercury_immediate_model_command feature value; the
 * fallback answer is to wait.
 */
export function shouldInferenceConfigCommandBeImmediate(): boolean {
  return (
    getFeatureValue_CACHED_MAY_BE_STALE('mercury_immediate_model_command', false)
  )
}

/**
 * Whether READ-ONLY navigation/panel commands (/resume /config /agents /memory /help
 * /export /logins /logout) should open IMMEDIATELY — during a running query — instead of
 * queueing until the turn ends. The operator's biggest friction was these queueing while
 * the agent works, so the UI was inaccessible mid-turn. They are overlays / auth flows
 * with no dependency on the turn being idle, so opening them mid-turn is safe.
 *
 * Always immediate: nav commands render read-only surfaces, so the
 * responsive path is safe in every session shape —
 * Mercury always gets the responsive behavior.
 */
export function shouldNavCommandBeImmediate(): boolean {
  return true
}
