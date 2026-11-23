import { gptDisplayPin, liveGptContextCeiling, liveGptContextWindow, parseGptModelId } from '../../models/roads/openai/openaiCatalogue.js'
import type { ModelChoice } from './choice.js'

export function focusedGptFacts(focusedModel: ModelChoice | undefined) {
  const focusedGptWindow = ((): { served: number; ceiling?: number; observed?: string } | null => {
    const p = focusedModel?.id
    if (!p || !parseGptModelId(p)) return null
    const live = liveGptContextWindow(p)
    const pin = gptDisplayPin(p)
    const served = live ?? pin?.contextWindow
    if (served === undefined) return null
    const ceiling = liveGptContextCeiling(p)
    return {
      served,
      ...(ceiling !== undefined && ceiling > served ? { ceiling } : {}),
      ...(live === undefined && pin?.observedAt !== undefined ? { observed: pin.observedAt } : {}),
    }
  })()
  const focusedGptToggle = focusedGptWindow?.ceiling !== undefined
  return { focusedGptWindow, focusedGptToggle }
}
