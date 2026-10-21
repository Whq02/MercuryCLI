import type { AnthropicDoor } from './anthropic/anthropicCatalogue.js'

export function modelNotOfferedByCatalogue(modelId: string, accountLabel: string, offered: readonly string[], servedAs: readonly string[] = []): string {
  const hint = offered.length > 0 ? ` The catalogue offers: ${offered.join(', ')}.` : ''
  const alias = servedAs.length > 0 ? ` ${modelId} is served here as ${servedAs.join(', ')}.` : ''
  return `model '${modelId}' is not offered by the ${accountLabel} live catalogue.${alias}${hint}`
}

export const ANTHROPIC_CATALOGUE_ADMISSION_BOUND_MS = 5_000

export function activeAnthropicDoor(credentialLabel: string | undefined): AnthropicDoor | null {
  if (credentialLabel === undefined) return null
  if (credentialLabel.startsWith('Claude subscription')) return 'subscription'
  if (credentialLabel.startsWith('Anthropic API key')) return 'api-key'
  if (credentialLabel.startsWith('Anthropic bearer token')) return 'bearer'
  return null
}

function catalogueKey(id: string): string {
  return id.trim().replace(/\[[^\]]*\]/g, '').toLowerCase()
}

export function anthropicCatalogueVerdict(
  asked: string,
  shown: string,
  snapshot: { label: string; models: ReadonlyArray<{ id: string }> } | null,
): string | null {
  if (snapshot === null || snapshot.models.length === 0) return null
  const key = catalogueKey(asked)
  if (key === '' || snapshot.models.some(row => catalogueKey(row.id) === key)) return null
  return modelNotOfferedByCatalogue(shown.trim(), snapshot.label, snapshot.models.map(row => row.id))
}

async function boundedRead(read: Promise<unknown>, boundMs: number, signal?: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  await Promise.race([
    read.catch(() => null),
    new Promise<void>(resolve => {
      timer = setTimeout(resolve, boundMs)
      timer.unref?.()
      if (signal !== undefined) {
        onAbort = (): void => resolve()
        signal.addEventListener('abort', onAbort, { once: true })
      }
    }),
  ])
  clearTimeout(timer)
  if (signal !== undefined && onAbort !== undefined) signal.removeEventListener('abort', onAbort)
}

export async function anthropicCatalogueRefusal(
  model: string,
  opts?: { signal?: AbortSignal; boundMs?: number; env?: NodeJS.ProcessEnv },
): Promise<string | null> {
  const env = opts?.env ?? process.env
  try {
    const { anthropicCredentialPresence } = require('./providerUsage.js') as typeof import('./providerUsage.js')
    const door = activeAnthropicDoor(anthropicCredentialPresence().credentialLabel)
    if (door === null) return null
    const catalogue = require('./anthropic/anthropicCatalogue.js') as typeof import('./anthropic/anthropicCatalogue.js')
    const cached = catalogue.getCachedAnthropicDoorCatalogue(door, env)
    if (cached === null || (cached.models.length === 0 && cached.lastError !== undefined)) {
      await boundedRead(catalogue.refreshAnthropicCatalogue({ door, env }), opts?.boundMs ?? ANTHROPIC_CATALOGUE_ADMISSION_BOUND_MS, opts?.signal)
    }
    if (opts?.signal?.aborted === true) return null
    const { normalizeModelStringForAPI } = require('../../utils/model/model.js') as typeof import('../../utils/model/model.js')
    return anthropicCatalogueVerdict(normalizeModelStringForAPI(model), model, catalogue.getCachedAnthropicDoorCatalogue(door, env))
  } catch {
    return null
  }
}
