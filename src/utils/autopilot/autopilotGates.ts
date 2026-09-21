import { isEnvTruthy } from '../envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export function isAutopilotEnabled(): boolean {
  return isEnvTruthy(flagEnv('MERCURY_AUTOPILOT'))
}

const SESSION_WORDS = new Set(['best', 'opusplan'])

function models(): typeof import('../model/model.js') {
  return require('../model/model.js') as typeof import('../model/model.js')
}

function routeLaw(): typeof import('../../services/providers/routeLaw.js') {
  return require('../../services/providers/routeLaw.js') as typeof import('../../services/providers/routeLaw.js')
}

function families(): typeof import('../model/modelFamilies.js') {
  return require('../model/modelFamilies.js') as typeof import('../model/modelFamilies.js')
}

export function autopilotSessionFamily(currentModel: string): string | null {
  return routeLaw().declaredRouteOf(models().parseUserSpecifiedModel(currentModel))
}

export function autopilotTierKeys(currentModel: string): readonly string[] {
  const route = autopilotSessionFamily(currentModel)
  if (route === null) return []
  const { declaredRouteOf } = routeLaw()
  const { parseUserSpecifiedModel } = models()
  const { modelFamilyWords, routeOfFamilyWord, FIRST_PARTY_FAMILY_WORDS } = families()
  const keys: string[] = []
  const add = (key: string): void => {
    if (!keys.includes(key)) keys.push(key)
  }
  for (const word of modelFamilyWords()) {
    if (routeOfFamilyWord(word) === route) add(word)
    else if (route === 'anthropic' && FIRST_PARTY_FAMILY_WORDS.has(word)) add(word)
  }
  if (route === 'anthropic') {
    const { MODEL_ALIASES } = require('../model/aliases.js') as typeof import('../model/aliases.js')
    for (const alias of MODEL_ALIASES) {
      if (SESSION_WORDS.has(alias) || /\[1m\]$/.test(alias)) continue
      if (declaredRouteOf(parseUserSpecifiedModel(alias)) === 'anthropic') add(alias)
    }
  }
  const { getModelOptions, isProviderActionRow } = require('../model/modelOptions.js') as typeof import('../model/modelOptions.js')
  for (const option of getModelOptions()) {
    const value = option.value
    if (typeof value !== 'string' || value.startsWith('__') || isProviderActionRow(value) || option.unavailable !== undefined) continue
    if (declaredRouteOf(parseUserSpecifiedModel(value)) !== route) continue
    add(value.toLowerCase())
  }
  return keys
}

function narrowingWords(): readonly string[] | null {
  const raw = flagEnv('MERCURY_AUTOPILOT_MODELS')
  const cleaned = (raw ?? '').trim().replace(/^["']+|["']+$/g, '').trim()
  if (cleaned === '') return null
  return cleaned
    .split(/[,;\s]+/)
    .map(s => s.trim().toLowerCase())
    .filter(s => s !== '')
}

export function autopilotAllowedModels(currentModel: string): readonly string[] {
  const keys = autopilotTierKeys(currentModel)
  const named = narrowingWords()
  if (named === null) return keys
  return keys.filter(key => named.includes(key))
}

export function autopilotTierKeyOf(key: string, currentModel: string): string | null {
  const lowered = key.trim().toLowerCase()
  if (lowered === '') return null
  const keys = autopilotTierKeys(currentModel)
  if (keys.includes(lowered)) return lowered
  const { parseUserSpecifiedModel, normalizeModelStringForAPI } = models()
  const wanted = normalizeModelStringForAPI(parseUserSpecifiedModel(lowered)).toLowerCase()
  for (const candidate of keys) {
    if (normalizeModelStringForAPI(parseUserSpecifiedModel(candidate)).toLowerCase() === wanted) return candidate
  }
  return null
}
