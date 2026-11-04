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

export const COORDINATOR_OFF_LINE = 'coordinator off (switch) — `mercury --coordinator-on` turns it on for this and every future boot'

export function coordinatorEnabled(): boolean {
  try {
    return getGlobalConfig().coordinatorEnabled === true
  } catch {
    return false
  }
}

export function setCoordinatorEnabled(on: boolean): void {
  saveGlobalConfig(config => (config.coordinatorEnabled === on ? config : { ...config, coordinatorEnabled: on }))
}
