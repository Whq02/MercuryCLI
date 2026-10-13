import type { EffortLevel } from '../../utils/effortLadder.js'
import type { ModelSetting } from '../../utils/model/model.js'
import { getInitialSettings, updateSettingsForSource } from '../../utils/settings/settings.js'

export type ModelChoiceOutcome = 'saved' | 'overridden' | 'refused' | 'cleared' | 'unchanged'

export type PersistedModelChoice = { outcome: ModelChoiceOutcome; sentence: string; restore: () => void }

export type PersistedEffortChoice = { outcome: 'saved' | 'refused'; sentence: string }

export function persistEffortChoice(level: EffortLevel): PersistedEffortChoice {
  const { error } = updateSettingsForSource('userSettings', { engine: { effort: level } })
  if (error) return { outcome: 'refused', sentence: ` · not saved as your default: ${error.message}` }
  return { outcome: 'saved', sentence: ' · saved as your default for future sessions' }
}

export function persistModelChoice(setting: ModelSetting): PersistedModelChoice {
  const stored = getInitialSettings().engine?.model
  const saved: ModelSetting = stored !== undefined && stored !== '' ? stored : null
  const unchanged = (): void => {}
  if (saved !== setting) {
    const { error } = updateSettingsForSource('userSettings', { engine: { model: setting ?? undefined } })
    if (error) return { outcome: 'refused', sentence: ` · not saved as your default: ${error.message}`, restore: unchanged }
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
