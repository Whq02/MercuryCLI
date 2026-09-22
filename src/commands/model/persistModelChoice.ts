import type { ModelSetting } from '../../utils/model/model.js'
import { getInitialSettings, updateSettingsForSource } from '../../utils/settings/settings.js'

export type ModelChoiceOutcome = 'saved' | 'overridden' | 'refused' | 'cleared' | 'unchanged'

export type PersistedModelChoice = { outcome: ModelChoiceOutcome; sentence: string }

export function persistModelChoice(setting: ModelSetting): PersistedModelChoice {
  const stored = getInitialSettings().model
  const saved: ModelSetting = stored !== undefined && stored !== '' ? stored : null
  if (saved !== setting) {
    const { error } = updateSettingsForSource('userSettings', { model: setting ?? undefined })
    if (error) return { outcome: 'refused', sentence: ` · not saved as your default: ${error.message}` }
  }
  if (setting === null) {
    return saved === null
      ? { outcome: 'unchanged', sentence: '' }
      : { outcome: 'cleared', sentence: ' · your saved default model is cleared, new sessions start on the family default' }
  }
  const env = process.env.MERCURY_MODEL
  if (env !== undefined && env !== '' && env !== setting) {
    return { outcome: 'overridden', sentence: ` · saved as your default, but MERCURY_MODEL=${env} overrides it at boot` }
  }
  return { outcome: 'saved', sentence: ' · saved as your default' }
}
