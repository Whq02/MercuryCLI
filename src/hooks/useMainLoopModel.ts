// The configured main-loop model (configured → default), re-resolved on a
// feature-gate refresh — the resolution reads possibly stale cached gate
// values, so the hook forces a re-render when the gates refresh; without it
// the backend samples one model while the model command displays another.
// The SESSION override (mainLoopModelForSession) is the caller's overlay:
// label sites resolve `mainLoopModelForSession ?? mainLoopModel ?? default`.

import { useEffect, useState } from 'react'
import { onFeatureGatesRefresh } from '../services/analytics/featureGates.js'
import { getMainLoopModel, type ModelName } from '../utils/model/model.js'

export function useMainLoopModel(): ModelName {
  const [, force] = useState(0)
  useEffect(() => onFeatureGatesRefresh(() => force(n => n + 1)), [])
  return getMainLoopModel()
}
