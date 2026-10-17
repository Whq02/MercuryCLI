import { activeSourceUsage, limitBindsWords } from '../../services/providers/providerUsage.js'
import { formatCountdown } from '../../utils/cockpit/quota.js'
import { geminiLaneModelsByLastUse, geminiPlanQuotaView } from '../../services/providers/gemini/geminiPlanQuota.js'
import { resolveMoonshotAccount } from '../../services/providers/moonshot/moonshotAccounts.js'
import { walletEntries } from '../../services/wallet/wallet.js'
import { focusedSessionModelFacts } from '../../services/engine-connector/focusedConnector.js'
import { resolveLocalAccount } from '../../services/providers/local/localAccounts.js'
import { getEngineModel } from '../../utils/model/model.js'

export function geminiPlanActiveQuotaWords(figures: readonly { key: string; label: string; value: string }[] | undefined, session: { model?: string; effort?: string; usedModels: readonly string[] }): string | undefined {
  const view = geminiPlanQuotaView((figures ?? []) as never, session)
  return view.active === undefined ? undefined : `${view.activeRow ?? view.active.key.slice('plan-quota:'.length)} ${view.active.value} left`
}

function sessionFamilyLabel(label: string | undefined): string {
  if (label === undefined) return 'Unrecognised model'
  return label.endsWith(' usage') && label !== 'API usage'
    ? label.slice(0, -' usage'.length)
    : label
}

function usageLead(usage: { provider: string; sourceKind: string; label?: string }): string {
  if (usage.provider === 'local') {
    const server = resolveLocalAccount()
    return server === undefined ? `${getEngineModel()} · no local server answering` : `${getEngineModel()} on ${server.label}`
  }
  const family = sessionFamilyLabel(usage.label)
  return usage.sourceKind === 'none' ? `${family} not signed in` : `${family} session on`
}

function localRoadWords(usage: { provider: string; sourceKind: string }): string | undefined {
  if (usage.provider === 'local' || usage.sourceKind !== 'none') return undefined
  const server = resolveLocalAccount()
  return server === undefined ? undefined : `local servers: ${server.label}`
}

export function usagePopupLine(): string {
  const subscriptions = walletEntries().filter(entry => entry.kind === 'subscription-oauth').length
    + (resolveMoonshotAccount()?.kind === 'kimi-oauth' ? 1 : 0)
  const usage = activeSourceUsage()
  const meters = usage.windows
    .filter(window => window.state === 'live' && window.usedPct !== undefined)
    .map(window => {
      const word = window.key === '5h' ? 'session' : window.key === '7d' ? 'week' : window.label
      return `${word} ${Math.floor(window.usedPct!)}%`
    })
  const facts = focusedSessionModelFacts()
  const planQuota = usage.provider === 'gemini' && usage.sourceKind === 'oauth' ? geminiPlanActiveQuotaWords(usage.figures, { ...(facts?.effective !== undefined ? { model: facts.effective } : {}), ...(typeof facts?.effort === 'string' ? { effort: facts.effort } : {}), usedModels: geminiLaneModelsByLastUse() }) : undefined
  if (planQuota !== undefined) meters.push(planQuota)
  const localRoad = localRoadWords(usage)
  if (localRoad !== undefined) meters.push(localRoad)
  if (usage.limited !== undefined) {
    const model = facts?.effective ?? getEngineModel()
    meters.push(`${usage.limited.windowName ?? 'limit'} reached · resets ${formatCountdown(usage.limited.resetsAtMs - Date.now())} · ${limitBindsWords(usage.limited.claim, model)}`)
  }
  return `${usageLead(usage)} · ${subscriptions} subscription${subscriptions === 1 ? '' : 's'} signed in${meters.length ? ` · ${meters.join(' · ')}` : ''}`
}
