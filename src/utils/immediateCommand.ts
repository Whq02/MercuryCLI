import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/featureGates.js'

export function shouldInferenceConfigCommandBeImmediate(): boolean {
  return (
    getFeatureValue_CACHED_MAY_BE_STALE('mercury_immediate_model_command', false)
  )
}

export function shouldNavCommandBeImmediate(): boolean {
  return true
}
