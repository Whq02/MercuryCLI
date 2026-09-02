import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

export function concourseEnabled(): boolean {
  try {
    return getGlobalConfig().concourseEnabled !== false
  } catch {
    return true
  }
}

export function setConcourseEnabled(on: boolean): void {
  saveGlobalConfig(config => (config.concourseEnabled === on ? config : { ...config, concourseEnabled: on }))
}
