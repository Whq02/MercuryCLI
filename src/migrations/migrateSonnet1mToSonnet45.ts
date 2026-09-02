import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js'
import { getMainLoopModelOverride, setMainLoopModelOverride } from '../bootstrap/state.js'
import { settingsWriteLanded } from './settingsWriteLanded.js'

const SOURCE = 'sonnet[1m]'
const TARGET = 'sonnet-4-5-20250929[1m]'

export function migrateSonnet1mToSonnet45(): boolean {
  if (getGlobalConfig().sonnet1m45MigrationComplete) return true
  const settings = getSettingsForSource('userSettings')
  if (getMainLoopModelOverride() === SOURCE) {
    setMainLoopModelOverride(TARGET)
  }
  if (settings?.model === SOURCE) {
    if (!settingsWriteLanded('A.6 sonnet[1m] pin', updateSettingsForSource('userSettings', { model: TARGET }))) {
      return false
    }
  }
  saveGlobalConfig(current => ({ ...current, sonnet1m45MigrationComplete: true }))
  return true
}
