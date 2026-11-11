import { getGlobalConfig, saveGlobalConfig } from '../../../utils/config/globalConfig.js'
import { fitLocalWindowOn, localWindowRefusal, localWindowRoomWarning, type LocalWindowFit, type LocalWindowFitRung, type LocalWindowMeasured } from '../../localServer/localWindowFit.js'
import { cachedLocalMachineTruth, refreshLocalMachineTruth, type LocalServerTruth } from '../../localServer/localServerTruth.js'
import { bumpCatalogueEpoch } from '../catalogueEpoch.js'
import type { LocalContextSource, LocalModelRecord } from './localDiscovery.js'
import { LOCAL_MODEL_PREFIX, localContextSourceWords, localRecordFor } from './localCatalogue.js'

export type LocalWindowSetting = 'server' | 'max' | number

export const LOCAL_WINDOW_FLOOR = 65_536
export const LOCAL_WINDOW_STEP = 16_384
export const LOCAL_WINDOW_CHOICES: readonly LocalWindowSetting[] = ['server', 32_768, 65_536, 131_072, 'max']
export const LOCAL_WINDOW_AUTO_CEILING = 131_072

export function localWindowSettingKey(record: Pick<LocalModelRecord, 'id'>): string {
  return `${LOCAL_MODEL_PREFIX}${record.id}`
}

export function parseLocalWindowSetting(raw: unknown): LocalWindowSetting | undefined {
  if (raw === 'server' || raw === 'max') return raw
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1024) return Math.floor(raw)
  if (typeof raw === 'string') {
    const m = /^(\d+)\s*([kK])?$/.exec(raw.trim())
    if (m) {
      const n = Number(m[1]) * (m[2] ? 1024 : 1)
      return n >= 1024 ? n : undefined
    }
  }
  return undefined
}

export function localWindowSettingOf(record: Pick<LocalModelRecord, 'id'>, config: { localModelWindows?: Record<string, unknown> } = getGlobalConfig()): LocalWindowSetting | undefined {
  return parseLocalWindowSetting(config.localModelWindows?.[localWindowSettingKey(record)])
}

export const LOCAL_BATCH_DEFAULT = 2048

export function localBatchSettingOf(record: Pick<LocalModelRecord, 'id'>, config: { localModelBatch?: Record<string, unknown> } = getGlobalConfig()): number | undefined {
  const raw = config.localModelBatch?.[localWindowSettingKey(record)]
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 32 ? Math.floor(raw) : undefined
}

export function chooseLocalBatch(setting: number | undefined, numCtx: number | undefined): number {
  const asked = setting ?? LOCAL_BATCH_DEFAULT
  return numCtx !== undefined ? Math.min(asked, numCtx) : asked
}

export const LOCAL_OUTPUT_FLOOR = 1024

export interface LocalRunnerKnobs {
  numCtx?: number
  numBatch: number
}

export function heldLocalKnobs(record: Pick<LocalModelRecord, 'id' | 'server'>): LocalRunnerKnobs {
  const window = heldLocalWindow(record)?.window
  return { ...(window !== undefined ? { numCtx: window } : {}), numBatch: chooseLocalBatch(localBatchSettingOf(record), window) }
}

export function localWindowFits(window: number | undefined, estTokens: number): boolean {
  return window === undefined || estTokens + LOCAL_OUTPUT_FLOOR <= window
}

export function writeLocalWindowSetting(record: Pick<LocalModelRecord, 'id'>, setting: LocalWindowSetting | undefined, save: typeof saveGlobalConfig = saveGlobalConfig): void {
  const key = localWindowSettingKey(record)
  save(config => {
    const next = { ...(config.localModelWindows ?? {}) }
    if (setting === undefined) delete next[key]
    else next[key] = setting
    return { ...config, localModelWindows: next }
  })
  bumpCatalogueEpoch()
}

export function doubledRequestWindow(estTokens: number, modelMax?: number): number {
  const doubled = Math.max(0, Math.ceil(estTokens)) * 2
  const rounded = Math.ceil(doubled / LOCAL_WINDOW_STEP) * LOCAL_WINDOW_STEP
  const floored = Math.max(LOCAL_WINDOW_FLOOR, rounded)
  return modelMax !== undefined && modelMax > 0 ? Math.min(modelMax, floored) : floored
}

export type LocalWindowReason = 'max' | 'fit' | 'cap' | 'set' | 'srv' | 'req'

export interface LocalWindowDecision {
  window: number | undefined
  reason: LocalWindowReason
  words: string
  fit?: LocalWindowFit
}

export type LocalWindowFitRecord = Pick<LocalModelRecord, 'id' | 'modelMaxContext' | 'modelfileContext' | 'weightsBytes' | 'geometry' | 'contextWindow' | 'servedBytes'>

export function localWindowTruth(): LocalServerTruth | null {
  return cachedLocalMachineTruth()
}

export function localWindowMeasuredOf(record: Pick<LocalModelRecord, 'contextWindow' | 'servedBytes'>): LocalWindowMeasured | undefined {
  if (record.contextWindow?.source !== 'served' || record.servedBytes === undefined || !(record.servedBytes > 0)) return undefined
  return { bytes: record.servedBytes, window: record.contextWindow.tokens }
}

export function localWindowFitOf(record: LocalWindowFitRecord, truth: LocalServerTruth | null = localWindowTruth()): LocalWindowFit | undefined {
  if (truth === null || record.geometry === undefined || record.weightsBytes === undefined) return undefined
  const measured = localWindowMeasuredOf(record)
  return fitLocalWindowOn(truth, { name: record.id, weightsBytes: record.weightsBytes, geometry: record.geometry, ...(record.modelMaxContext !== undefined ? { trainedMax: record.modelMaxContext } : {}), ...(measured !== undefined ? { measured } : {}) })
}

const fmt = (n: number): string => (n >= 1024 && n % 1024 === 0 ? `${n / 1024}k` : String(n))
const DOUBLING_RULE = 'twice the first request, rounded up to 16k, never under 64k'
const UNREAD_MACHINE = "the machine's memory was not read, so the window comes out bigger, not smaller"
const AUTO_CEILING_RULE = 'pin trained max or a number in /config for more'
const MODELFILE_RULE = "the Modelfile's num_ctx"

function doubledDecision(record: LocalWindowFitRecord, estTokens: number, why: string): LocalWindowDecision {
  const doubled = doubledRequestWindow(estTokens, record.modelMaxContext)
  const asked = Math.ceil(Math.max(0, Math.ceil(estTokens)) / LOCAL_WINDOW_STEP) * LOCAL_WINDOW_STEP
  const window = Math.min(doubled, Math.max(LOCAL_WINDOW_AUTO_CEILING, asked))
  if (window < doubled) return { window, reason: 'cap', words: `${fmt(window)} · the automatic ceiling (${DOUBLING_RULE} would be ${fmt(doubled)}; ≈${Math.round(estTokens / 1000)}k asked) — ${why}; ${AUTO_CEILING_RULE}` }
  return { window, reason: 'req', words: `${fmt(window)} · ${DOUBLING_RULE} (≈${Math.round(estTokens / 1000)}k asked) — ${why}` }
}

export function cappedLocalWindowFit(fit: LocalWindowFit): LocalWindowFit {
  const auto = autoWindowOfFit(fit)
  return { ...fit, window: auto.window, fits: auto.rung.fits, cacheBytes: auto.rung.cacheBytes, totalBytes: auto.rung.totalBytes, atMax: auto.reason === 'max', words: auto.words }
}

export type LocalWindowUnreadRecord = LocalWindowFitRecord & Partial<Pick<LocalModelRecord, 'contextWindow'>>

export function unreadMachineDecision(record: LocalWindowUnreadRecord, estTokens: number, why: string): LocalWindowDecision {
  const max = record.modelMaxContext
  if (max !== undefined && max > 0) {
    if (max > LOCAL_WINDOW_AUTO_CEILING) return { window: LOCAL_WINDOW_AUTO_CEILING, reason: 'cap', words: `${fmt(LOCAL_WINDOW_AUTO_CEILING)} · the automatic ceiling (${fmt(max)} trained) — ${why}; ${UNREAD_MACHINE}; ${AUTO_CEILING_RULE}` }
    return { window: max, reason: 'max', words: `${fmt(max)} · the trained max — ${why}; ${UNREAD_MACHINE}` }
  }
  const served = record.contextWindow?.source === 'served' ? record.contextWindow.tokens : undefined
  const doubled = doubledRequestWindow(estTokens)
  if (served !== undefined && served >= doubled) return { window: served, reason: 'srv', words: `${fmt(served)} · the served window — ${why}; no trained max stated; ${UNREAD_MACHINE}` }
  return doubledDecision(record, estTokens, `${why}; no trained max stated${served !== undefined ? ` and the served ${fmt(served)} is under the request` : ' and no served window'}; ${UNREAD_MACHINE}`)
}

export function localWindowModelfileAutoWords(record: LocalWindowUnreadRecord, truth: LocalServerTruth | null = localWindowTruth()): string | undefined {
  const auto = chooseLocalWindow(record, 0, undefined, truth)
  return auto.reason === 'set' ? `${MODELFILE_RULE}, never raised; trained max or a number of yours replaces it` : undefined
}

export function chooseLocalWindow(record: LocalWindowUnreadRecord, estTokens: number, setting: LocalWindowSetting | undefined, truth: LocalServerTruth | null = localWindowTruth()): LocalWindowDecision {
  const max = record.modelMaxContext
  if (setting === 'server') return { window: undefined, reason: 'srv', words: 'server default — the server chooses the window' }
  if (setting === 'max') {
    const fit = localWindowFitOf(record, truth)
    const refusal = fit !== undefined && max !== undefined ? localWindowRefusal(fit, max) : undefined
    return { window: max, reason: 'max', words: max !== undefined ? `${fmt(max)} · the trained max — your setting${refusal !== undefined ? ` — ${refusal}` : ''}` : 'trained max not stated — the server chooses the window', ...(fit !== undefined ? { fit } : {}) }
  }
  const stated = typeof setting === 'number' ? setting : record.modelfileContext
  if (stated !== undefined) {
    const window = max !== undefined ? Math.min(stated, max) : stated
    const fit = localWindowFitOf(record, truth)
    const refusal = fit !== undefined ? localWindowRefusal(fit, window) : undefined
    return { window, reason: 'set', words: `${fmt(window)} · ${typeof setting === 'number' ? 'your setting' : MODELFILE_RULE}${refusal !== undefined ? ` — ${refusal}` : ''}`, ...(fit !== undefined ? { fit } : {}) }
  }
  const fit = localWindowFitOf(record, truth)
  if (fit !== undefined) return { ...autoWindowOfFit(fit), fit }
  if (record.geometry === undefined || record.weightsBytes === undefined) return unreadMachineDecision(record, estTokens, `no KV geometry read for ${record.id}`)
  return unreadMachineDecision(record, estTokens, 'no memory truth read')
}

export interface LocalWindowAuto {
  window: number
  reason: LocalWindowReason
  words: string
  rung: LocalWindowFitRung
}

export function autoWindowOfFit(fit: LocalWindowFit): LocalWindowAuto {
  const chosen = fit.ladder.find(rung => rung.window === fit.window) ?? fit.ladder[0]!
  const capped = fit.ladder.filter(rung => rung.fits && rung.window <= LOCAL_WINDOW_AUTO_CEILING).at(-1)
  if (fit.window > LOCAL_WINDOW_AUTO_CEILING && capped !== undefined) return { window: capped.window, reason: 'cap', words: `${fmt(capped.window)} · the automatic ceiling (${fmt(fit.window)} fits: ${fit.words.slice(fit.words.indexOf('· ') + 2)}) · ${AUTO_CEILING_RULE}`, rung: capped }
  return { window: fit.window, reason: fit.atMax ? 'max' : 'fit', words: fit.words, rung: chosen }
}

function predictedAutoWindow(record: LocalWindowFitRecord, truth: LocalServerTruth | null): Pick<LocalWindowAuto, 'window' | 'reason'> | undefined {
  if (record.modelfileContext !== undefined) {
    const { window, reason } = chooseLocalWindow(record, 0, undefined, truth)
    return window === undefined ? undefined : { window, reason }
  }
  const fit = localWindowFitOf(record, truth)
  return fit === undefined ? undefined : autoWindowOfFit(fit)
}

export type LocalWindowApplication = 'request' | 'load' | 'server-start' | 'none'

export function localWindowApplication(record: Pick<LocalModelRecord, 'server'>): LocalWindowApplication {
  switch (record.server) {
    case 'ollama':
      return 'request'
    case 'lmstudio':
      return 'load'
    case 'vllm':
    case 'llamacpp':
    case 'tensorfold':
      return 'server-start'
    case 'openai-compatible':
      return 'none'
  }
}

export interface HeldLocalWindow extends LocalWindowDecision {
  setting: LocalWindowSetting | undefined
  estTokens: number
  adopted?: true
}

const held = new Map<string, HeldLocalWindow>();

function holdKey(record: Pick<LocalModelRecord, 'id' | 'server'>): string {
  return `${record.server}/${record.id}`
}

export function heldLocalWindow(record: Pick<LocalModelRecord, 'id' | 'server'>): HeldLocalWindow | undefined {
  return held.get(holdKey(record))
}

function setHeld(record: Pick<LocalModelRecord, 'id' | 'server'>, hold: HeldLocalWindow | undefined): void {
  const key = holdKey(record)
  const before = held.get(key)
  if (hold === undefined) held.delete(key)
  else held.set(key, hold)
  if (before?.window !== hold?.window || before?.setting !== hold?.setting) bumpCatalogueEpoch()
}

export function adoptableLocalWindow(hold: Pick<HeldLocalWindow, 'window' | 'setting'>, resident: number | undefined, estTokens: number): resident is number {
  if (resident === undefined || resident === hold.window || hold.setting !== 'server') return false
  if (hold.window !== undefined && resident < hold.window) return false
  return localWindowFits(resident, estTokens)
}

export function adoptLocalWindow(record: Pick<LocalModelRecord, 'id' | 'server'>, hold: HeldLocalWindow, resident: number): HeldLocalWindow {
  const adopted: HeldLocalWindow = { ...hold, window: resident, reason: 'srv', words: `${fmt(resident)} · the window the server already holds this model at — adopted, so the runner is not reloaded`, adopted: true }
  setHeld(record, adopted)
  return adopted
}

export function releaseOutgrownLocalWindow(record: Pick<LocalModelRecord, 'id' | 'server'>, estTokens: number): boolean {
  const hold = held.get(holdKey(record))
  if (hold === undefined || hold.adopted !== true || localWindowFits(hold.window, estTokens)) return false
  setHeld(record, undefined)
  return true
}

export type LocalWindowDecisionRecord = Pick<LocalModelRecord, 'id' | 'server' | 'modelMaxContext' | 'modelfileContext' | 'weightsBytes' | 'geometry' | 'contextWindow' | 'servedBytes'>

export function localWindowHeldUnread(hold: Pick<HeldLocalWindow, 'setting' | 'reason' | 'adopted'>, record: Pick<LocalModelRecord, 'modelfileContext'>): boolean {
  return hold.setting === undefined && hold.reason !== 'set' && hold.adopted !== true && record.modelfileContext !== undefined
}

export function decideLocalWindow(record: LocalWindowDecisionRecord, estTokens: number, setting: LocalWindowSetting | undefined = localWindowSettingOf(record), truth: LocalServerTruth | null = localWindowTruth()): HeldLocalWindow {
  const application = localWindowApplication(record)
  if (application === 'server-start' || application === 'none') {
    const none: HeldLocalWindow = { window: undefined, reason: 'srv', words: application === 'server-start' ? 'set at server start' : 'not applicable to this server', setting, estTokens }
    setHeld(record, none)
    return none
  }
  const before = held.get(holdKey(record))
  if (before !== undefined && before.setting === setting && !localWindowHeldUnread(before, record)) return before
  const decided: HeldLocalWindow = { ...chooseLocalWindow(record, estTokens, setting, truth), setting, estTokens }
  setHeld(record, decided)
  return decided
}

export const LOCAL_WINDOW_HELD_WORDS = 'chosen by Mercury for this session (auto) — /config → Local model window'
export const LOCAL_WINDOW_SETTING_WORDS = 'your setting — /config → Local model window'

export function localWindowSourceWords(decision: Pick<HeldLocalWindow, 'reason' | 'setting'>): string {
  if (decision.setting !== undefined) return LOCAL_WINDOW_SETTING_WORDS
  return decision.reason === 'set' ? localContextSourceWords('modelfile') : LOCAL_WINDOW_HELD_WORDS
}

export interface LocalPlannedWindow {
  tokens: number
  source: 'held' | 'setting' | 'auto' | LocalContextSource
  reason: LocalWindowReason | undefined
  sourceWords: string
}

function statedLocalWindow(record: Pick<LocalModelRecord, 'contextWindow'>): LocalPlannedWindow | undefined {
  const stated = record.contextWindow
  if (stated === undefined) return undefined
  return { tokens: stated.tokens, source: stated.source, reason: stated.source === 'served' ? 'srv' : undefined, sourceWords: localContextSourceWords(stated.source) }
}

export function localPlannedWindow(record: LocalWindowDecisionRecord, setting: LocalWindowSetting | undefined = localWindowSettingOf(record), truth: LocalServerTruth | null = localWindowTruth()): LocalPlannedWindow | undefined {
  const application = localWindowApplication(record)
  if (application !== 'request' && application !== 'load') return statedLocalWindow(record)
  const hold = heldLocalWindow(record)
  if (hold !== undefined && hold.setting === setting) {
    if (hold.window === undefined) return statedLocalWindow(record)
    return { tokens: hold.window, source: 'held', reason: hold.reason, sourceWords: localWindowSourceWords(hold) }
  }
  if (setting === 'server') return statedLocalWindow(record)
  const choice = chooseLocalWindow(record, 0, setting, truth)
  if (choice.window === undefined) return statedLocalWindow(record)
  if (setting === undefined && (choice.reason === 'req' || choice.reason === 'srv')) return undefined
  return { tokens: choice.window, source: setting === undefined ? 'auto' : 'setting', reason: choice.reason, sourceWords: localWindowSourceWords({ reason: choice.reason, setting }) }
}

export async function ensureLocalWindowTruth(record: LocalWindowDecisionRecord, setting: LocalWindowSetting | undefined = localWindowSettingOf(record)): Promise<LocalServerTruth | null> {
  const before = heldLocalWindow(record)
  if (before !== undefined && before.setting === setting) return localWindowTruth()
  if (setting === 'server' || setting === 'max') return localWindowTruth()
  if (record.geometry === undefined || record.weightsBytes === undefined) return localWindowTruth()
  try {
    return await refreshLocalMachineTruth(record.server)
  } catch {
    return localWindowTruth()
  }
}

export function __resetLocalWindowsForTest(): void {
  held.clear()
}

export function localWindowDecisionLine(record: Pick<LocalModelRecord, 'id'>, decision: LocalWindowDecision): string {
  return `[local-window] ${record.id}: ${decision.window !== undefined ? String(decision.window) : 'server default'} · ${decision.reason} — ${decision.words}`
}

export function localWindowSettingWords(setting: LocalWindowSetting | undefined): string {
  if (setting === undefined) return 'auto'
  if (setting === 'server') return 'server default'
  if (setting === 'max') return 'trained max'
  return fmt(setting)
}

export const LOCAL_WINDOW_REASON_WORDS: Readonly<Record<LocalWindowReason, string>> = {
  max: 'the trained max',
  fit: 'the biggest rung that fits',
  cap: 'the automatic ceiling',
  set: 'your setting',
  srv: 'the window the server holds it at',
  req: 'twice the request',
}

function reasonWords(reason: LocalWindowReason, setting: LocalWindowSetting | undefined): string {
  return reason === 'set' && setting === undefined ? MODELFILE_RULE : LOCAL_WINDOW_REASON_WORDS[reason]
}

function pickedLocalWindow(record: Pick<LocalModelRecord, 'modelMaxContext'>, setting: LocalWindowSetting | undefined): number | undefined {
  if (setting === 'max') return record.modelMaxContext
  if (typeof setting === 'number') return record.modelMaxContext !== undefined ? Math.min(setting, record.modelMaxContext) : setting
  return undefined
}

export function localWindowRefusalWords(record: LocalWindowFitRecord, setting: LocalWindowSetting | undefined, truth: LocalServerTruth | null = localWindowTruth()): string | undefined {
  const fit = localWindowFitOf(record, truth)
  const window = pickedLocalWindow(record, setting)
  return fit === undefined || window === undefined ? undefined : localWindowRefusal(fit, window)
}

export function localWindowRoomWords(record: LocalWindowFitRecord, setting: LocalWindowSetting | undefined, truth: LocalServerTruth | null = localWindowTruth()): string | undefined {
  const fit = localWindowFitOf(record, truth)
  const window = pickedLocalWindow(record, setting)
  return fit === undefined || window === undefined ? undefined : localWindowRoomWarning(fit, window)
}

export type LocalWindowWordsRecord = Pick<LocalModelRecord, 'id' | 'server' | 'modelMaxContext' | 'modelfileContext' | 'contextWindow' | 'servedBytes' | 'weightsBytes' | 'geometry'>

export function localWindowValueWords(record: LocalWindowWordsRecord, setting: LocalWindowSetting | undefined = localWindowSettingOf(record), truth: LocalServerTruth | null = localWindowTruth()): string {
  const application = localWindowApplication(record)
  const served = record.contextWindow?.source === 'served' ? ` · served ${fmt(record.contextWindow.tokens)}` : ''
  if (application === 'server-start') {
    return `set at server start${served}${record.contextWindow === undefined ? ' · not stated' : ''} · n/a`
  }
  if (application === 'none') return 'not applicable to this server'
  const hold = heldLocalWindow(record)
  const refusal = localWindowRefusalWords(record, setting, truth)
  const refused = refusal !== undefined ? ` — ${refusal}` : ''
  const auto = setting === undefined && (hold === undefined || hold.setting !== undefined) ? predictedAutoWindow(record, truth) : undefined
  const chosen =
    hold !== undefined && hold.setting === setting && hold.window !== undefined
      ? ` → ${fmt(hold.window)} held this session (${reasonWords(hold.reason, setting)})`
      : auto !== undefined
        ? ` → ${fmt(auto.window)} (${reasonWords(auto.reason, setting)})`
        : ''
  const road = application === 'request' ? 'num_ctx on every request' : 'applied at load'
  return `${localWindowSettingWords(setting)}${refused}${chosen}${served} · ${road}`
}

export function localWindowReasonTag(model: string, window: number): LocalWindowReason | undefined {
  const record = localRecordFor(model)
  if (record === undefined || !(window > 0)) return undefined
  const planned = localPlannedWindow(record)
  return planned !== undefined && planned.tokens === window ? planned.reason : undefined
}

export function localWindowRuleWords(model: string, window: number): string | undefined {
  const record = localRecordFor(model)
  if (record === undefined || !(window > 0)) return undefined
  const hold = heldLocalWindow(record)
  return hold?.window !== undefined && hold.window === window ? hold.words : undefined
}

export function nextLocalWindowSetting(current: LocalWindowSetting | undefined, direction: 1 | -1): LocalWindowSetting | undefined {
  const ladder: Array<LocalWindowSetting | undefined> = [undefined, ...LOCAL_WINDOW_CHOICES]
  const at = ladder.findIndex(entry => entry === current)
  const base = at < 0 ? 0 : at
  return ladder[(base + direction + ladder.length) % ladder.length]
}

export type LocalWindowRung = LocalWindowSetting | 'number' | undefined

export function localWindowRungOf(setting: LocalWindowSetting | undefined): LocalWindowRung {
  if (typeof setting === 'number' && !LOCAL_WINDOW_CHOICES.includes(setting)) return 'number'
  return setting
}

export function localWindowChoiceLine(record: LocalWindowWordsRecord, opts: { wide: boolean; typing?: string; setting?: LocalWindowSetting | undefined; truth?: LocalServerTruth | null }): string {
  if (opts.typing !== undefined) return `window · type the tokens (49152 or 48k) · ↵ sets · esc cancels · ${opts.typing}▍`
  const setting = opts.setting !== undefined ? opts.setting : localWindowSettingOf(record)
  const truth = opts.truth !== undefined ? opts.truth : localWindowTruth()
  const rung = localWindowRungOf(setting)
  const hold = heldLocalWindow(record)
  const application = localWindowApplication(record)
  const state =
    record.contextWindow?.source === 'served'
      ? `served ${fmt(record.contextWindow.tokens)}`
      : record.contextWindow !== undefined
        ? `${localWindowSettingWords(record.contextWindow.tokens)} ${record.contextWindow.source === 'modelfile' ? 'num_ctx' : 'model max'}`
        : 'not loaded'
  const trained = opts.wide && record.contextWindow === undefined && record.modelMaxContext !== undefined ? ` · max ${fmt(record.modelMaxContext)}` : ''
  const predicted = hold === undefined || hold.setting !== undefined ? predictedAutoWindow(record, truth) : undefined
  const auto =
    hold !== undefined && hold.setting === undefined && hold.window !== undefined
      ? `auto → ${fmt(hold.window)} ${hold.reason} held`
      : predicted !== undefined
        ? `auto → ${fmt(predicted.window)} ${predicted.reason}`
        : 'auto'
  const number = rung === 'number' && typeof setting === 'number' ? fmt(setting) : 'number'
  const notice = localWindowRefusalWords(record, setting, truth) ?? localWindowRoomWords(record, setting, truth)
  const rungs: Array<[LocalWindowRung, string]> = [[undefined, auto], ['server', 'server'], [32_768, '32k'], [65_536, '64k'], [131_072, '128k'], ['max', 'max'], ['number', number]]
  const shown = opts.wide || rung === 'number' ? rungs : rungs.filter(([key]) => key !== 'number')
  const ladder = shown.map(([key, label]) => (key === rung ? `[${label}${notice !== undefined ? ` — ${notice}` : ''}]` : label)).join(' · ')
  if (application === 'server-start' || application === 'none') return `window · ${state} · set at server start · not a toggle`
  if (!opts.wide) return record.contextWindow === undefined ? `window · not loaded ${ladder} · ctrl+w cycles` : `window ${ladder} · ctrl+w cycles`
  return `window · ${state}${trained} · ${ladder} · ctrl+w cycles`
}

export function localWindowRefusalSpan(line: string): { start: number; end: number } | undefined {
  const head = /\[[^\]]* — [^\]]*(?:\]|$)/.exec(line)
  if (head !== null) return { start: head.index, end: head.index + head[0].length }
  const tail = /^[^[]*?(?:fits|GiB|room)\]/.exec(line)
  return tail === null ? undefined : { start: 0, end: tail[0].length }
}

export type LocalWindowNoticeKind = 'refusal' | 'warning'

export function localWindowNoticeKind(line: string): LocalWindowNoticeKind | undefined {
  const span = localWindowRefusalSpan(line)
  if (span === undefined) return undefined
  return line.slice(span.start, span.end).includes(' leaves ') ? 'warning' : 'refusal'
}
