import type { EffortLevel } from '../../utils/effortLadder.js'
import type { ModelSetting } from '../../utils/model/model.js'
import { displayConfigHome, getMercuryHome } from '../../utils/envUtils.js'
import { compatModelEndpoint } from '../../services/providers/openaicompat/compatAccounts.js'
import { getInitialSettings, getSettingsWriteFilePathForSource, updateSettingsForSource } from '../../utils/settings/settings.js'

type ModelChoiceOutcome = 'saved' | 'session' | 'overridden' | 'refused' | 'cleared' | 'unchanged'

function isRentedHostModel(setting: ModelSetting): boolean {
  if (setting === null || !setting.toLowerCase().startsWith('compat/')) return false
  try { return Boolean(compatModelEndpoint(setting)?.endpoint.hostPodId) } catch { return false }
}

type PersistedModelChoice = { outcome: ModelChoiceOutcome; sentence: string; restore: () => void }

type PersistedEffortChoice = { outcome: 'saved' | 'refused'; sentence: string }

function refusedSentence(error: Error): string {
  const path = getSettingsWriteFilePathForSource('userSettings')
  const home = getMercuryHome()
  const file = path === undefined ? 'settings.json' : path.startsWith(home) ? `${displayConfigHome()}${path.slice(home.length)}` : path
  let root: unknown = error
  while (root instanceof Error && root.cause instanceof Error) root = root.cause
  const { code, syscall } = root as { code?: unknown; syscall?: unknown }
  let reason = root instanceof Error ? root.message : String(root)
  if (typeof code === 'string' && reason.startsWith(`${code}: `)) reason = reason.slice(code.length + 2)
  const cut = typeof syscall === 'string' ? reason.indexOf(`, ${syscall} '`) : -1
  if (cut > 0) reason = reason.slice(0, cut)
  if (path !== undefined) reason = reason.replaceAll(path, file)
  return ` · not saved as your default: ${reason.includes(file) ? reason : `${file} — ${reason}`}`
}

export function persistEffortChoice(level: EffortLevel): PersistedEffortChoice {
  const { error } = updateSettingsForSource('userSettings', { engine: { effort: level } })
  if (error) return { outcome: 'refused', sentence: refusedSentence(error) }
  return { outcome: 'saved', sentence: ' · saved as your default for future sessions' }
}

export function persistModelChoice(setting: ModelSetting): PersistedModelChoice {
  const unchanged = (): void => {}
  if (isRentedHostModel(setting)) return { outcome: 'session', sentence: '', restore: unchanged }
  const stored = getInitialSettings().engine?.model
  const saved: ModelSetting = stored !== undefined && stored !== '' ? stored : null
  if (saved !== setting) {
    const { error } = updateSettingsForSource('userSettings', { engine: { model: setting ?? undefined } })
    if (error) return { outcome: 'refused', sentence: refusedSentence(error), restore: unchanged }
  }
  const restore = saved === setting ? unchanged : (): void => void updateSettingsForSource('userSettings', { engine: { model: saved ?? undefined } })
  if (setting === null) {
    return saved === null
      ? { outcome: 'unchanged', sentence: '', restore }
      : { outcome: 'cleared', sentence: ' · your saved default model is cleared, new sessions start on the family default', restore }
  }
  const env = process.env.MERCURY_MODEL
  if (env !== undefined && env !== '' && env !== setting) {
    return { outcome: 'overridden', sentence: ` · saved as your default, but MERCURY_MODEL=${env} overrides it at boot`, restore }
  }
  return { outcome: 'saved', sentence: ' · saved as your default', restore }
}
