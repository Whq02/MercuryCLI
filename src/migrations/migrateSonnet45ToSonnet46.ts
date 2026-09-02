// ============================================================================
//  Startup migration A.7 — an explicit Sonnet 4.5 pin returns to the
//  `sonnet` alias (preserving the [1m] dimension) for Pro/Max/Team-Premium
//  subscribers.
//  Returns false (and stamps no notice) when the settings write did not
//  land — the notice would otherwise tell the user their model was updated
//  while the pin in settings is unchanged.
// ============================================================================
import {
  isMaxSubscriber,
  isProSubscriber,
  isTeamPremiumSubscriber,
} from '../utils/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../utils/config.js'
import { getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js'
import { settingsWriteLanded } from './settingsWriteLanded.js'

// Matched literally and exhaustively (contract data).
const SONNET_45_IDS = new Set([
  'claude-sonnet-4-5-20250929',
  'claude-sonnet-4-5-20250929[1m]',
  'sonnet-4-5-20250929',
  'sonnet-4-5-20250929[1m]',
])

export function migrateSonnet45ToSonnet46(): boolean {
  if (!isProSubscriber() && !isMaxSubscriber() && !isTeamPremiumSubscriber()) return true
  const settings = getSettingsForSource('userSettings')
  const model = settings?.model
  if (typeof model !== 'string' || !SONNET_45_IDS.has(model)) return true
  // Preserve the 1M dimension exactly.
  const verdict = updateSettingsForSource('userSettings', {
    model: model.endsWith('[1m]') ? 'sonnet[1m]' : 'sonnet',
  })
  if (!settingsWriteLanded('A.7 Sonnet 4.5 pin', verdict)) return false
  // The rewrite happens either way; only the NOTICE is suppressed for a
  // brand-new user (an absent counter also suppresses — plain greater-than).
  const startups = getGlobalConfig().numStartups
  if (typeof startups === 'number' && startups > 1) {
    saveGlobalConfig(current => ({ ...current, sonnet45To46MigrationTimestamp: Date.now() }))
  }
  return true
}
