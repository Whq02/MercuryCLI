import { getInitialSettings } from '../../utils/settings/settings.js'

export function isMemoryUpkeepEnabled(): boolean {
  return getInitialSettings().memoryUpkeepEnabled ?? false
}
