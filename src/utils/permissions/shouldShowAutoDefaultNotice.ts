import { getGlobalConfig } from '../config.js'
import { getInitialSettings } from '../settings/settings.js'
import { decodePermissionModeSpelling } from '../../types/permissions.js'
import { isAutoModeGateEnabled } from './permissionSetup.js'

/** The operator's SAVED default permission mode, decoded through the
 *  bounded alias (an old spelling reads as its new id); null when no
 *  settings source names one. */
export function savedDefaultPermissionMode(): string | null {
  try {
    const raw = getInitialSettings().permissions?.defaultMode
    return typeof raw === 'string' && raw.length > 0 ? decodePermissionModeSpelling(raw) : null
  } catch {
    return null
  }
}

/**
 * One-shot gate for the "Flow is now the default permission mode" first-run
 * notice. Shown once to an already-onboarded user the first time they land in
 * `flow` permission mode BECAUSE IT IS THEIR DEFAULT. The caller is
 * responsible for persisting hasSeenAutoDefaultNotice = true after showing it.
 *
 * True only when ALL of:
 *   - the active permission mode is exactly "flow",
 *   - flow is the operator's SAVED default (settings.permissions.defaultMode)
 *     — a session that runs flow because `--permission-mode flow` was passed
 *     for it is not running the default, and the notice's sentence would be
 *     false there,
 *   - flow is an available permission mode here (isAutoModeGateEnabled),
 *   - the user has already completed onboarding (brand-new users get onboarding
 *     instead of this retroactive notice), and
 *   - the user has NOT already seen the notice.
 */
export function shouldShowAutoDefaultNotice(permissionMode: string): boolean {
  const config = getGlobalConfig()
  return (
    permissionMode === 'flow' &&
    savedDefaultPermissionMode() === 'flow' &&
    isAutoModeGateEnabled() &&
    config.hasCompletedOnboarding === true &&
    !config.hasSeenAutoDefaultNotice
  )
}

/** The verbatim notice copy shown when shouldShowAutoDefaultNotice passes.
 *  Mercury is the assistant here whatever provider serves the model, so the
 *  copy names Mercury and never a provider; it matches the nudge's wording. */
export const AUTO_DEFAULT_NOTICE_TEXT = `Flow is now Mercury's default permission mode.

Flow lets Mercury handle permission prompts automatically. Mercury checks each tool call for risky actions and prompt injection before executing, runs the ones it assesses as lower-risk, and asks you about the rest.`
