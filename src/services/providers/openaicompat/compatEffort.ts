import { HOST_RECIPES } from '../../host/recipes.js'
import { isRankedWireEffort } from '../openai/gptPins.js'
import { currentHostRecipes } from '../../host/recipesFile.js'
import { operatorModelFacts } from '../../../utils/model/modelOverrides.js'
import { compatModelEndpoint } from './compatAccounts.js'
import { cachedCompatCatalogue } from './compatCatalogue.js'
import type { CompatDialect } from './compatProbe.js'
import { LOCAL_SERVER_EFFORTS, localThinkingOffWireEffort } from './compatWire.js'
import { isKimiK3WireModel } from './kimiReplay.js'

export function hostModelEfforts(wireModel: string, dialect: CompatDialect, reported?: readonly string[]): readonly string[] {
  if (reported !== undefined) return reported.filter(isRankedWireEffort)
  if (dialect === 'lmstudio' || dialect === 'responses') return []
  if (dialect === 'ollama') return []
  const id = wireModel.toLowerCase().split(':')[0]!
  const recipe = [...currentHostRecipes(), ...HOST_RECIPES].find(row => row.model.toLowerCase() === id && row.efforts !== undefined)
  if (recipe?.efforts) return recipe.efforts.levels
  if (id === 'kimi-k3' || id === 'moonshotai/kimi-k3') return ['low', 'high', 'max']
  return dialect === 'chat-completions' ? [] : LOCAL_SERVER_EFFORTS[dialect]
}

export function compatModelEfforts(model: string): readonly string[] {
  const resolved = compatModelEndpoint(model)
  if (!resolved) return []
  const { endpoint, wireId } = resolved
  const stated = operatorModelFacts(model)?.efforts
  return hostModelEfforts(wireId, endpoint.dialect ?? 'chat-completions', stated ?? cachedCompatCatalogue(endpoint)?.efforts?.[wireId])
}

export function compatModelThinkingOffWire(model: string): string | undefined {
  const resolved = compatModelEndpoint(model)
  return resolved?.endpoint.dialect === 'llamacpp' && !isKimiK3WireModel(resolved.wireId) ? localThinkingOffWireEffort('llamacpp') : undefined
}
