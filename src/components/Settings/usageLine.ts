import { activeSourceUsage } from '../../services/providers/providerUsage.js'
import { resolveMoonshotAccount } from '../../services/providers/moonshot/moonshotAccounts.js'
import { walletEntries } from '../../services/wallet/wallet.js'

export function sessionFamilyLabel(label: string | undefined): string {
  if (label === undefined) return 'Unrecognised model'
  return label.endsWith(' usage') && label !== 'API usage'
    ? label.slice(0, -' usage'.length)
    : label
}

export function usagePopupLine(): string {
  const subscriptions = walletEntries().filter(entry => entry.kind === 'subscription-oauth').length
    + (resolveMoonshotAccount()?.kind === 'kimi-oauth' ? 1 : 0)
  const usage = activeSourceUsage()
  const family = sessionFamilyLabel(usage.label)
  const meters = usage.windows
    .filter(window => window.state === 'live' && window.usedPct !== undefined)
    .map(window => {
      const word = window.key === '5h' ? 'session' : window.key === '7d' ? 'week' : window.label
      return `${word} ${Math.floor(window.usedPct!)}%`
    })
  return `${family} session on · ${subscriptions} subscription${subscriptions === 1 ? '' : 's'} signed in${meters.length ? ` · ${meters.join(' · ')}` : ''}`
}
