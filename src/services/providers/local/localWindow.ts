import { getGlobalConfig, saveGlobalConfig } from '../../../utils/config/globalConfig.js'
import type { LocalModelRecord } from './localDiscovery.js'
import { LOCAL_MODEL_PREFIX } from './localCatalogue.js'

export type LocalWindowSetting = 'server' | 'max' | number

export const LOCAL_WINDOW_FLOOR = 32_768
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

export function autoLocalWindow(estTokens: number, modelMax?: number): number {
  const doubled = Math.max(0, Math.ceil(estTokens)) * 2
  const rounded = Math.ceil(doubled / LOCAL_WINDOW_STEP) * LOCAL_WINDOW_STEP
  const floored = Math.max(LOCAL_WINDOW_FLOOR, rounded)
  return modelMax !== undefined && modelMax > 0 ? Math.min(modelMax, floored) : floored
}

export function chooseLocalWindow(record: Pick<LocalModelRecord, 'modelMaxContext'>, estTokens: number, setting: LocalWindowSetting | undefined): number | undefined {
  if (setting === 'server') return undefined
  if (setting === 'max') return record.modelMaxContext
  if (typeof setting === 'number') return record.modelMaxContext !== undefined ? Math.min(setting, record.modelMaxContext) : setting
  return autoLocalWindow(estTokens, record.modelMaxContext)
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

export interface HeldLocalWindow {
  window: number | undefined
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

export function decideLocalWindow(record: Pick<LocalModelRecord, 'id' | 'server' | 'modelMaxContext'>, estTokens: number, setting: LocalWindowSetting | undefined = localWindowSettingOf(record)): HeldLocalWindow {
  const application = localWindowApplication(record)
  if (application === 'server-start' || application === 'none') {
    const none: HeldLocalWindow = { window: undefined, setting, estTokens }
    held.set(holdKey(record), none)
    return none
  }
  const before = held.get(holdKey(record))
  if (before !== undefined && before.setting === setting) return before
  const decided: HeldLocalWindow = { window: chooseLocalWindow(record, estTokens, setting), setting, estTokens }
  held.set(holdKey(record), decided)
  return decided
}

export function __resetLocalWindowsForTest(): void {
  held.clear()
}

const fmt = (n: number): string => (n >= 1024 && n % 1024 === 0 ? `${n / 1024}k` : String(n))

export function localWindowSettingWords(setting: LocalWindowSetting | undefined): string {
  if (setting === undefined) return 'auto'
  if (setting === 'server') return 'server default'
  if (setting === 'max') return 'trained max'
  return fmt(setting)
}

export function localWindowValueWords(record: Pick<LocalModelRecord, 'id' | 'server' | 'modelMaxContext' | 'contextWindow'>, setting: LocalWindowSetting | undefined = localWindowSettingOf(record)): string {
  const application = localWindowApplication(record)
  const served = record.contextWindow?.source === 'served' ? ` · served ${fmt(record.contextWindow.tokens)}` : ''
  if (application === 'server-start') {
    return `set at server start${served}${record.contextWindow === undefined ? ' · not stated' : ''} · n/a`
  }
  if (application === 'none') return 'not applicable to this server'
  const hold = heldLocalWindow(record)
  const chosen = hold !== undefined && hold.setting === setting && hold.window !== undefined ? ` → ${fmt(hold.window)} held this session` : ''
  const road = application === 'request' ? 'num_ctx on every request' : 'applied at load'
  return `${localWindowSettingWords(setting)}${chosen}${served} · ${road}`
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

export function localWindowChoiceLine(record: Pick<LocalModelRecord, 'id' | 'server' | 'modelMaxContext' | 'contextWindow'>, opts: { wide: boolean; typing?: string; setting?: LocalWindowSetting | undefined }): string {
  if (opts.typing !== undefined) return `window · type the tokens (49152 or 48k) · ↵ sets · esc cancels · ${opts.typing}▍`
  const setting = opts.setting !== undefined ? opts.setting : localWindowSettingOf(record)
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
  const auto = rung === undefined && hold !== undefined && hold.setting === undefined && hold.window !== undefined ? `auto → ${fmt(hold.window)} held` : 'auto'
  const number = rung === 'number' && typeof setting === 'number' ? fmt(setting) : 'number'
  const rungs: Array<[LocalWindowRung, string]> = [[undefined, auto], ['server', 'server'], [32_768, '32k'], [65_536, '64k'], [131_072, '128k'], ['max', 'max'], ['number', number]]
  const shown = opts.wide || rung === 'number' ? rungs : rungs.filter(([key]) => key !== 'number')
  const ladder = shown.map(([key, label]) => (key === rung ? `[${label}]` : label)).join(' · ')
  if (application === 'server-start' || application === 'none') return `window · ${state} · set at server start · not a toggle`
  if (!opts.wide) return record.contextWindow === undefined ? `window · not loaded ${ladder} · w cycles` : `window ${ladder} · w cycles`
  return `window · ${state}${trained} · ${ladder} · w cycles`
}
