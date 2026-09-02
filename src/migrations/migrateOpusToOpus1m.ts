// ============================================================================
//  Startup migration A.5 — an `opus` pin becomes `opus[1m]` when the merge
//  capability is on (or clears entirely when the default already resolves
//  to the same model — a redundant pin is no pin).
//  Returns false when the settings write did not land — the runner then
//  withholds the version stamp so the rewrite retries next boot.
// ============================================================================
import { isOpus1mMergeEnabled } from '../utils/model/model.js'
import {
  getDefaultMainLoopModelSetting,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import { getSettingsForSource, updateSettingsForSource } from '../utils/settings/settings.js'
import { settingsWriteLanded } from './settingsWriteLanded.js'

export function migrateOpusToOpus1m(): boolean {
  if (!isOpus1mMergeEnabled()) return true
  const settings = getSettingsForSource('userSettings')
  if (settings?.model !== 'opus') return true
  const target = 'opus[1m]'
  const redundant =
    parseUserSpecifiedModel(target) === parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
  // Exactly one write either way. A `--model opus` invocation is a runtime
  // override and never touches user settings.
  return settingsWriteLanded(
    'A.5 opus pin',
    updateSettingsForSource('userSettings', { model: redundant ? undefined : target }),
  )
}
