import { getGlobalConfig } from '../config.js'
import { isAutoModeGateEnabled } from './permissionSetup.js'

export function shouldShowAutoDefaultNotice(permissionMode: string): boolean {
  const config = getGlobalConfig()
  return (
    permissionMode === 'flow' &&
    isAutoModeGateEnabled() &&
    config.hasCompletedOnboarding === true &&
    !config.hasSeenAutoDefaultNotice
  )
}

export const AUTO_DEFAULT_NOTICE_TEXT = `Flow is now Mercury's default permission mode.

Flow lets Mercury handle permission prompts automatically. Mercury checks each tool call for risky actions and prompt injection before executing, runs the ones it assesses as lower-risk, and asks you about the rest.`
