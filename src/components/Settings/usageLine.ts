import { resolveMoonshotAccount } from '../../services/providers/moonshot/moonshotAccounts.js'
import { anthropicWindowViews, providerFamilyPresences } from '../../services/providers/providerUsage.js'
import { walletEntries } from '../../services/wallet/wallet.js'

export function usagePopupLine(): string {
  const subscriptions = walletEntries().filter(entry => entry.kind === 'subscription-oauth').length
    + (resolveMoonshotAccount()?.kind === 'kimi-oauth' ? 1 : 0)
  const windows = anthropicWindowViews().filter(window => window.state === 'live' && window.usedPct !== undefined)
  const session = windows.find(window => window.key === '5h')
  const week = windows.find(window => window.key === '7d')
  const meters = [
    ...(session ? [`session ${Math.floor(session.usedPct!)}%`] : []),
    ...(week ? [`week ${Math.floor(week.usedPct!)}%`] : []),
  ]
  return `${providerFamilyPresences().length} providers · ${subscriptions} subscriptions signed in${meters.length ? ` · Anthropic ${meters.join(' · ')}` : ''}`
}
