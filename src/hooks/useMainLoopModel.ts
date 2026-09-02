
import { useEffect, useState } from 'react'
import { onFeatureGatesRefresh } from '../services/analytics/featureGates.js'
import { getMainLoopModel, type ModelName } from '../utils/model/model.js'

export function useMainLoopModel(): ModelName {
  const [, force] = useState(0)
  useEffect(() => onFeatureGatesRefresh(() => force(n => n + 1)), [])
  return getMainLoopModel()
}
