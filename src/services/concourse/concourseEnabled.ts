import { getGlobalConfig, isConfigReadingAllowed, saveGlobalConfig } from '../../utils/config.js'

export function concourseEnabled(): boolean {
  if (!isConfigReadingAllowed()) return true
  return getGlobalConfig().concourseEnabled !== false
}

export function setConcourseEnabled(on: boolean): void {
  saveGlobalConfig(config => (config.concourseEnabled === on ? config : { ...config, concourseEnabled: on }))
}
