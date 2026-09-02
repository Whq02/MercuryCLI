/**
 * The "you have access to a larger context variant" upgrade hint.
 *
 * The trigger is an EXACT match of the user setting against a bare family
 * alias — the large alias or the mid alias, nothing else — combined with that
 * family's 1M access check.
 */
import { checkOpus1mAccess, checkSonnet1mAccess } from './check1mAccess.js'

export type UpgradeMessage = {
  /** The alias carrying the `[1m]` suffix. */
  suffixedAlias: string
  /** A short display name of the form `<Family> 1M`. */
  displayName: string
  /** The context multiplier. */
  multiplier: number
  warning: string
  tip: string
}

/**
 * The upgrade hint for a context value, or nothing. The context value is the
 * user's current model setting.
 */
export function getUpgradeMessage(context: string | null | undefined): UpgradeMessage | null {
  if (context === undefined || context === null) return null
  const setting = context.trim().toLowerCase()

  let family: string | null = null
  let hasAccess = false
  if (setting === 'opus') {
    family = 'Opus'
    hasAccess = checkOpus1mAccess()
  } else if (setting === 'sonnet') {
    family = 'Sonnet'
    hasAccess = checkSonnet1mAccess()
  }
  if (family === null || !hasAccess) return null

  const suffixedAlias = `${setting}[1m]`
  const displayName = `${family} 1M`
  return {
    suffixedAlias,
    displayName,
    multiplier: 5,
    // The warning form is nothing but the model command with the suffixed
    // alias as its argument.
    warning: `/model ${suffixedAlias}`,
    tip: `You have access to ${displayName} — 5x more context. Run /model ${suffixedAlias} to switch.`,
  }
}
