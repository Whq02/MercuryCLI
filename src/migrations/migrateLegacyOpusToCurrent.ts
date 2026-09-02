import { isLegacyModelRemapEnabled } from '../utils/model/model.js'
import { getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js'
import { saveGlobalConfig } from '../utils/config.js'
import { settingsWriteLanded } from './settingsWriteLanded.js'

const LEGACY_OPUS_IDS = new Set([
  'claude-opus-4-20250514',
  'claude-opus-4-1-20250805',
  'claude-opus-4-0',
  'claude-opus-4-1',
])

export function migrateLegacyOpusToCurrent(): boolean {
  if (!isLegacyModelRemapEnabled()) return true
  const settings = getSettingsForSource('userSettings')
  const model = settings?.model
  if (typeof model !== 'string' || !LEGACY_OPUS_IDS.has(model)) return true
  if (!settingsWriteLanded('A.4 legacy Opus pin', updateSettingsForSource('userSettings', { model: 'opus' }))) {
    return false
  }
  saveGlobalConfig(current => ({ ...current, legacyOpusMigrationTimestamp: Date.now() }))
  return true
}
