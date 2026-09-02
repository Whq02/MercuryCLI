import figures from 'figures'
import * as React from 'react'
import { useState } from 'react'
import { isTopOverlayNow, useRegisterOverlay } from '../context/overlayContext.js'
import { Box, Text, useInput } from '../ink.js'
import { fitMeasuredWindow, packLines, paneWindow, panelWidth as panelWidthFor, type PaneWindow } from './mercury-ui/geometry.js'
import { useModalOrTerminalSize } from '../context/modalContext.js'
import { decodeNavKey } from './mercury-ui/navSemantics.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { focusedOptionSupports1m, isProviderActionRow, stripContext1m, withContext1m } from '../utils/model/modelOptions.js'
import { has1mContext } from '../utils/context.js'
import { getDefaultMainLoopModel, parseUserSpecifiedModel } from '../utils/model/model.js'
import { activeSourceUsage } from '../services/providers/providerUsage.js'
import { markTransitionEnd } from '../utils/observability/frictionStopwatch.js'
import { getContextWindowForModel } from '../utils/context.js'
import { AMBER, FAINT, IVORY, SAND, TEAL } from './mercuryPalette.js'
import { ProductLockup } from './mercury-ui/components.js'
import { GLYPH, padTo } from './mercury-ui/glyphs.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { gaugeColor } from './mercury-ui/theme.js'
import { modelPickerFooter } from '../utils/model/modelPickerFooter.js'
import {
  parseGptModelId,
  gptDisplayPin,
  hasGptServedWindowSuffix,
  liveGptContextWindow,
  liveGptContextCeiling,
  stripGptServedWindowSuffix,
  withGptServedWindowSuffix,
} from '../services/providers/openai/openaiCatalogue.js'

export const fmtCtx = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`
    : `${Math.round(n / 1000)}k`
function bar(pct: number, width = 10): string {
  const f = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return '█'.repeat(f) + '░'.repeat(width - f)
}

export type ModelChoice = { id: string; name: string; tag: string; ctx: string; ctxBase?: string; ctx1m?: string; group: string; gated?: boolean; enableFlag?: string; gatedReason?: string;  action?: boolean }

type Props = {
  models: ModelChoice[]
  current?: string
  ctxPct?: number | null
  efforts?: string[]
  effort?: string
  onEffort?: (e: string) => void
  onSelect?: (id: string) => void
  onClose?: () => void
  notice?: string
  pendingNext?: string
  groupDetails?: Record<string, string>
  onSlotSwitch?: (group: string) => string | null
}


export function MercuryModelPicker({ models, current = 'opus-4-8', ctxPct = 62, efforts, effort, onEffort, onSelect, onClose, notice, pendingNext, groupDetails, onSlotSwitch }: Props): React.ReactNode {
  React.useEffect(() => {
    markTransitionEnd('picker-open')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const TERRA = useSessionAccent().accent
  const tokens = useMercuryTokens()
  const { columns: cols, rows: termRows } = useTerminalSize()
  const panelWidth = panelWidthFor(cols, { cap: 62, reserve: 2, min: 20 })
  const nameW = Math.max(15, Math.min(30, panelWidth - 32))
  const totalRows = models.length
  const availRows = useModalOrTerminalSize({ rows: termRows, columns: cols }).rows
  const compact = availRows < 20
  const shedMeters = availRows < 13
  const currentRow = stripGptServedWindowSuffix(current)
  const startI = Math.max(0, models.findIndex(m => m.id === currentRow))
  const [i, setI] = useState(startI)
  const focusedModel = i < models.length ? models[i] : undefined
  const hasEffort = !!(efforts && efforts.length)
  const ei = hasEffort ? Math.max(0, efforts!.indexOf(effort ?? '')) : 0
  const probe = (m?: ModelChoice): string | null => m ? (m.id === 'default' ? getDefaultMainLoopModel() : m.id) : null
  const ctxStateOf = (p: string | null): boolean => {
    if (p !== null && parseGptModelId(p)) {
      return !(hasGptServedWindowSuffix(current) && stripGptServedWindowSuffix(current) === p)
    }
    return has1mContext(p ?? '') || focusedOptionSupports1m(p)
  }
  const focusedSupports1m = focusedOptionSupports1m(probe(focusedModel))
  const [context1m, setContext1m] = useState(ctxStateOf(probe(models[startI])))
  const focusedGptWindow = ((): { served: number; ceiling?: number; observed?: string } | null => {
    const p = probe(focusedModel)
    if (!p || !parseGptModelId(p)) return null
    const live = liveGptContextWindow(p)
    const pin = gptDisplayPin(p)
    const served = live ?? pin?.contextWindow
    if (served === undefined) return null
    const ceiling = liveGptContextCeiling(p)
    return {
      served,
      ...(ceiling !== undefined && ceiling > served ? { ceiling } : {}),
      ...(live === undefined && pin?.observedAt !== undefined ? { observed: pin.observedAt } : {}),
    }
  })()
  const focusedGptToggle = focusedGptWindow?.ceiling !== undefined
  const [ctxNotice, setCtxNotice] = useState<string | null>(null)
  const focusedNative1m = ((): boolean => {
    const p = probe(focusedModel)
    if (!p || focusedSupports1m || focusedGptWindow) return false
    try {
      return getContextWindowForModel(parseUserSpecifiedModel(stripContext1m(p)) as never) >= 1_000_000
    } catch {
      return false
    }
  })()
  const selectRow = (n: number): void => {
    setI(n)
    setCtxNotice(null)
    if (n < models.length) setContext1m(ctxStateOf(probe(models[n])))
  }
  const commitCurrent = (): void => {
    const m = models[i]; if (!m || !onSelect) return
    if (m.gated) {
      if (m.gatedReason) setCtxNotice(`${m.gatedReason} — not selectable`)
      return
    }
    const p = probe(m)
    if (p && focusedOptionSupports1m(p)) {
      const base = stripContext1m(p)
      onSelect(context1m === has1mContext(p) ? m.id : (context1m ? withContext1m(base) : base))
    } else if (p && parseGptModelId(p) && focusedGptToggle) {
      onSelect(context1m ? m.id : withGptServedWindowSuffix(m.id))
    } else {
      onSelect(m.id)
    }
  }
  const pastOpenEvent = useOpenEventGate()
  const overlayToken = useRegisterOverlay('model-picker', true)
  useInput((input, key, event) => {
    const rowAxis = decodeNavKey(input, key, { orientation: 'vertical' })
    const effortAxis = decodeNavKey(input, key, { orientation: 'horizontal' })
    if (rowAxis === 'moveNext') { event.stopImmediatePropagation(); selectRow(Math.min(totalRows - 1, i + 1)) }
    else if (rowAxis === 'movePrevious') { event.stopImmediatePropagation(); selectRow(Math.max(0, i - 1)) }
    else if (rowAxis === 'first') { event.stopImmediatePropagation(); selectRow(0) }
    else if (rowAxis === 'last') { event.stopImmediatePropagation(); selectRow(totalRows - 1) }
    else if (effortAxis === 'moveLeft' && hasEffort) { event.stopImmediatePropagation(); onEffort?.(efforts![(ei - 1 + efforts!.length) % efforts!.length]) }
    else if (effortAxis === 'moveRight' && hasEffort) { event.stopImmediatePropagation(); onEffort?.(efforts![(ei + 1) % efforts!.length]) }
    else if (input === 'c' && !key.ctrl && !key.meta && focusedOptionSupports1m(probe(focusedModel))) {
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      setContext1m(v => !v)
    }
    else if (input === 'c' && !key.ctrl && !key.meta && focusedGptWindow && focusedGptWindow.ceiling !== undefined) {
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      const big = !context1m
      setContext1m(big)
      setCtxNotice(
        big
          ? `${fmtCtx(focusedGptWindow.ceiling)} ctx active · the source-declared max (served default ${fmtCtx(focusedGptWindow.served)}) · c toggles`
          : `${fmtCtx(focusedGptWindow.served)} ctx active · the source's served default (declared max ${fmtCtx(focusedGptWindow.ceiling)}) · c toggles`,
      )
    }
    else if (input === 'c' && !key.ctrl && !key.meta && focusedGptWindow) {
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      setCtxNotice(
        focusedGptWindow.observed !== undefined
          ? `${fmtCtx(focusedGptWindow.served)} ctx · model-page figure as observed ${focusedGptWindow.observed} — the live account catalogue decides at dispatch · not a toggle`
          : `${fmtCtx(focusedGptWindow.served)} ctx · set by the GPT account source · not a toggle`,
      )
    }
    else if (input === 'c' && !key.ctrl && !key.meta && focusedNative1m) {
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      setCtxNotice('1M ctx · native to this model · not a toggle')
    }
    else if (input === 's' && !key.ctrl && !key.meta && onSlotSwitch && focusedModel) {
      if (!pastOpenEvent()) return
      const receipt = onSlotSwitch(focusedModel.group)
      if (receipt !== null) {
        event.stopImmediatePropagation()
        setCtxNotice(receipt)
      }
    }
    else if (rowAxis === 'activate') {
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      commitCurrent()
    }
    else if (rowAxis === 'cancel') {
      if (overlayToken !== null && !isTopOverlayNow(overlayToken)) return
      event.stopImmediatePropagation()
      onClose?.()
    }
  })
  const rowPaint = (idx: number): number => {
    if (compact) return 1
    return idx === i ? (models[idx]?.tag ? 4 : 3) : 1
  }
  const detailLines = new Map<string, string[]>()
  for (const [g, detail] of Object.entries(groupDetails ?? {})) {
    detailLines.set(g, packLines(detail.split(' · '), panelWidth - 4))
  }
  const headingPaint = (w: PaneWindow): number => {
    let lines = 0
    if (!compact) {
      let prev: string | undefined
      for (let idx = w.start; idx < Math.min(w.end, models.length); idx++) {
        const g = models[idx]!.group
        if (g !== prev) lines += 2 + (detailLines.get(g)?.length ?? 0)
        prev = g
      }
    }
    return lines
  }
  const basePaint =
    (compact ? (shedMeters ? 5 : 6) : 10) +
    (pendingNext ? 1 : 0) +
    (!compact && ctxNotice ? 2 : !compact && notice ? 1 : 0)
  const paintBudget = Math.max(3, availRows - basePaint)
  const win = fitMeasuredWindow(
    totalRows,
    paintBudget,
    span => paneWindow(totalRows, i, span),
    w => {
      let lines = (w.above > 0 ? 1 : 0) + (w.below > 0 ? 1 : 0) + headingPaint(w)
      for (let idx = w.start; idx < w.end; idx++) lines += rowPaint(idx)
      return lines
    },
  )
  let lastGroup: string | null = null
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tokens.borderStrong} paddingX={1} width={panelWidth} flexShrink={0}>
      {
}
      <ProductLockup view="model" />
      {
}
      {compact ? null : <Text color={FAINT}>CHOOSE A MODEL · {models.filter(m => !m.gated && !m.action).length} AVAILABLE · {models.filter(m => m.gated).length} GATED</Text>}
      {pendingNext ? (
        <Text>
          <Text color={FAINT}>current </Text>
          <Text color={TEAL}>{models.find(m => m.id === currentRow)?.name ?? current}</Text>
          <Text color={AMBER}>{` ${GLYPH.pending} next `}</Text>
          <Text color={AMBER}>{models.find(m => m.id === pendingNext)?.name ?? pendingNext}</Text>
          <Text color={FAINT}> · applies when the turn settles</Text>
        </Text>
      ) : null}
      {win.above > 0 ? <Text color={FAINT}>  ↑ {win.above} more</Text> : null}
      {models.map((m, idx) => {
        if (idx < win.start || idx >= win.end) return null
        const head = m.group !== lastGroup; lastGroup = m.group
        const on = idx === i; const cur = m.id === currentRow
        const isNext = pendingNext !== undefined && m.id === pendingNext
        const [sg, sw, sc] = cur ? [GLYPH.done, 'current', TEAL] as const : isNext ? [GLYPH.pending, 'next', AMBER] as const : m.gated ? [GLYPH.fisheye, m.gatedReason ? 'unavail' : 'gated', AMBER] as const : [GLYPH.pending, 'switch', FAINT] as const
        return (
          <React.Fragment key={m.id}>
            {
}
            {head && !compact ? <Box marginTop={1} flexDirection="column">
              <Text bold color={tokens.info}>{m.group.toUpperCase()}</Text>
              {detailLines.get(m.group)?.map((line, k) => (
                <Text key={k} color={FAINT} wrap="truncate-end">{line}</Text>
              ))}
            </Box> : null}
            <InteractiveRow
              id={`model:row:${m.id}`}
              selected={on}
              unavailable={m.gated}
              onSelect={() => selectRow(idx)}
              onActivate={commitCurrent}
              flexDirection="column"
              selectionBand={compact}
            >
            <Box borderStyle={on && !compact ? 'round' : undefined} borderColor={on && !compact ? TERRA : undefined} paddingLeft={on && !compact ? 1 : 2} paddingRight={1} flexDirection="column">
              {
}
              <Text wrap="truncate-end">
                {
}
                {compact ? <Text color={on ? TERRA : FAINT}>{on ? `${figures.pointer} ` : '  '}</Text> : null}
                <Text bold color={m.gated ? SAND : IVORY}>{padTo(m.name, nameW)}</Text>
                <Text color={sc}>{' ' + padTo(`${sg} ${sw}`, 11)}</Text>
                {
}
                <Text color={FAINT}>{on && (focusedSupports1m || focusedGptToggle) ? (context1m ? (m.ctx1m ?? m.ctx) : (m.ctxBase ?? m.ctx)) : m.ctx}</Text>
              </Text>
              {on && !compact && m.tag !== '' ? <Text color={SAND}>{m.tag}</Text> : null}
            </Box>
            </InteractiveRow>
          </React.Fragment>
        )
      })}
      {win.below > 0 ? <Text color={FAINT}>  ↓ {win.below} more</Text> : null}
      {shedMeters ? null : <Box marginTop={compact ? 0 : 1}>
        {
}
        <Text wrap="truncate-end"><Text color={FAINT}>context </Text>{ctxPct === null ? <Text color={FAINT}>—</Text> : <><Text color={gaugeColor(ctxPct)}>{bar(ctxPct, 12)}</Text><Text color={SAND}> {ctxPct}%</Text></>}{((): React.ReactNode => {
          if (compact) return null
          const tier = activeSourceUsage().tier
          return tier ? <Text><Text color={FAINT}>  · tier </Text><Text color={IVORY}>{tier}</Text></Text> : null
        })()}</Text>
      </Box>}
      {hasEffort ? (
        compact ? (
          <Text wrap="truncate-end">
            <Text color={FAINT}>effort  </Text>
            <Text bold color={TERRA}>[{effort}]</Text>
            <Text color={FAINT}> ←→ cycle</Text>
          </Text>
        ) : (
          <Text>
            <Text color={FAINT}>effort  </Text>
            {efforts!.map(e => (
              <Text key={e} bold={e === effort} color={e === effort ? TERRA : FAINT}>
                {e === effort ? `[${e}] ` : `${e} `}
              </Text>
            ))}
          </Text>
        )
      ) : null}
      {
}
      {ctxNotice && !compact ? (
        <Text color={tokens.info} wrap="wrap">{ctxNotice}</Text>
      ) : notice && !compact ? (
        <Text color={tokens.info} wrap="truncate-end">{notice}</Text>
      ) : null}
      {
}
      <Box marginTop={compact ? 0 : 1} display={compact ? 'none' : 'flex'}>
        <Text color={FAINT} wrap="truncate-end">
          {
}
          {isProviderActionRow(focusedModel!.id)
            ? 'connect action — ↵ starts the sign-in; not a model'
            : focusedModel!.gated
              ? focusedModel!.gatedReason
                ? `${focusedModel!.id} · ${focusedModel!.gatedReason} — not selectable`
                : `gated — set ${focusedModel!.enableFlag ?? focusedModel!.ctx} to enable. Never shown as live.`
              : `${focusedModel!.id} · model IDs are real, never themed`}
        </Text>
      </Box>
      {
}
      <Text color={FAINT} wrap="truncate-end">{modelPickerFooter({ hasEffort, supports1m: focusedSupports1m || focusedGptToggle, gated: !!focusedModel?.gated, enableFlag: focusedModel?.enableFlag }, panelWidth - 4)}</Text>
    </Box>
  )
}
