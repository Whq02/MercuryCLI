import type { ModelSetting } from '../../utils/model/model.js'
import { getInitialSettings, updateSettingsForSource } from '../../utils/settings/settings.js'

export function persistModelChoice(setting: ModelSetting): string {
  const stored = getInitialSettings().model
  const saved: ModelSetting = stored !== undefined && stored !== '' ? stored : null
  if (saved !== setting) {
    const { error } = updateSettingsForSource('userSettings', { model: setting ?? undefined })
    if (error) return ` · not saved as your default: ${error.message}`
  }
  if (setting === null) return saved === null ? '' : ' · your saved default model is cleared, new sessions start on the family default'
  const env = process.env.MERCURY_MODEL
  if (env !== undefined && env !== '' && env !== setting) {
    return ` · saved as your default, but MERCURY_MODEL=${env} overrides it at boot`
  }
  return ' · saved as your default'
}
