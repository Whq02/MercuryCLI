import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { passedOver } from '../../utils/passedOver.js'

export function concourseEnabled(): boolean {
  try {
    return getGlobalConfig().concourseEnabled !== false
  } catch (error) {
    passedOver(error)
    return true
  }
}

export function setConcourseEnabled(on: boolean): void {
  saveGlobalConfig(config => (config.concourseEnabled === on ? config : { ...config, concourseEnabled: on }))
}
