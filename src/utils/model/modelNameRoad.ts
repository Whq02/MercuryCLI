import { isModelAlias } from './aliases.js'
import { isModelFamilyWord } from './modelFamilies.js'
import { matchModelName, type ModelNameEntry, type ModelNameMatch } from './modelNameMatcher.js'
import { getModelOptions, isProviderActionRow } from './modelOptions.js'

const CLASS_WORDS = new Set(['default', 'gpt', 'glm', 'kimi', 'deepseek', 'grok', 'compat', 'huggingface', 'local', 'gemini', 'openrouter', 'mistral', 'nous', 'zen', 'meta', 'inherit'])

export function reachableModelEntries(): ModelNameEntry[] {
  return getModelOptions()
    .filter(option => !isProviderActionRow(option.value))
    .map(option => ({ id: option.value, name: option.label }))
}

export function matchReachableModelName(typed: string): ModelNameMatch | null {
  const lowered = typed.trim().toLowerCase()
  if (lowered === '' || isModelAlias(lowered) || isModelFamilyWord(lowered) || CLASS_WORDS.has(lowered)) return null
  if (/^(compat|huggingface|local|openrouter|nous|zen)\//.test(lowered)) return null
  return matchModelName(typed, reachableModelEntries())
}

export function modelNameAskWords(match: ModelNameMatch, labelOf: (id: string) => string = id => id): string {
  if (match.kind === 'ambiguous') {
    const names = match.candidates.map(labelOf)
    const list = names.length <= 2 ? names.join(' or ') : `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`
    return `'${match.typed}' could be ${list} — pick a row below`
  }
  if (match.kind === 'none') {
    return match.nearest.length === 0
      ? `'${match.typed}' names no listed model — pick a row below`
      : `'${match.typed}' names no listed model — nearest: ${match.nearest.map(labelOf).join(' · ')} — pick a row below`
  }
  return ''
}

export function modelNameHeadlessRefusal(match: ModelNameMatch, flag: string): string {
  if (match.kind === 'ambiguous') return `${flag} '${match.typed}' could be ${match.candidates.join(' or ')} — name one.`
  if (match.kind === 'none') {
    return match.nearest.length === 0
      ? `${flag} '${match.typed}' names no listed model.`
      : `${flag} '${match.typed}' names no listed model — nearest: ${match.nearest.join(' · ')}.`
  }
  return ''
}
