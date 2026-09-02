import { checkOpus1mAccess, checkSonnet1mAccess } from './check1mAccess.js'

export type UpgradeMessage = {
  suffixedAlias: string
  displayName: string
  multiplier: number
  warning: string
  tip: string
}

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
    warning: `/model ${suffixedAlias}`,
    tip: `You have access to ${displayName} — 5x more context. Run /model ${suffixedAlias} to switch.`,
  }
}
