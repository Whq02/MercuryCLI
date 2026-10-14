import { activeSourceUsage } from '../../services/providers/providerUsage.js'
import { geminiLaneModelsByLastUse, geminiPlanQuotaView } from '../../services/providers/gemini/geminiPlanQuota.js'
import { resolveMoonshotAccount } from '../../services/providers/moonshot/moonshotAccounts.js'
import { walletEntries } from '../../services/wallet/wallet.js'
import { focusedSessionModelFacts } from '../../services/engine-connector/focusedConnector.js'

export function geminiPlanActiveQuotaWords(figures: readonly { key: string; label: string; value: string }[] | undefined, session: { model?: string; effort?: string; usedModels: readonly string[] }): string | undefined {
  const view = geminiPlanQuotaView((figures ?? []) as never, session)
  return view.active === undefined ? undefined : `${view.activeRow ?? view.active.key.slice('plan-quota:'.length)} ${view.active.value} left`
}

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
  const facts = focusedSessionModelFacts()
  const planQuota = usage.provider === 'gemini' && usage.sourceKind === 'oauth' ? geminiPlanActiveQuotaWords(usage.figures, { ...(facts?.effective !== undefined ? { model: facts.effective } : {}), ...(typeof facts?.effort === 'string' ? { effort: facts.effort } : {}), usedModels: geminiLaneModelsByLastUse() }) : undefined
  if (planQuota !== undefined) meters.push(planQuota)
  return `${family} session on · ${subscriptions} subscription${subscriptions === 1 ? '' : 's'} signed in${meters.length ? ` · ${meters.join(' · ')}` : ''}`
}
