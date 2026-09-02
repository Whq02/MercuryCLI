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
  return settingsWriteLanded(
    'A.5 opus pin',
    updateSettingsForSource('userSettings', { model: redundant ? undefined : target }),
  )
}
