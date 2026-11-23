import type { AnthropicDoor } from './anthropic/anthropicCatalogue.js'
import { passedOver } from '../../platform/errors/passedOver.js'
import { hostEnv } from '../../platform/environment/hostEnv.js'

export function modelNotOfferedByCatalogue(modelId: string, accountLabel: string, offered: readonly string[], servedAs: readonly string[] = []): string {
  const hint = offered.length > 0 ? ` The catalogue offers: ${offered.join(', ')}.` : ''
  const alias = servedAs.length > 0 ? ` ${modelId} is served here as ${servedAs.join(', ')}.` : ''
  return `model '${modelId}' is not offered by the ${accountLabel} live catalogue.${alias}${hint}`
}

function activeAnthropicDoor(credentialLabel: string | undefined): AnthropicDoor | null {
  if (credentialLabel === undefined) return null
  if (credentialLabel.startsWith('Claude subscription')) return 'subscription'
  if (credentialLabel.startsWith('Anthropic API key')) return 'api-key'
  if (credentialLabel === 'Anthropic bearer token (ANTHROPIC_AUTH_TOKEN)') return 'bearer'
  return null
}

function catalogueKey(id: string): string {
  return id.trim().replace(/\[[^\]]*\]/g, '').toLowerCase()
}

function anthropicCatalogueVerdict(
  asked: string,
  shown: string,
  snapshot: { label: string; models: ReadonlyArray<{ id: string }> } | null,
): string | null {
  if (snapshot === null || snapshot.models.length === 0) return null
  const key = catalogueKey(asked)
  if (key === '' || snapshot.models.some(row => catalogueKey(row.id) === key)) return null
  return modelNotOfferedByCatalogue(shown.trim(), snapshot.label, snapshot.models.map(row => row.id))
}

export async function anthropicCatalogueRefusal(
  model: string,
  opts?: { signal?: AbortSignal; env?: NodeJS.ProcessEnv },
): Promise<string | null> {
  const env = opts?.env ?? hostEnv()
  if (env.ANTHROPIC_BASE_URL?.trim() || opts?.signal?.aborted === true) return null
  try {
    const { anthropicCredentialPresence } = require('./providerUsage.js') as typeof import('./providerUsage.js')
    const door = activeAnthropicDoor(anthropicCredentialPresence().credentialLabel)
    if (door === null) return null
    const catalogue = require('./anthropic/anthropicCatalogue.js') as typeof import('./anthropic/anthropicCatalogue.js')
    const cached = catalogue.getCachedAnthropicDoorCatalogue(door, env)
    const { normalizeModelStringForAPI } = require('../catalogue/engineModel.js') as typeof import('../catalogue/engineModel.js')
    return anthropicCatalogueVerdict(normalizeModelStringForAPI(model), model, cached)
  } catch (error) {
    passedOver(error)
    return null
  }
}
