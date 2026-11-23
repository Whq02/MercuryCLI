import React, { useState, useSyncExternalStore } from 'react'
import { useLoad } from '../../../hooks/effects.js'
import { Box, Text, useInput } from '../../../ink.js'
import { usePopupListPaging } from '../../CustomSelect/popup-list.js'
import { isClaudeAISubscriber } from '../../../utils/auth.js'
import { getEngineModel } from '../../../services/model/model.js'
import type { ProviderFamilyId } from '../../../services/providers/providerAdapter.js'
import { CREDITS_UNREPORTED_WORDS, anthropicPoolWindowViews, anthropicWindowViews, openaiObservedWindowViews, providerFamilyPresences, refreshProviderUsage, usageCreditsLine, usageForProvider, type ActiveSourceUsage, type UsageWindowView } from '../../../services/providers/providerUsage.js'
import { focusedSessionModelFacts } from '../../../services/engine-connector/focusedConnector.js'
import { providerIdentityLine, providerIdentitySentence } from '../../../services/providers/providerIdentityLine.js'
import { jevRoadWords, jevUsdLabel } from '../../../services/jev/jevContract.js'
import { jevCreditsWords } from '../Jev.js'
import { type JevKeyPresence, jevKeyPresence } from '../../../services/jev/jevKey.js'
import { type JevSessionFacts, jevSessionAbsenceWords, jevSessionFacts, jevSessionFactsStamp, jevSessionStatus, subscribeJevSessionFacts } from '../../../services/jev/jevSessionFacts.js'
import { readJevSettings } from '../../../services/jev/jevSetting.js'
import { JEV_STATUS_HEADWORDS } from '../../../services/jev/jevStatus.js'
import { useCatalogueEpoch } from '../../../hooks/useCatalogueEpoch.js'
import { tensorFoldServing, tensorFoldServingLine } from '../../../services/providers/local/tensorfoldUsage.js'
import { hostRentalUsage } from '../../../services/host/costs.js'
import { compatModelEndpoint, resolveCompatAccount } from '../../../services/providers/openaicompat/compatAccounts.js'
import { usePopupMarker } from '../../../context/popupFormContext.js'
import { settingsPopupMarker, settingsPopupWindow } from '../../../utils/cockpit/settingsPopup.js'
import { GLYPH } from '../../../utils/glyphs.js'
import { useMercuryTokens } from '../../mercury-ui/useMercuryTokens.js'
import { resetLineOf, fullWindowLine, figuresLine } from './lines.js'
import { type UsageSection, orderUsageSections, liveSessionFamily, liveSignInRecency, usageSectionPlan } from './plan.js'
import { rentalUsageLines } from './sections.js'
import { markOpenAsked } from './anthropicSection.js'
import { hostEnv } from '../../../utils/hostEnv.js'

export function usageColumns(width: number, count: number): { perRow: number; colW: number; meterW: number; gap: number } {
  const inner = Math.max(1, Math.floor(width))
  const perRow = inner >= 120 ? Math.max(1, Math.min(3, count)) : 1
  const gap = 4
  const colW = Math.max(1, Math.floor((inner - gap * (perRow - 1)) / perRow))
  return { perRow, colW, meterW: Math.max(1, colW - (perRow > 1 ? 4 : 2)), gap }
}

export function usageWindow(bands: ReadonlyArray<{ height: number; count: number }>, capacity: number, position: number): {
  offset: number; height: number; endBand: number; previous: number; next: number
} {
  const rows = Math.max(0, Math.floor(capacity))
  const starts: number[] = []
  let end = 0
  for (const band of bands) {
    starts.push(end)
    end += Math.max(1, band.height) + 1
  }
  const viewAt = (offset: number) => {
    let height = 0
    let count = 0
    let endBand = 0
    for (let index = 0; index < bands.length; index++) {
      const band = bands[index]!
      const bottom = starts[index]! + Math.max(1, band.height)
      if (bottom <= offset) { endBand = index + 1; continue }
      if (count + band.count > 6 || rows === 0) break
      const needed = bottom - offset
      if (count > 0 && needed > rows) break
      height = Math.min(rows, needed)
      count += band.count
      endBand = index + 1
      if (needed >= rows) break
    }
    return { offset, height, endBand }
  }
  let current = viewAt(0)
  let previous = 0
  let next = 0
  const target = Math.max(0, Math.floor(position))
  outer: for (let index = 0; index < bands.length && rows > 0; index++) {
    const start = starts[index]!
    const last = start + Math.max(0, bands[index]!.height - rows)
    for (let offset = start; offset <= last; offset++) {
      if (offset > target) { next = offset; break outer }
      previous = current.offset
      current = viewAt(offset)
      next = offset
      if (offset + current.height >= end - 1) break outer
    }
  }
  return { ...current, previous, next }
}

export const JEV_USAGE_LABEL = 'Jev'

export function jevUsageRowShown(session: JevSessionFacts = jevSessionFacts(), key: JevKeyPresence = jevKeyPresence()): boolean {
  return key.present || (session.state === 'reported' && (session.facts.calls > 0 || session.facts.attempts > 0))
}

export function jevUsageRow(session: JevSessionFacts = jevSessionFacts()): string {
  const settings = readJevSettings()
  const headword = JEV_STATUS_HEADWORDS[jevSessionStatus(session, settings).kind]
  const allowance = jevUsdLabel(settings.allowanceUsd)
  const count = session.state === 'reported' ? `${jevUsdLabel(session.facts.spendUsd)} of a ${allowance} allowance · ${session.facts.calls} call${session.facts.calls === 1 ? '' : 's'} (${session.facts.unconfirmedCharges} unconfirmed)` : `${jevSessionAbsenceWords(session)} · allowance ${allowance}`
  const stated = settings.road === 'openrouter' && session.state === 'reported' && session.facts.lastCostUsd != null ? ` · last stated $${session.facts.lastCostUsd}` : ''
  const road = settings.road === 'openrouter' ? ` · ${jevRoadWords(settings.road)}` : ''
  const credits = settings.road === 'openrouter' ? jevCreditsWords(settings.road) : CREDITS_UNREPORTED_WORDS
  return `${JEV_USAGE_LABEL} · second-opinion evaluator${road} · ${count}${stated} · ${headword} · credits: ${credits}`
}

export function usageBodyRows(budget: number, requestedJevRows = 1): { footerRows: number; jevRows: number; capacity: number } {
  const rows = Math.max(0, Math.floor(budget))
  const footerRows = rows > 1 ? 1 : 0
  const jevRows = rows > 2 && requestedJevRows > 0 ? Math.min(rows - 2, requestedJevRows) : 0
  return { footerRows, jevRows, capacity: rows - footerRows - jevRows }
}

export type UsageCompactLine = { text: string; heading: boolean }

export type UsageCompactReads = {
  identity: (family: ProviderFamilyId) => string
  usage: (family: ProviderFamilyId) => ActiveSourceUsage
  anthropicWindows: () => UsageWindowView[]
  anthropicPools: () => UsageWindowView[]
  openaiWindows: () => UsageWindowView[]
  jev: () => string | undefined
  tensorFold?: () => string | undefined
}

function liveTensorFoldLine(): string | undefined {
  const serving = tensorFoldServing(focusedSessionModelFacts()?.effective ?? getEngineModel())
  return serving === undefined ? undefined : tensorFoldServingLine(serving)
}

function compactWindowLine(w: UsageWindowView, title: string): string | undefined {
  if (w.usedPct === undefined) return undefined
  const reset = resetLineOf(w.resetsAtMs !== undefined ? new Date(w.resetsAtMs).toISOString() : null, false)
  return `  ${title} · ${Math.floor(w.usedPct)}%${reset !== null ? ` · ${reset}` : ''}`
}

export function usageCompactLines(
  plan: UsageSection[],
  reads: UsageCompactReads = {
    identity: family => providerIdentitySentence(providerIdentityLine(family)),
    usage: usageForProvider,
    anthropicWindows: () => anthropicWindowViews().filter(w => w.state === 'live'),
    anthropicPools: () => anthropicPoolWindowViews().filter(w => w.state === 'live'),
    openaiWindows: openaiObservedWindowViews,
    jev: () => (jevUsageRowShown() ? jevUsageRow() : undefined),
  },
): UsageCompactLine[] {
  const lines: UsageCompactLine[] = []
  for (const section of plan) {
    const model = section.id === 'openai-compat' && section.family.credentialed ? focusedSessionModelFacts()?.effective ?? getEngineModel() : undefined
    const endpoint = model === undefined ? undefined : compatModelEndpoint(model)?.endpoint
    const rental = model !== undefined && endpoint !== undefined ? hostRentalUsage(model) : undefined
    if (rental) {
      lines.push({ text: section.title, heading: true }, ...rentalUsageLines(rental).map(text => ({ text: `  ${text}`, heading: false })))
      continue
    }
    const identity = endpoint ? resolveCompatAccount(hostEnv(), endpoint.name)?.label ?? reads.identity(section.id) : reads.identity(section.id)
    lines.push({ text: `${section.title} · ${identity}`, heading: true })
    if (!section.family.credentialed) continue
    if (section.id === 'local') {
      const tensorFold = (reads.tensorFold ?? liveTensorFoldLine)()
      if (tensorFold !== undefined) lines.push({ text: `  ${tensorFold}`, heading: false })
    }
    const usage = reads.usage(section.id)
    const windows: string[] = []
    if (section.id === 'anthropic') {
      for (const w of reads.anthropicWindows()) {
        const line = compactWindowLine(w, w.key === '5h' ? 'Current session' : w.key === '7d' ? 'Current week (all models)' : `Window (${w.label})`)
        if (line !== undefined) windows.push(line)
      }
      for (const w of reads.anthropicPools()) {
        const line = compactWindowLine(w, `Current week (${w.label})`)
        if (line !== undefined) windows.push(line)
      }
    } else {
      for (const w of section.id === 'openai' ? reads.openaiWindows() : usage.windows) {
        const line = compactWindowLine(w, w.label === 'wk' ? 'Current week' : w.label === '7d' ? 'Current week (7d)' : `Window (${w.label})`)
        if (line !== undefined) windows.push(line)
      }
    }
    for (const line of windows) lines.push({ text: line, heading: false })
    const credits = usageCreditsLine(usage.credits) ?? figuresLine(usage)
    if (credits !== undefined) lines.push({ text: `  ${credits}`, heading: false })
    if ((section.id === 'openrouter' || section.id === 'gemini') && usage.readerNote !== undefined) {
      for (const note of usage.readerNote.split('; ')) lines.push({ text: `  ${note}`, heading: false })
    }
    const full = fullWindowLine(usage)
    if (full !== undefined) lines.push({ text: `  ${full}`, heading: false })
  }
  const jev = reads.jev()
  if (jev !== undefined) lines.push({ text: jev, heading: false })
  return lines
}

export function UsageCompact({ openToken, width, rowBudget }: { openToken?: number; width: number; rowBudget: number }): React.ReactNode {
  const tokens = useMercuryTokens()
  useCatalogueEpoch()
  useSyncExternalStore(subscribeJevSessionFacts, jevSessionFactsStamp, jevSessionFactsStamp)
  const plan = orderUsageSections(usageSectionPlan(providerFamilyPresences()), liveSignInRecency(), liveSessionFamily())
  const [, setSample] = useState(0)
  const asks = plan.filter(section => section.family.credentialed).map(section => section.id).join('|')
  useLoad(signal => {
    for (const id of asks.split('|').filter(Boolean) as ProviderFamilyId[]) {
      const operator = id === 'anthropic' && isClaudeAISubscriber() && openToken !== undefined && markOpenAsked(openToken)
      void refreshProviderUsage(id, { reason: operator ? 'operator' : 'open' }).then(() => {
        if (!signal.aborted) setSample(s => s + 1)
      })
    }
  }, [openToken, asks])
  const lines = usageCompactLines(plan)
  const rows = Math.max(0, Math.floor(rowBudget))
  const [cursor, setCursor] = useState(0)
  const [offset, setOffset] = useState(0)
  const view = settingsPopupWindow(cursor, offset, lines.length, rows)
  if (view.cursor !== cursor) setCursor(view.cursor)
  if (view.offset !== offset) setOffset(view.offset)
  usePopupMarker(rows > 0 ? settingsPopupMarker(view.cursor + 1, lines.length) : null)
  usePopupListPaging(view.cursor, lines.length, rows, setCursor)
  useInput((_input, key, event) => {
    if (!key.upArrow && !key.downArrow) return
    event.stopImmediatePropagation()
    const next = settingsPopupWindow(view.cursor + (key.upArrow ? -1 : 1), view.offset, lines.length, rows)
    setCursor(next.cursor)
    setOffset(next.offset)
  })
  const columns = Math.max(1, Math.floor(width))
  return (
    <Box flexDirection="column" width={columns} height={rows} flexShrink={0} overflow="hidden">
      {lines.slice(view.offset, view.offset + rows).map((line, index) => {
        const at = view.offset + index
        const current = at === view.cursor
        return (
          <Box key={at} height={1} flexShrink={0}>
            <Text bold={line.heading} color={current ? tokens.textPrimary : line.heading ? undefined : tokens.textSecondary} wrap="truncate-end">
              {current ? `${GLYPH.chevronRight} ` : '  '}
              {line.text}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}
