// ============================================================================
//  Startup migration A.4 — normalise a legacy Opus pin in USER settings to
//  the `opus` alias (legacy-remap capability only).
//  Returns false (and stamps no notice) when the settings write did not
//  land — the notice would otherwise tell the user their model was updated
//  while the pin in settings is unchanged.
// ============================================================================
import { isLegacyModelRemapEnabled } from '../utils/model/model.js'
import { getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js'
import { saveGlobalConfig } from '../utils/config.js'
import { settingsWriteLanded } from './settingsWriteLanded.js'

// Matched literally and exhaustively (contract data).
const LEGACY_OPUS_IDS = new Set([
  'claude-opus-4-20250514',
  'claude-opus-4-1-20250805',
  'claude-opus-4-0',
  'claude-opus-4-1',
])

export function migrateLegacyOpusToCurrent(): boolean {
  if (!isLegacyModelRemapEnabled()) return true
  // The NARROW source: reading merged settings would promote a project- or
  // local-scoped pin into the user's global default.
  const settings = getSettingsForSource('userSettings')
  const model = settings?.model
  if (typeof model !== 'string' || !LEGACY_OPUS_IDS.has(model)) return true
  if (!settingsWriteLanded('A.4 legacy Opus pin', updateSettingsForSource('userSettings', { model: 'opus' }))) {
    return false
  }
  // The timestamp drives a one-time interactive notification.
  saveGlobalConfig(current => ({ ...current, legacyOpusMigrationTimestamp: Date.now() }))
  return true
}
