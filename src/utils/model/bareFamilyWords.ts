import type { CallModelRoute } from '../../services/providers/idSpaces.js'

export interface BareFamilyWordRow {
  id: string
  displayName: string
}

export interface BareFamilyWord {
  word: string
  route: Exclude<CallModelRoute, 'anthropic'>
  headRow: () => BareFamilyWordRow | undefined
}

function glmHeadRow(): BareFamilyWordRow | undefined {
  const { GLM_STATIC_CATALOGUE } = require('../router/providers/zai.js') as typeof import('../router/providers/zai.js')
  const head = GLM_STATIC_CATALOGUE[0]
  return head === undefined ? undefined : { id: head.id, displayName: head.displayLabel }
}

function kimiHeadRow(): BareFamilyWordRow | undefined {
  const { moonshotCatalogueRows } = require('../../services/providers/moonshot/moonshotCatalogue.js') as typeof import('../../services/providers/moonshot/moonshotCatalogue.js')
  return moonshotCatalogueRows().rows[0]
}

function deepseekHeadRow(): BareFamilyWordRow | undefined {
  const { deepseekCatalogueRows } = require('../../services/providers/deepseek/deepseekCatalogue.js') as typeof import('../../services/providers/deepseek/deepseekCatalogue.js')
  return deepseekCatalogueRows().rows[0]
}

function grokHeadRow(): BareFamilyWordRow | undefined {
  const { xaiCatalogueRows } = require('../../services/providers/xai/xaiCatalogue.js') as typeof import('../../services/providers/xai/xaiCatalogue.js')
  return xaiCatalogueRows().rows[0]
}

export const BARE_FAMILY_WORDS: readonly BareFamilyWord[] = [
  { word: 'glm', route: 'zai', headRow: glmHeadRow },
  { word: 'kimi', route: 'moonshot', headRow: kimiHeadRow },
  { word: 'deepseek', route: 'deepseek', headRow: deepseekHeadRow },
  { word: 'grok', route: 'xai', headRow: grokHeadRow },
]

export function bareFamilyWordOf(word: string): BareFamilyWord | undefined {
  const lowered = word.trim().toLowerCase()
  return BARE_FAMILY_WORDS.find(entry => entry.word === lowered)
}

export function isBareFamilyWord(word: string): boolean {
  return bareFamilyWordOf(word) !== undefined
}

export function resolveBareFamilyWord(word: string): string | undefined {
  const entry = bareFamilyWordOf(word)
  if (entry === undefined) return undefined
  return entry.headRow()?.id ?? entry.word
}
