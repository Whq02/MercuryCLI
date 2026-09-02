
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

export function pingsBellEnabled(): boolean {
  return getGlobalConfig().pingsBell !== false
}

export function setPingsBellEnabled(on: boolean): void {
  saveGlobalConfig(current => ({ ...current, pingsBell: on }))
}
