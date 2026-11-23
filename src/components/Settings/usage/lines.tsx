import React, { createContext, useContext, useState } from 'react'
import { Box, Text } from '../../../ink.js'
import { useLoad, useMeasure } from '../../../hooks/effects.js'
import type { RateLimit } from '../../../services/api/usage.js'
import { getEngineModel, renderModelName } from '../../../services/model/model.js'
import type { ProviderFamilyId } from '../../../services/providers/providerAdapter.js'
import { refreshProviderUsage, sessionSpendByModel, sessionSpendOfFacts, usageCarryWords, usageCreditsLine, usageForProvider, usageWindowReached, type ActiveSourceUsage, type ProviderSessionSpend, type UsageFigureView, type UsageWindowView, limitBindsWords } from '../../../services/providers/providerUsage.js'
import { geminiLaneModelsByLastUse, geminiPlanQuotaView } from '../../../services/providers/gemini/geminiPlanQuota.js'
import { focusedSessionModelFacts, getFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js'
import { providerIdentityLine, providerIdentitySentence } from '../../../services/providers/providerIdentityLine.js'
import { usageSourceWords } from '../../../services/providers/usageFreshness.js'
import { formatLaneSpend } from '../../../cost-tracker.js'
import { ProgressBar } from '../../design-system/ProgressBar.js'
import { useMercuryTokens } from '../../mercury-ui/useMercuryTokens.js'
import { passedOver } from '../../../utils/passedOver.js'

const WARN_PCT = 70
const ERROR_PCT = 90
const FULL_BAR_MIN_WIDTH = 62
const FULL_BAR_WIDTH = 50

export const UsageLayoutContext = createContext<(() => void) | undefined>(undefined)

export function useUsageLayout(): void {
  const measure = useContext(UsageLayoutContext)
  useMeasure(() => { measure?.() })
}

export function humanizeUsageError(body: unknown): string | null {
  let parsed: unknown = body
  if (typeof body === 'string') {
    try {
      parsed = JSON.parse(body)
    } catch (error) {
      passedOver(error)
      return null
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const error = (parsed as { error?: unknown }).error
  if (typeof error !== 'object' || error === null) return null
  const type = (error as { type?: unknown }).type
  const message = (error as { message?: unknown }).message
  const typeText = typeof type === 'string' ? type : undefined
  const messageText = typeof message === 'string' ? message : undefined
  if (typeText === 'rate_limit_error') {
    return 'rate limited — usage data is temporarily unavailable, retry in a moment'
  }
  if (typeText === 'overloaded_error') {
    return 'the API is overloaded — usage data is temporarily unavailable, retry in a moment'
  }
  if (messageText !== undefined && typeText !== undefined) {
    return `${messageText} (${typeText})`
  }
  if (messageText !== undefined) return messageText
  if (typeText !== undefined) return typeText
  return null
}

function pctOf(limit: RateLimit | null | undefined): number | null {
  if (limit == null || limit.utilization === null) return null
  return Math.floor(limit.utilization)
}

function fillFor(pct: number, tokens: ReturnType<typeof useMercuryTokens>): string {
  if (pct >= ERROR_PCT) return tokens.failure
  if (pct >= WARN_PCT) return tokens.warning
  return tokens.success
}

export function resetLineOf(resetsAt: string | null, hideTime: boolean): string | null {
  if (resetsAt === null) return null
  const date = new Date(resetsAt)
  if (Number.isNaN(date.getTime())) return null
  const text = hideTime
    ? date.toLocaleDateString()
    : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return `resets ${text}`
}

function Meter({
  title,
  limit,
  subtext,
  hideResetTime = false,
  maxWidth,
}: {
  title: string
  limit: RateLimit
  subtext?: string
  hideResetTime?: boolean
  maxWidth?: number
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const pct = pctOf(limit)
  if (pct === null) return null
  const available = Math.max(1, Math.min(maxWidth ?? 80, 80))
  const barWidth = available >= FULL_BAR_MIN_WIDTH ? FULL_BAR_WIDTH : available
  const fill = fillFor(pct, tokens)
  const reset = resetLineOf(limit.resets_at, hideResetTime)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={pct >= WARN_PCT ? fill : undefined}>
        {title} <Text bold={false}>· {pct}%</Text>
      </Text>
      <ProgressBar
        ratio={pct / 100}
        width={barWidth}
        fillColor={fill}
        emptyColor={tokens.surface2}
      />
      {subtext !== undefined ? <Text dimColor>{subtext}</Text> : null}
      {reset !== null ? <Text dimColor>{reset}</Text> : null}
    </Box>
  )
}


export function SlotHeading({ text }: { text: string }): React.ReactNode {
  const tokens = useMercuryTokens()
  return <Text bold color={tokens.textSecondary}>{text}</Text>
}

export function IdentityLine({ family }: { family: ProviderFamilyId }): React.ReactNode {
  return <Box flexDirection="column">
    <Text dimColor wrap="truncate-end">{providerIdentitySentence(providerIdentityLine(family))}</Text>
    <UsageCredits usage={usageForProvider(family)} />
  </Box>
}

export const SESSION_SPEND_LABEL = 'This session'
export const SCHEDULED_SPEND_LABEL = 'Scheduled'
export const ADVISOR_SPEND_LABEL = 'Advisor'
export const SESSION_SPEND_NONE = `${SESSION_SPEND_LABEL}: 0 tokens.`

function tokensLine(label: string, spend: ProviderSessionSpend, withCost: boolean): string {
  return `${label}: ${spend.inputTokens.toLocaleString()} input · ${spend.outputTokens.toLocaleString()} output tokens${withCost ? ` · ${formatLaneSpend(spend)}` : ''}`
}

function workloadLines(spend: ProviderSessionSpend, withCost: boolean): string[] {
  const lines: string[] = []
  if (spend.scheduled !== undefined) lines.push(tokensLine(SCHEDULED_SPEND_LABEL, spend.scheduled, withCost))
  if (spend.advisor !== undefined) lines.push(tokensLine(ADVISOR_SPEND_LABEL, spend.advisor, withCost))
  return lines
}

export const MODEL_ROW_INDENT = '  '

export function sessionSpendLines(route: ProviderFamilyId, screenSpend: ProviderSessionSpend, withCost: boolean): string[] {
  const facts = getFocusedSessionConnector().usage()
  const session = sessionSpendOfFacts(facts, route)
  if (session === null) return workloadLines(screenSpend, withCost)
  if (session.models === 0) return [SESSION_SPEND_NONE, ...workloadLines(session, withCost)]
  const perModel = sessionSpendByModel(facts, route).map(entry => `${MODEL_ROW_INDENT}${tokensLine(renderModelName(entry.model), entry.spend, withCost)}`)
  return [tokensLine(SESSION_SPEND_LABEL, session, withCost), ...perModel, ...workloadLines(session, withCost)]
}

export function SlotSpend({ active, route, spend, withCost }: { active: boolean; route: ProviderFamilyId; spend: ProviderSessionSpend; withCost: boolean }): React.ReactNode {
  if (!active) return <Text dimColor>{INACTIVE_SLOT_LINE}</Text>
  const lines = sessionSpendLines(route, spend, withCost)
  return lines.length === 0 ? null : <Text dimColor>{lines.join('\n')}</Text>
}

export function absentSlotLine(route: string): string {
  return `none — ${route} · n/a`
}
export const INACTIVE_SLOT_LINE = 'not the active billing source this session'

export function ApiKeySlot({
  presentLabel,
  isActive,
  route,
  spend,
  note,
  creditsLine,
}: {
  presentLabel?: string
  isActive: boolean
  route: ProviderFamilyId
  spend: ProviderSessionSpend
  note?: string
  creditsLine?: string
}): React.ReactNode {
  return (
    <Box flexDirection="column" marginTop={1}>
      <SlotHeading text="API key" />
      {presentLabel === undefined ? (
        <Text dimColor>{absentSlotLine('a pasted key attaches one')}</Text>
      ) : (
        <Box flexDirection="column">
          <Text dimColor>{presentLabel}</Text>
          <SlotSpend active={isActive} route={route} spend={spend} withCost />
          {isActive && creditsLine !== undefined ? <Text dimColor>{creditsLine}</Text> : null}
          {isActive && note !== undefined ? <Text dimColor>{note}</Text> : null}
        </Box>
      )}
    </Box>
  )
}

export function UsageCredits({ usage }: { usage: Pick<ActiveSourceUsage, 'credits'> }): React.ReactNode {
  const line = usageCreditsLine(usage.credits)
  return line === undefined ? null : <Text dimColor>{line}</Text>
}

export function carryTail(usage: Pick<ActiveSourceUsage, 'carry'>): string {
  const words = usageCarryWords(usage.carry)
  return words === undefined ? '' : ` · ${words}`
}

export function fullWindowLine(usage: Pick<ActiveSourceUsage, 'windows' | 'pools' | 'limited' | 'carry'>, model: string = focusedSessionModelFacts()?.effective ?? getEngineModel()): string | undefined {
  const reached = usageWindowReached(usage)
  if (reached === 'wall' && usage.limited !== undefined) {
    const window = usage.limited.windowName !== undefined ? `The ${usage.limited.windowName}` : 'A usage window'
    return `${window} is reached — resets ${new Date(usage.limited.resetsAtMs).toLocaleString()} · ${limitBindsWords(usage.limited.claim, model)}${carryTail(usage)}.`
  }
  return reached === 'full' ? `A usage window reads 100%${carryTail(usage)}.` : undefined
}

export function FullWindowLine({ usage }: { usage: Pick<ActiveSourceUsage, 'windows' | 'pools' | 'limited' | 'carry'> }): React.ReactNode {
  const line = fullWindowLine(usage)
  return line === undefined ? null : <Text dimColor>{line}</Text>
}

export function useOwnerUsage(id: ProviderFamilyId, credentialed: boolean): ActiveSourceUsage {
  useUsageLayout()
  const [, setSample] = useState(0)
  useLoad(signal => {
    if (!credentialed) return
    void refreshProviderUsage(id, { reason: 'open' }).then(() => {
      if (!signal.aborted) setSample(s => s + 1)
    })
  }, [id, credentialed])
  return usageForProvider(id)
}

function geminiPlanFiguresInOrder(figures: readonly UsageFigureView[]): UsageFigureView[] {
  if (!figures.some(figure => figure.key.startsWith('plan-quota:'))) return [...figures]
  const facts = focusedSessionModelFacts()
  const view = geminiPlanQuotaView(figures, { ...(facts?.effective !== undefined ? { model: facts.effective } : {}), ...(typeof facts?.effort === 'string' ? { effort: facts.effort } : {}), usedModels: geminiLaneModelsByLastUse() })
  const ordered: UsageFigureView[] = figures.filter(figure => !figure.key.startsWith('plan-quota:'))
  if (view.active !== undefined) ordered.push({ ...view.active, label: `${view.active.label} (the session's model)` })
  for (const figure of view.used) ordered.push({ ...figure, label: `${figure.label} (used this session)` })
  for (const entry of view.unreported) ordered.push({ key: `plan-quota-unreported:${entry.model}`, label: `${entry.model} (${entry.active ? "the session's model" : 'used this session'})`, value: 'no quota reported for', source: 'endpoint', freshForMs: 5 * 60 * 1000 })
  if (view.others.length > 0) ordered.push({ key: 'plan-quota-others', label: `other roster model${view.others.length === 1 ? '' : 's'}`, value: String(view.others.length), source: 'endpoint', freshForMs: 5 * 60 * 1000 })
  return ordered
}

export function figuresLine(usage: ActiveSourceUsage): string | undefined {
  const figures = usage.provider === 'gemini' ? geminiPlanFiguresInOrder(usage.figures ?? []) : usage.figures ?? []
  if (figures.length === 0) return undefined
  const parts = figures.map(f => `${f.value} ${f.label}`)
  const stamp = figures[0] !== undefined ? usageSourceWords(figures[0]) : undefined
  return `${parts.join(' · ')}${stamp !== undefined ? ` · ${stamp}` : ''}`
}

export function ObservedWindowMeter({
  window: w,
  title,
  tail,
  maxWidth,
}: {
  window: UsageWindowView
  title?: string
  tail?: string
  maxWidth?: number
}): React.ReactNode {
  if (w.usedPct === undefined) return null
  const observed = usageSourceWords(w)
  const parts = [observed, tail].filter((part): part is string => part !== undefined && part !== '')
  const subtext = parts.length > 0 ? parts.join(' · ') : undefined
  return (
    <Meter
      title={title ?? (w.label === 'wk' ? 'Current week' : `Window (${w.label})`)}
      limit={{
        utilization: w.usedPct,
        resets_at: w.resetsAtMs !== undefined ? new Date(w.resetsAtMs).toISOString() : null,
      }}
      {...(subtext !== undefined ? { subtext } : {})}
      {...(maxWidth !== undefined ? { maxWidth } : {})}
    />
  )
}
