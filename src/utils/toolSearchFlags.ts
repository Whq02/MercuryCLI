
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/featureGates.js'

export function isDeferredToolsDeltaEnabled(): boolean {
  return (
    getFeatureValue_CACHED_MAY_BE_STALE('mercury_glacier_2xr', false)
  )
}
