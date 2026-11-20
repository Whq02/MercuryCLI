import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { getErrnoCode } from '../../utils/errors.js'
import { passedOver } from '../../utils/passedOver.js'

export function concourseEnabled(): boolean {
  try {
    return getGlobalConfig().concourseEnabled !== false
  } catch (error) {
    logForDebugging(`[concourse] concourseEnabled read failed (${getErrnoCode(error) ?? 'unknown'}): ${error instanceof Error ? error.message : String(error)}`, { level: 'warn' })
    passedOver(error)
    return true
  }
}

export function setConcourseEnabled(on: boolean): void {
  saveGlobalConfig(config => (config.concourseEnabled === on ? config : { ...config, concourseEnabled: on }))
}
