import { getModelUsage } from '../../../bootstrap/state.js'
import { getFocusedSessionConnector } from '../../engine-connector/focusedConnector.js'
import { declaredRouteOf } from '../routeLaw.js'
import type { UsageFigureView, UsageRefreshIo } from '../providerUsage.js'
import { usagePollTtlMs } from '../usageFreshness.js'
import { resolveGeminiAccount } from './geminiAccounts.js'
import { geminiPlanEffortSuffix, getCachedGeminiCatalogue, refreshGeminiCatalogue, type GeminiCatalogueSnapshot, type GeminiEffortSuffix } from './geminiCatalogue.js'

export interface GeminiPlanQuotaView {
  active?: UsageFigureView
  activeRow?: string
  used: UsageFigureView[]
  others: UsageFigureView[]
}

export function geminiPlanQuotaView(
  figures: readonly UsageFigureView[],
  session: { model?: string; effort?: string; usedModels: readonly string[] },
  env: NodeJS.ProcessEnv = process.env,
): GeminiPlanQuotaView {
  void env
  const quotas = figures.filter(figure => figure.key.startsWith('plan-quota:'))
  const rows = new Set(quotas.map(figure => figure.key.slice('plan-quota:'.length).toLowerCase()))
  const rowOf = (model: string | undefined): string | undefined => {
    if (model === undefined || model.trim() === '') return undefined
    const bare = model.trim().replace(/\[[^\]]*\]/g, '').toLowerCase()
    if (rows.has(bare)) return bare
    const want = geminiPlanEffortSuffix(session.effort)
    const order: GeminiEffortSuffix[] = want === 'low' ? ['low', 'medium', 'high'] : want === 'medium' ? ['medium', 'high', 'low'] : ['high', 'medium', 'low']
    for (const suffix of order) if (rows.has(`${bare}-${suffix}`)) return `${bare}-${suffix}`
    return undefined
  }
  const figureOf = (row: string | undefined): UsageFigureView | undefined => (row === undefined ? undefined : quotas.find(figure => figure.key.slice('plan-quota:'.length).toLowerCase() === row))
  const activeRow = rowOf(session.model)
  const active = figureOf(activeRow)
  const taken = new Set<string>(active ? [active.key] : [])
  const used: UsageFigureView[] = []
  for (const model of session.usedModels) {
    const figure = figureOf(rowOf(model))
    if (figure === undefined || taken.has(figure.key)) continue
    taken.add(figure.key)
    used.push(figure)
  }
  const others = quotas.filter(figure => !taken.has(figure.key))
  return { ...(active ? { active } : {}), ...(activeRow !== undefined && active ? { activeRow } : {}), used, others }
}

function geminiSessionModelUsage(): Readonly<Record<string, { lastUsedAtMs?: number }>> {
  const rows = getFocusedSessionConnector().usage().modelSpend
  if (rows === undefined) return getModelUsage()
  const usage: Record<string, { lastUsedAtMs?: number }> = {}
  for (const row of rows) {
    if (row.workload !== undefined) continue
    const prior = usage[row.model]
    if (prior === undefined) usage[row.model] = row.lastUsedAtMs !== undefined ? { lastUsedAtMs: row.lastUsedAtMs } : {}
    else if (row.lastUsedAtMs !== undefined && (prior.lastUsedAtMs ?? 0) < row.lastUsedAtMs) prior.lastUsedAtMs = row.lastUsedAtMs
  }
  return usage
}

export function geminiLaneModelsByLastUse(usage: Readonly<Record<string, { lastUsedAtMs?: number }>> = geminiSessionModelUsage()): string[] {
  return Object.entries(usage)
    .filter(([model]) => declaredRouteOf(model) === 'gemini')
    .map(([model, record], index) => ({ model, at: record.lastUsedAtMs ?? 0, index }))
    .sort((a, b) => b.at - a.at || a.index - b.index)
    .map(entry => entry.model)
}

export function geminiPlanQuotaFoldWords(count: number, expanded: boolean): string {
  return `${count} other roster model${count === 1 ? '' : 's'} — ↵ ${expanded ? 'folds them' : 'lists them'}`
}

export async function refreshGeminiPlanQuota(io?: UsageRefreshIo): Promise<void> {
  const env = io?.env ?? process.env
  const now = io?.now ?? Date.now
  if (resolveGeminiAccount(env)?.kind !== 'plan') return
  const reason = io?.reason ?? 'open'
  if (reason === 'open' && io?.force !== true) {
    const cached = getCachedGeminiCatalogue('plan', env)
    const attemptedAtMs = cached?.lastAttemptAtMs ?? cached?.fetchedAtMs ?? 0
    if (cached !== null && now() - attemptedAtMs < usagePollTtlMs()) return
  }
  await refreshGeminiCatalogue('plan', { force: true, env, now, ...(io?.fetchImpl !== undefined ? { fetchImpl: io.fetchImpl } : {}) })
}

export function geminiPlanQuotaReadNote(snapshot: Pick<GeminiCatalogueSnapshot, 'lastError'> | null): string | undefined {
  if (snapshot === null || snapshot.lastError === undefined) return undefined
  const why = snapshot.lastError === 'account-source-unavailable' ? 'the Google sign-in could not be used' : snapshot.lastError
  return `no quota read (${why})`
}

