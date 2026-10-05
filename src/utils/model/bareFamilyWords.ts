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
  const { zaiCatalogueRows } = require('../../services/providers/zai/zaiCatalogue.js') as typeof import('../../services/providers/zai/zaiCatalogue.js')
  return zaiCatalogueRows().rows[0]
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

function museHeadRow(): BareFamilyWordRow | undefined {
  const { metaCatalogueRows, newestMetaModel } = require('../../services/providers/meta/metaCatalogue.js') as typeof import('../../services/providers/meta/metaCatalogue.js')
  const id = newestMetaModel()
  const head = id === undefined ? undefined : metaCatalogueRows().rows.find(row => row.id === id)
  return head === undefined ? undefined : { id: head.id, displayName: head.displayName }
}

export const BARE_FAMILY_WORDS: readonly BareFamilyWord[] = [
  { word: 'glm', route: 'zai', headRow: glmHeadRow },
  { word: 'kimi', route: 'moonshot', headRow: kimiHeadRow },
  { word: 'deepseek', route: 'deepseek', headRow: deepseekHeadRow },
  { word: 'grok', route: 'xai', headRow: grokHeadRow },
  { word: 'muse', route: 'meta', headRow: museHeadRow },
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
