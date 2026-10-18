import type { CallModelRoute } from '../../services/providers/idSpaces.js'

export interface BareFamilyWordRow {
  id: string
  displayName: string
}

export type BareFamilyListState =
  | { kind: 'live'; count: number; fetchedAtMs: number }
  | { kind: 'pin' }
  | { kind: 'unread'; error?: string }

export interface BareFamilyWord {
  word: string
  route: Exclude<CallModelRoute, 'anthropic'>
  headRow: () => BareFamilyWordRow | undefined
  pinnedDefault: () => BareFamilyWordRow | undefined
  listState: () => BareFamilyListState
  knownRows: () => BareFamilyWordRow[]
  knownRow: (id: string) => BareFamilyWordRow | undefined
}

const ANNOTATION_RE = /\[(?:[0-9]+m|served)\]/gi

export function bareModelIdOf(id: string): string {
  return id.trim().toLowerCase().replace(ANNOTATION_RE, '')
}

function gateError(family: 'zai' | 'moonshot' | 'deepseek' | 'xai' | 'meta' | 'mistral' | 'minimax' | 'cohere' | 'qwen'): string | undefined {
  const { catalogueTrafficVerdict } = require('../../services/providers/catalogueGate.js') as typeof import('../../services/providers/catalogueGate.js')
  const verdict = catalogueTrafficVerdict(family)
  return verdict.allowed ? undefined : verdict.reason
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

function mistralHeadRow(): BareFamilyWordRow | undefined {
  const { mistralCatalogueRows } = require('../../services/providers/mistral/mistralCatalogue.js') as typeof import('../../services/providers/mistral/mistralCatalogue.js')
  return mistralCatalogueRows().rows[0]
}

function glmPinnedDefault(): BareFamilyWordRow | undefined {
  const { GLM_STATIC_FLOOR_IDS, glmDisplayPin } = require('../../services/providers/zai/glmPins.js') as typeof import('../../services/providers/zai/glmPins.js')
  const pin = GLM_STATIC_FLOOR_IDS.map(id => glmDisplayPin(id)).find(row => row !== undefined)
  return pin === undefined ? undefined : { id: pin.id, displayName: pin.displayName }
}

function kimiPinnedDefault(): BareFamilyWordRow | undefined {
  const { KIMI_DISPLAY_PINS } = require('../../services/providers/moonshot/kimiPins.js') as typeof import('../../services/providers/moonshot/kimiPins.js')
  const pin = KIMI_DISPLAY_PINS[0]
  return pin === undefined ? undefined : { id: pin.id, displayName: pin.displayName }
}

function deepseekPinnedDefault(): BareFamilyWordRow | undefined {
  const { DEEPSEEK_DISPLAY_PINS } = require('../../services/providers/deepseek/deepseekPins.js') as typeof import('../../services/providers/deepseek/deepseekPins.js')
  const pin = DEEPSEEK_DISPLAY_PINS[0]
  return pin === undefined ? undefined : { id: pin.id, displayName: pin.displayName }
}

function grokPinnedDefault(): BareFamilyWordRow | undefined {
  const { XAI_DISPLAY_PINS } = require('../../services/providers/xai/xaiPins.js') as typeof import('../../services/providers/xai/xaiPins.js')
  const pin = XAI_DISPLAY_PINS[0]
  return pin === undefined ? undefined : { id: pin.id, displayName: pin.displayName }
}

function musePinnedDefault(): BareFamilyWordRow | undefined {
  const { META_DISPLAY_PINS, isMetaContributorModel } = require('../../services/providers/meta/metaPins.js') as typeof import('../../services/providers/meta/metaPins.js')
  const pin = META_DISPLAY_PINS.find(row => !isMetaContributorModel(row.id))
  return pin === undefined ? undefined : { id: pin.id, displayName: pin.displayName }
}

function mistralPinnedDefault(): BareFamilyWordRow | undefined {
  const { MISTRAL_DISPLAY_PINS } = require('../../services/providers/mistral/mistralPins.js') as typeof import('../../services/providers/mistral/mistralPins.js')
  const pin = MISTRAL_DISPLAY_PINS[0]
  return pin === undefined ? undefined : { id: pin.id, displayName: pin.displayName }
}

function glmListState(): BareFamilyListState {
  const { zaiCatalogueRows, getCachedZaiCatalogue } = require('../../services/providers/zai/zaiCatalogue.js') as typeof import('../../services/providers/zai/zaiCatalogue.js')
  const { source } = zaiCatalogueRows()
  if (source.kind === 'live') return { kind: 'live', count: source.count, fetchedAtMs: source.fetchedAtMs }
  const error = gateError('zai') ?? getCachedZaiCatalogue()?.lastError
  return error === undefined ? { kind: 'pin' } : { kind: 'unread', error }
}

function kimiListState(): BareFamilyListState {
  const { moonshotCatalogueRows } = require('../../services/providers/moonshot/moonshotCatalogue.js') as typeof import('../../services/providers/moonshot/moonshotCatalogue.js')
  const { source } = moonshotCatalogueRows()
  if (source.kind === 'live') return { kind: 'live', count: source.count, fetchedAtMs: source.fetchedAtMs }
  if (source.kind === 'pin') return { kind: 'pin' }
  return { kind: 'unread', ...(source.error !== undefined ? { error: source.error } : {}) }
}

function deepseekListState(): BareFamilyListState {
  const { deepseekCatalogueRows, getCachedDeepseekCatalogue } = require('../../services/providers/deepseek/deepseekCatalogue.js') as typeof import('../../services/providers/deepseek/deepseekCatalogue.js')
  const { source } = deepseekCatalogueRows()
  if (source.kind === 'live') return { kind: 'live', count: source.count, fetchedAtMs: source.fetchedAtMs }
  const error = gateError('deepseek') ?? getCachedDeepseekCatalogue()?.lastError
  return error === undefined ? { kind: 'pin' } : { kind: 'unread', error }
}

function grokListState(): BareFamilyListState {
  const { xaiCatalogueRows, getCachedXaiCatalogue } = require('../../services/providers/xai/xaiCatalogue.js') as typeof import('../../services/providers/xai/xaiCatalogue.js')
  const { source } = xaiCatalogueRows()
  if (source.kind === 'live') return { kind: 'live', count: source.count, fetchedAtMs: source.fetchedAtMs }
  const error = gateError('xai') ?? getCachedXaiCatalogue()?.lastError
  return { kind: 'unread', ...(error !== undefined ? { error } : {}) }
}

function museListState(): BareFamilyListState {
  const { metaCatalogueRows, getCachedMetaCatalogue } = require('../../services/providers/meta/metaCatalogue.js') as typeof import('../../services/providers/meta/metaCatalogue.js')
  const { source } = metaCatalogueRows()
  if (source.kind === 'live') return { kind: 'live', count: source.count, fetchedAtMs: source.fetchedAtMs }
  const error = gateError('meta') ?? getCachedMetaCatalogue()?.lastError
  return { kind: 'unread', ...(error !== undefined ? { error } : {}) }
}

function mistralListState(): BareFamilyListState {
  const { mistralCatalogueRows, getCachedMistralCatalogue } = require('../../services/providers/mistral/mistralCatalogue.js') as typeof import('../../services/providers/mistral/mistralCatalogue.js')
  const { source } = mistralCatalogueRows()
  if (source.kind === 'live') return { kind: 'live', count: source.count, fetchedAtMs: source.fetchedAtMs }
  const error = gateError('mistral') ?? getCachedMistralCatalogue()?.lastError
  return { kind: 'unread', ...(error !== undefined ? { error } : {}) }
}

function glmKnownRows(): BareFamilyWordRow[] {
  const { GLM_DISPLAY_PINS } = require('../../services/providers/zai/glmPins.js') as typeof import('../../services/providers/zai/glmPins.js')
  return GLM_DISPLAY_PINS.map(pin => ({ id: pin.id, displayName: pin.displayName }))
}

function glmKnownRow(id: string): BareFamilyWordRow | undefined {
  const { glmDisplayPin } = require('../../services/providers/zai/glmPins.js') as typeof import('../../services/providers/zai/glmPins.js')
  const pin = glmDisplayPin(bareModelIdOf(id))
  return pin === undefined ? undefined : { id: pin.id, displayName: pin.displayName }
}

function kimiKnownRows(): BareFamilyWordRow[] {
  const { KIMI_DISPLAY_PINS } = require('../../services/providers/moonshot/kimiPins.js') as typeof import('../../services/providers/moonshot/kimiPins.js')
  return KIMI_DISPLAY_PINS.map(pin => ({ id: pin.id, displayName: pin.displayName }))
}

function kimiKnownRow(id: string): BareFamilyWordRow | undefined {
  const { kimiDisplayPin } = require('../../services/providers/moonshot/kimiPins.js') as typeof import('../../services/providers/moonshot/kimiPins.js')
  const pin = kimiDisplayPin(bareModelIdOf(id))
  return pin === undefined ? undefined : { id: pin.id, displayName: pin.displayName }
}

function deepseekKnownRows(): BareFamilyWordRow[] {
  const { DEEPSEEK_DISPLAY_PINS } = require('../../services/providers/deepseek/deepseekPins.js') as typeof import('../../services/providers/deepseek/deepseekPins.js')
  return DEEPSEEK_DISPLAY_PINS.map(pin => ({ id: pin.id, displayName: pin.displayName }))
}

function deepseekKnownRow(id: string): BareFamilyWordRow | undefined {
  const { deepseekDisplayPin } = require('../../services/providers/deepseek/deepseekPins.js') as typeof import('../../services/providers/deepseek/deepseekPins.js')
  const pin = deepseekDisplayPin(bareModelIdOf(id))
  return pin === undefined ? undefined : { id: pin.id, displayName: pin.displayName }
}

function grokKnownRows(): BareFamilyWordRow[] {
  const { XAI_DISPLAY_PINS } = require('../../services/providers/xai/xaiPins.js') as typeof import('../../services/providers/xai/xaiPins.js')
  return XAI_DISPLAY_PINS.map(pin => ({ id: pin.id, displayName: pin.displayName }))
}

function grokKnownRow(id: string): BareFamilyWordRow | undefined {
  const { xaiDisplayPin } = require('../../services/providers/xai/xaiPins.js') as typeof import('../../services/providers/xai/xaiPins.js')
  const pin = xaiDisplayPin(bareModelIdOf(id))
  return pin === undefined ? undefined : { id: pin.id, displayName: pin.displayName }
}

function museKnownRows(): BareFamilyWordRow[] {
  const { META_DISPLAY_PINS } = require('../../services/providers/meta/metaPins.js') as typeof import('../../services/providers/meta/metaPins.js')
  return META_DISPLAY_PINS.map(pin => ({ id: pin.id, displayName: pin.displayName }))
}

function museKnownRow(id: string): BareFamilyWordRow | undefined {
  const { metaDisplayPin } = require('../../services/providers/meta/metaPins.js') as typeof import('../../services/providers/meta/metaPins.js')
  const pin = metaDisplayPin(bareModelIdOf(id))
  return pin === undefined ? undefined : { id: pin.id, displayName: pin.displayName }
}

function mistralKnownRows(): BareFamilyWordRow[] {
  const { MISTRAL_DISPLAY_PINS } = require('../../services/providers/mistral/mistralPins.js') as typeof import('../../services/providers/mistral/mistralPins.js')
  return MISTRAL_DISPLAY_PINS.map(pin => ({ id: pin.id, displayName: pin.displayName }))
}

function mistralKnownRow(id: string): BareFamilyWordRow | undefined {
  const { mistralDisplayPin } = require('../../services/providers/mistral/mistralPins.js') as typeof import('../../services/providers/mistral/mistralPins.js')
  const pin = mistralDisplayPin(bareModelIdOf(id))
  return pin === undefined ? undefined : { id: pin.id, displayName: pin.displayName }
}

function minimaxHeadRow(): BareFamilyWordRow | undefined {
  const { minimaxCatalogueRows } = require('../../services/providers/minimax/minimaxCatalogue.js') as typeof import('../../services/providers/minimax/minimaxCatalogue.js')
  const { rows, source } = minimaxCatalogueRows()
  return source.kind === 'live' ? rows[0] : undefined
}

function minimaxPinnedDefault(): BareFamilyWordRow | undefined {
  const { MINIMAX_DISPLAY_PINS } = require('../../services/providers/minimax/minimaxPins.js') as typeof import('../../services/providers/minimax/minimaxPins.js')
  const pin = MINIMAX_DISPLAY_PINS[0]
  return pin === undefined ? undefined : { id: pin.wireId, displayName: pin.displayName }
}

function minimaxListState(): BareFamilyListState {
  const { getCachedMinimaxCatalogue } = require('../../services/providers/minimax/minimaxCatalogue.js') as typeof import('../../services/providers/minimax/minimaxCatalogue.js')
  const snapshot = getCachedMinimaxCatalogue()
  if (snapshot && snapshot.fetchedAtMs > 0) return { kind: 'live', count: snapshot.models.length, fetchedAtMs: snapshot.fetchedAtMs }
  const error = gateError('minimax') ?? snapshot?.lastError
  return { kind: 'unread', ...(error !== undefined ? { error } : {}) }
}

function minimaxKnownRows(): BareFamilyWordRow[] {
  const { MINIMAX_DISPLAY_PINS } = require('../../services/providers/minimax/minimaxPins.js') as typeof import('../../services/providers/minimax/minimaxPins.js')
  return MINIMAX_DISPLAY_PINS.map(pin => ({ id: pin.wireId, displayName: pin.displayName }))
}

function minimaxKnownRow(id: string): BareFamilyWordRow | undefined {
  const { minimaxDisplayPin } = require('../../services/providers/minimax/minimaxPins.js') as typeof import('../../services/providers/minimax/minimaxPins.js')
  const pin = minimaxDisplayPin(bareModelIdOf(id))
  return pin === undefined ? undefined : { id: pin.wireId, displayName: pin.displayName }
}

function cohereHeadRow(): BareFamilyWordRow | undefined {
  const { cohereCatalogueRows } = require('../../services/providers/cohere/cohereCatalogue.js') as typeof import('../../services/providers/cohere/cohereCatalogue.js')
  const { rows, source } = cohereCatalogueRows()
  return source.kind === 'live' ? rows[0] : undefined
}

function coherePinnedDefault(): BareFamilyWordRow | undefined {
  const { COHERE_DISPLAY_PINS } = require('../../services/providers/cohere/coherePins.js') as typeof import('../../services/providers/cohere/coherePins.js')
  const pin = COHERE_DISPLAY_PINS[0]
  return pin === undefined ? undefined : { id: pin.id, displayName: pin.displayName }
}

function cohereListState(): BareFamilyListState {
  const { getCachedCohereCatalogue } = require('../../services/providers/cohere/cohereCatalogue.js') as typeof import('../../services/providers/cohere/cohereCatalogue.js')
  const snapshot = getCachedCohereCatalogue()
  if (snapshot && snapshot.fetchedAtMs > 0) return { kind: 'live', count: snapshot.models.length, fetchedAtMs: snapshot.fetchedAtMs }
  const error = gateError('cohere') ?? snapshot?.lastError
  return { kind: 'unread', ...(error !== undefined ? { error } : {}) }
}

function cohereKnownRows(): BareFamilyWordRow[] {
  const { COHERE_DISPLAY_PINS } = require('../../services/providers/cohere/coherePins.js') as typeof import('../../services/providers/cohere/coherePins.js')
  return COHERE_DISPLAY_PINS.map(pin => ({ id: pin.id, displayName: pin.displayName }))
}

function cohereKnownRow(id: string): BareFamilyWordRow | undefined {
  const { cohereDisplayPin } = require('../../services/providers/cohere/coherePins.js') as typeof import('../../services/providers/cohere/coherePins.js')
  const pin = cohereDisplayPin(bareModelIdOf(id))
  return pin === undefined ? undefined : { id: pin.id, displayName: pin.displayName }
}

function qwenHeadRow(): BareFamilyWordRow | undefined {
  const { qwenCatalogueRows } = require('../../services/providers/qwen/qwenCatalogue.js') as typeof import('../../services/providers/qwen/qwenCatalogue.js')
  const { rows, source } = qwenCatalogueRows()
  return source.kind === 'live' || source.kind === 'plan' ? rows[0] : undefined
}

function qwenPinnedDefault(): BareFamilyWordRow | undefined {
  const { qwenPinsFor } = require('../../services/providers/qwen/qwenPins.js') as typeof import('../../services/providers/qwen/qwenPins.js')
  const pin = qwenPinsFor('pay-as-you-go')[0]
  return pin === undefined ? undefined : { id: pin.id, displayName: pin.displayName }
}

function qwenListState(): BareFamilyListState {
  const { getCachedQwenCatalogue, qwenCatalogueRows } = require('../../services/providers/qwen/qwenCatalogue.js') as typeof import('../../services/providers/qwen/qwenCatalogue.js')
  const { source } = qwenCatalogueRows()
  if (source.kind === 'live' || source.kind === 'plan') return { kind: 'live', count: source.count, fetchedAtMs: source.fetchedAtMs }
  const error = gateError('qwen') ?? getCachedQwenCatalogue()?.lastError
  return { kind: 'unread', ...(error !== undefined ? { error } : {}) }
}

function qwenKnownRows(): BareFamilyWordRow[] {
  const { qwenPinsFor } = require('../../services/providers/qwen/qwenPins.js') as typeof import('../../services/providers/qwen/qwenPins.js')
  return qwenPinsFor('pay-as-you-go').map(pin => ({ id: pin.id, displayName: pin.displayName }))
}

function qwenKnownRow(id: string): BareFamilyWordRow | undefined {
  const { qwenDisplayPin } = require('../../services/providers/qwen/qwenPins.js') as typeof import('../../services/providers/qwen/qwenPins.js')
  const pin = qwenDisplayPin(bareModelIdOf(id))
  return pin === undefined ? undefined : { id: pin.id, displayName: pin.displayName }
}

export const BARE_FAMILY_WORDS: readonly BareFamilyWord[] = [
  { word: 'glm', route: 'zai', headRow: glmHeadRow, pinnedDefault: glmPinnedDefault, listState: glmListState, knownRows: glmKnownRows, knownRow: glmKnownRow },
  { word: 'kimi', route: 'moonshot', headRow: kimiHeadRow, pinnedDefault: kimiPinnedDefault, listState: kimiListState, knownRows: kimiKnownRows, knownRow: kimiKnownRow },
  { word: 'deepseek', route: 'deepseek', headRow: deepseekHeadRow, pinnedDefault: deepseekPinnedDefault, listState: deepseekListState, knownRows: deepseekKnownRows, knownRow: deepseekKnownRow },
  { word: 'grok', route: 'xai', headRow: grokHeadRow, pinnedDefault: grokPinnedDefault, listState: grokListState, knownRows: grokKnownRows, knownRow: grokKnownRow },
  { word: 'muse', route: 'meta', headRow: museHeadRow, pinnedDefault: musePinnedDefault, listState: museListState, knownRows: museKnownRows, knownRow: museKnownRow },
  { word: 'mistral', route: 'mistral', headRow: mistralHeadRow, pinnedDefault: mistralPinnedDefault, listState: mistralListState, knownRows: mistralKnownRows, knownRow: mistralKnownRow },
  { word: 'minimax', route: 'minimax', headRow: minimaxHeadRow, pinnedDefault: minimaxPinnedDefault, listState: minimaxListState, knownRows: minimaxKnownRows, knownRow: minimaxKnownRow },
  { word: 'cohere', route: 'cohere', headRow: cohereHeadRow, pinnedDefault: coherePinnedDefault, listState: cohereListState, knownRows: cohereKnownRows, knownRow: cohereKnownRow },
  { word: 'qwen', route: 'qwen', headRow: qwenHeadRow, pinnedDefault: qwenPinnedDefault, listState: qwenListState, knownRows: qwenKnownRows, knownRow: qwenKnownRow },
]

function disabled(route: string): boolean {
  const { isProviderDisabled } = require('../../services/providers/disabledProviders.js') as typeof import('../../services/providers/disabledProviders.js')
  return isProviderDisabled(route)
}

export function bareFamilyWordOfRoute(route: string): BareFamilyWord | undefined {
  if (disabled(route)) return undefined
  return BARE_FAMILY_WORDS.find(entry => entry.route === route)
}

export function bareFamilyListWords(word: BareFamilyWord, providerName: string): string {
  const state = word.listState()
  if (state.kind === 'live') return state.count === 0 ? `the ${providerName} model list serves no chat model` : `the ${providerName} model list serves ${state.count} ${state.count === 1 ? 'model' : 'models'}`
  if (state.kind === 'pin') return `the ${providerName} model list has not been read`
  return `the ${providerName} model list could not be read${state.error !== undefined ? ` (${state.error})` : ''}`
}

export function bareFamilyWordOf(word: string): BareFamilyWord | undefined {
  const lowered = word.trim().toLowerCase()
  const entry = BARE_FAMILY_WORDS.find(item => item.word === lowered)
  if (entry && disabled(entry.route)) return undefined
  return entry
}

export function isBareFamilyWord(word: string): boolean {
  return bareFamilyWordOf(word) !== undefined
}

export function resolveBareFamilyWord(word: string): string | undefined {
  const entry = bareFamilyWordOf(word)
  if (entry === undefined) return undefined
  return entry.headRow()?.id ?? entry.word
}
