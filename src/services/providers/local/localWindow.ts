import { getGlobalConfig, saveGlobalConfig } from '../../../utils/config/globalConfig.js'
import { fitLocalWindowOn, localWindowRefusal, type LocalWindowFit, type LocalWindowMeasured } from '../../localServer/localWindowFit.js'
import { cachedLocalMachineTruth, refreshLocalMachineTruth, type LocalServerTruth } from '../../localServer/localServerTruth.js'
import type { LocalModelRecord } from './localDiscovery.js'
import { LOCAL_MODEL_PREFIX, localRecordFor } from './localCatalogue.js'

export type LocalWindowSetting = 'server' | 'max' | number

export const LOCAL_WINDOW_FLOOR = 65_536
export const LOCAL_WINDOW_STEP = 16_384
export const LOCAL_WINDOW_CHOICES: readonly LocalWindowSetting[] = ['server', 32_768, 65_536, 131_072, 'max']

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

export function writeLocalWindowSetting(record: Pick<LocalModelRecord, 'id'>, setting: LocalWindowSetting | undefined): void {
  const key = localWindowSettingKey(record)
  saveGlobalConfig(config => {
    const next = { ...(config.localModelWindows ?? {}) }
    if (setting === undefined) delete next[key]
    else next[key] = setting
    return { ...config, localModelWindows: next }
  })
}

export function doubledRequestWindow(estTokens: number, modelMax?: number): number {
  const doubled = Math.max(0, Math.ceil(estTokens)) * 2
  const rounded = Math.ceil(doubled / LOCAL_WINDOW_STEP) * LOCAL_WINDOW_STEP
  const floored = Math.max(LOCAL_WINDOW_FLOOR, rounded)
  return modelMax !== undefined && modelMax > 0 ? Math.min(modelMax, floored) : floored
}

export type LocalWindowReason = 'max' | 'fit' | 'set' | 'srv' | 'req'

export interface LocalWindowDecision {
  window: number | undefined
  reason: LocalWindowReason
  words: string
  fit?: LocalWindowFit
}

export type LocalWindowFitRecord = Pick<LocalModelRecord, 'id' | 'modelMaxContext' | 'weightsBytes' | 'geometry' | 'contextWindow' | 'servedBytes'>

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

function doubledDecision(record: LocalWindowFitRecord, estTokens: number, why: string): LocalWindowDecision {
  const window = doubledRequestWindow(estTokens, record.modelMaxContext)
  return { window, reason: 'req', words: `${fmt(window)} · ${DOUBLING_RULE} (≈${Math.round(estTokens / 1000)}k asked) — ${why}` }
}

export type LocalWindowUnreadRecord = LocalWindowFitRecord & Partial<Pick<LocalModelRecord, 'contextWindow'>>

export function unreadMachineDecision(record: LocalWindowUnreadRecord, estTokens: number, why: string): LocalWindowDecision {
  const max = record.modelMaxContext
  if (max !== undefined && max > 0) return { window: max, reason: 'max', words: `${fmt(max)} · the trained max — ${why}; ${UNREAD_MACHINE}` }
  const served = record.contextWindow?.source === 'served' ? record.contextWindow.tokens : undefined
  const doubled = doubledRequestWindow(estTokens)
  if (served !== undefined && served >= doubled) return { window: served, reason: 'srv', words: `${fmt(served)} · the served window — ${why}; no trained max stated; ${UNREAD_MACHINE}` }
  return doubledDecision(record, estTokens, `${why}; no trained max stated${served !== undefined ? ` and the served ${fmt(served)} is under the request` : ' and no served window'}; ${UNREAD_MACHINE}`)
}

export function chooseLocalWindow(record: LocalWindowUnreadRecord, estTokens: number, setting: LocalWindowSetting | undefined, truth: LocalServerTruth | null = localWindowTruth()): LocalWindowDecision {
  const max = record.modelMaxContext
  if (setting === 'server') return { window: undefined, reason: 'srv', words: 'server default — the server chooses the window' }
  if (setting === 'max') {
    const fit = localWindowFitOf(record, truth)
    const refusal = fit !== undefined && max !== undefined ? localWindowRefusal(fit, max) : undefined
    return { window: max, reason: 'max', words: max !== undefined ? `${fmt(max)} · the trained max — your setting${refusal !== undefined ? ` — ${refusal}` : ''}` : 'trained max not stated — the server chooses the window', ...(fit !== undefined ? { fit } : {}) }
  }
  if (typeof setting === 'number') {
    const window = max !== undefined ? Math.min(setting, max) : setting
    const fit = localWindowFitOf(record, truth)
    const refusal = fit !== undefined ? localWindowRefusal(fit, window) : undefined
    return { window, reason: 'set', words: `${fmt(window)} · your setting${refusal !== undefined ? ` — ${refusal}` : ''}`, ...(fit !== undefined ? { fit } : {}) }
  }
  const fit = localWindowFitOf(record, truth)
  if (fit !== undefined) return { window: fit.window, reason: fit.atMax ? 'max' : 'fit', words: fit.words, fit }
  if (record.geometry === undefined || record.weightsBytes === undefined) return unreadMachineDecision(record, estTokens, `no KV geometry read for ${record.id}`)
  return unreadMachineDecision(record, estTokens, 'no memory truth read')
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
      return 'server-start'
    case 'openai-compatible':
      return 'none'
  }
}

export interface HeldLocalWindow extends LocalWindowDecision {
  setting: LocalWindowSetting | undefined
  estTokens: number
}

const held = new Map<string, HeldLocalWindow>();

function holdKey(record: Pick<LocalModelRecord, 'id' | 'server'>): string {
  return `${record.server}/${record.id}`
}

export function heldLocalWindow(record: Pick<LocalModelRecord, 'id' | 'server'>): HeldLocalWindow | undefined {
  return held.get(holdKey(record))
}

export type LocalWindowDecisionRecord = Pick<LocalModelRecord, 'id' | 'server' | 'modelMaxContext' | 'weightsBytes' | 'geometry' | 'contextWindow' | 'servedBytes'>

export function decideLocalWindow(record: LocalWindowDecisionRecord, estTokens: number, setting: LocalWindowSetting | undefined = localWindowSettingOf(record), truth: LocalServerTruth | null = localWindowTruth()): HeldLocalWindow {
  const application = localWindowApplication(record)
  if (application === 'server-start' || application === 'none') {
    const none: HeldLocalWindow = { window: undefined, reason: 'srv', words: application === 'server-start' ? 'set at server start' : 'not applicable to this server', setting, estTokens }
    held.set(holdKey(record), none)
    return none
  }
  const before = held.get(holdKey(record))
  if (before !== undefined && before.setting === setting) return before
  const decided: HeldLocalWindow = { ...chooseLocalWindow(record, estTokens, setting, truth), setting, estTokens }
  held.set(holdKey(record), decided)
  return decided
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
  set: 'your setting',
  srv: 'the server default',
  req: 'twice the request',
}

export function localWindowRefusalWords(record: LocalWindowFitRecord, setting: LocalWindowSetting | undefined, truth: LocalServerTruth | null = localWindowTruth()): string | undefined {
  const fit = localWindowFitOf(record, truth)
  if (fit === undefined) return undefined
  const window = setting === 'max' ? record.modelMaxContext : typeof setting === 'number' ? (record.modelMaxContext !== undefined ? Math.min(setting, record.modelMaxContext) : setting) : undefined
  return window === undefined ? undefined : localWindowRefusal(fit, window)
}

export type LocalWindowWordsRecord = Pick<LocalModelRecord, 'id' | 'server' | 'modelMaxContext' | 'contextWindow' | 'servedBytes' | 'weightsBytes' | 'geometry'>

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
  const fit = setting === undefined && (hold === undefined || hold.setting !== undefined) ? localWindowFitOf(record, truth) : undefined
  const chosen =
    hold !== undefined && hold.setting === setting && hold.window !== undefined
      ? ` → ${fmt(hold.window)} held this session (${LOCAL_WINDOW_REASON_WORDS[hold.reason]})`
      : fit !== undefined
        ? ` → ${fmt(fit.window)} (${fit.atMax ? LOCAL_WINDOW_REASON_WORDS.max : LOCAL_WINDOW_REASON_WORDS.fit})`
        : ''
  const road = application === 'request' ? 'num_ctx on every request' : 'applied at load'
  return `${localWindowSettingWords(setting)}${refused}${chosen}${served} · ${road}`
}

export function localWindowReasonTag(model: string, window: number): LocalWindowReason | undefined {
  const record = localRecordFor(model)
  if (record === undefined || !(window > 0)) return undefined
  const hold = heldLocalWindow(record)
  if (hold?.window !== undefined) return hold.window === window ? hold.reason : undefined
  return record.contextWindow?.source === 'served' && record.contextWindow.tokens === window ? 'srv' : undefined
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
  const fit = hold === undefined || hold.setting !== undefined ? localWindowFitOf(record, truth) : undefined
  const auto =
    hold !== undefined && hold.setting === undefined && hold.window !== undefined
      ? `auto → ${fmt(hold.window)} ${hold.reason} held`
      : fit !== undefined
        ? `auto → ${fmt(fit.window)} ${fit.atMax ? 'max' : 'fit'}`
        : 'auto'
  const number = rung === 'number' && typeof setting === 'number' ? fmt(setting) : 'number'
  const refusal = localWindowRefusalWords(record, setting, truth)
  const rungs: Array<[LocalWindowRung, string]> = [[undefined, auto], ['server', 'server'], [32_768, '32k'], [65_536, '64k'], [131_072, '128k'], ['max', 'max'], ['number', number]]
  const shown = opts.wide || rung === 'number' ? rungs : rungs.filter(([key]) => key !== 'number')
  const ladder = shown.map(([key, label]) => (key === rung ? `[${label}${refusal !== undefined ? ` — ${refusal}` : ''}]` : label)).join(' · ')
  if (application === 'server-start' || application === 'none') return `window · ${state} · set at server start · not a toggle`
  if (!opts.wide) return record.contextWindow === undefined ? `window · not loaded ${ladder} · w cycles` : `window ${ladder} · w cycles`
  return `window · ${state}${trained} · ${ladder} · w cycles`
}

export function localWindowRefusalSpan(line: string): { start: number; end: number } | undefined {
  const head = /\[[^\]]* — [^\]]*(?:\]|$)/.exec(line)
  if (head !== null) return { start: head.index, end: head.index + head[0].length }
  const tail = /^[^[]*?fits\]/.exec(line)
  return tail === null ? undefined : { start: 0, end: tail[0].length }
}
