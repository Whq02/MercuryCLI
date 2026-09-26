import figures from 'figures'
import * as React from 'react'
import { useState } from 'react'
import { isTopOverlayNow, useRegisterOverlay } from '../context/overlayContext.js'
import { Box, Text, useInput, wrapText } from '../ink.js'
import { fitMeasuredWindow, paneWindow, panelWidth as panelWidthFor, type PaneWindow } from './mercury-ui/geometry.js'
import { useModalOrTerminalSize } from '../context/modalContext.js'
import { decodeNavKey } from './mercury-ui/navSemantics.js'
import { useOpenEventGate } from './mercury-ui/useOpenEventGate.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { useElevatedSurface } from './mercury-ui/useElevatedSurface.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { useSessionAccent } from './mercury-ui/sessionAccent.js'
import { useMercuryTokens } from './mercury-ui/useMercuryTokens.js'
import { focusedOptionSupports1m, stripContext1m, withContext1m } from '../utils/model/modelOptions.js'
import { has1mContext } from '../utils/context.js'
import { parseUserSpecifiedModel } from '../utils/model/model.js'
import { activeSourceUsage } from '../services/providers/providerUsage.js'
import { markTransitionEnd } from '../utils/observability/frictionStopwatch.js'
import { getContextWindowForModel } from '../utils/context.js'
import { AMBER, FAINT, IVORY, SAND, TEAL } from './mercuryPalette.js'
import { ProductLockup } from './mercury-ui/components.js'
import { GLYPH, padTo } from './mercury-ui/glyphs.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { EffortStrip, effortStripText } from './mercury-ui/EffortStrip.js'
import { gaugeColor } from './mercury-ui/theme.js'
import { modelPickerFooter } from '../utils/model/modelPickerFooter.js'
import { wrapPlain } from './BootHealthScreen.js'
import { FOLD_CLOSED_LEAD, FOLD_OPEN_LEAD, MenuFilterLine } from './mercury-ui/menuFold.js'
import {
  MODEL_PICKER_CURRENT,
  MODEL_PICKER_FILTER_PLACEHOLDER,
  MODEL_PICKER_NO_ALIAS,
  MODEL_PICKER_PANEL,
  MODEL_PICKER_UNAVAILABLE,
  composePickerLines,
  cyclePickerFold,
  doorWords,
  firstRowIndex,
  groupPickerRows,
  hasAlias,
  headingIndexOf,
  headingWords,
  initialPickerFolds,
  isCursorStop,
  isModelRow,
  lastStop,
  matchWords,
  moreLineWords,
  nextStop,
  pickerColumns,
  rowKey,
  type CatalogueDoorFacet,
  type FoldState,
  type PickerLine,
  type ProviderHeading,
} from '../utils/model/modelPickerGroups.js'
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

export function modelPickerCentred(): boolean {
  try {
    return getInitialSettings().modelPickerCentred !== false
  } catch {
    return true
  }
}

function bar(pct: number, width = 10): string {
  const f = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return '█'.repeat(f) + '░'.repeat(width - f)
}

export type ModelChoice = {
  id: string
  name: string
  tag: string
  ctx: string
  ctxBase?: string
  ctx1m?: string
  group: string
  door?: string
  gated?: boolean
  enableFlag?: string
  gatedReason?: string
  action?: boolean
  expand?: CatalogueDoorFacet
  choice?: string
}

type Props = {
  models: ModelChoice[]
  current?: string
  ctxPct?: number | null
  efforts?: string[]
  effort?: string
  onEffort?: (e: string) => void
  onSelect?: (id: string, door?: string) => void
  onClose?: () => void
  notice?: string
  pendingNext?: string
  headings?: Record<string, ProviderHeading>
  topGroup?: string
  onSlotSwitch?: (group: string) => string | null
  expandRows?: (group: string) => ModelChoice[]
}

const cell = (text: string, width: number): string => (width <= 2 ? '' : `${padTo(text, width - 2)}  `)

export function MercuryModelPicker({ models: listed, current = 'opus-4-8', ctxPct = 62, efforts, effort, onEffort, onSelect, onClose, notice, pendingNext, headings, topGroup, onSlotSwitch, expandRows }: Props): React.ReactNode {
  const surfaceRef = useElevatedSurface()
  React.useEffect(() => {
    markTransitionEnd('picker-open')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const TERRA = useSessionAccent().accent
  const tokens = useMercuryTokens()
  const currentRow = stripGptServedWindowSuffix(current)
  const expandRowsRef = React.useRef(expandRows)
  expandRowsRef.current = expandRows
  const fullCache = React.useRef<{ listed: ModelChoice[]; rows: Map<string, ModelChoice[]> }>({ listed, rows: new Map() })
  if (fullCache.current.listed !== listed) fullCache.current = { listed, rows: new Map() }
  const fullRowsOf = (group: string): ModelChoice[] | undefined => {
    const cache = fullCache.current.rows
    if (!cache.has(group)) cache.set(group, expandRowsRef.current?.(group) ?? [])
    return cache.get(group)
  }
  const groups = React.useMemo(() => groupPickerRows(listed), [listed])
  const top = topGroup ?? groups[0]?.group
  const currentKey = ((): string | undefined => {
    const own = listed.find(m => m.id === currentRow && isModelRow(m))
    if (own !== undefined) return rowKey(own)
    for (const group of groups) {
      if (group.door === undefined) continue
      const deep = fullRowsOf(group.group)?.find(m => m.id === currentRow)
      if (deep !== undefined) return rowKey(deep)
    }
    return undefined
  })()
  const [folds, setFolds] = useState<Record<string, FoldState>>(() => {
    const initial = initialPickerFolds(groups, top, currentKey)
    for (const group of groups) {
      if (group.door === undefined || group.rows.some(m => rowKey(m) === currentKey)) continue
      if (fullRowsOf(group.group)?.some(m => rowKey(m) === currentKey)) initial[group.group] = 'full'
    }
    return initial
  })
  const [filter, setFilter] = useState('')
  const [filterFocus, setFilterFocus] = useState(false)
  const filtering = filter.trim() !== ''
  const lines = React.useMemo(
    () => composePickerLines(groups, folds, filter, fullRowsOf),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, folds, filter, listed],
  )
  const { columns: cols, rows: termRows } = useTerminalSize()
  const panelWidth = panelWidthFor(cols, MODEL_PICKER_PANEL)
  const inner = panelWidth - 4
  const columns = pickerColumns(inner - 4)
  const totalLines = lines.length
  const availRows = useModalOrTerminalSize({ rows: termRows, columns: cols }).rows
  const compact = availRows < 20
  const shedMeters = availRows < 13
  const landing = ((): number => {
    const at = currentKey === undefined ? -1 : lines.findIndex(line => line.kind === 'row' && line.key === currentKey)
    if (at >= 0) return at
    const first = firstRowIndex(lines)
    return first >= 0 ? first : Math.max(0, lines.findIndex(line => isCursorStop(line)))
  })()
  const [cursor, setI] = useState(landing)
  const [lineSnapshot, setLineSnapshot] = useState({ listed, lines })
  let i = Math.min(cursor, Math.max(0, totalLines - 1))
  if (!isCursorStop(lines[i])) i = nextStop(lines, i, 1) !== i ? nextStop(lines, i, 1) : nextStop(lines, i, -1)
  if (lineSnapshot.lines !== lines) {
    if (lineSnapshot.listed !== listed) {
      const prior = lineSnapshot.lines[Math.min(cursor, Math.max(0, lineSnapshot.lines.length - 1))]
      const priorKey = prior?.kind === 'row' ? prior.key : prior?.kind === 'heading' ? `heading:${prior.group}` : undefined
      const moved = lines.findIndex(line => (line.kind === 'row' ? line.key : line.kind === 'heading' ? `heading:${line.group}` : '') === priorKey)
      if (moved >= 0) i = moved
      if (i !== cursor) setI(i)
    }
    setLineSnapshot({ listed, lines })
  }
  const focusedLine = lines[i]
  const focusedModel = focusedLine?.kind === 'row' ? focusedLine.row : undefined
  const focusedHeading = focusedLine?.kind === 'heading' ? focusedLine : undefined
  const hasEffort = !!(efforts && efforts.length)
  const ei = hasEffort ? Math.max(0, efforts!.indexOf(effort ?? '')) : 0
  const ctxStateOf = (p: string | undefined): boolean => {
    if (p === undefined) return false
    if (parseGptModelId(p)) {
      return !(hasGptServedWindowSuffix(current) && stripGptServedWindowSuffix(current) === p)
    }
    return has1mContext(p) || focusedOptionSupports1m(p)
  }
  const focusedSupports1m = focusedModel !== undefined && focusedOptionSupports1m(focusedModel.id)
  const [context1m, setContext1m] = useState(ctxStateOf(focusedModel?.id))
  const focusedGptWindow = ((): { served: number; ceiling?: number; observed?: string } | null => {
    const p = focusedModel?.id
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
    const p = focusedModel?.id
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
    const line = lines[n]
    if (line?.kind === 'row') setContext1m(ctxStateOf(line.row.id))
  }
  const landOn = (next: PickerLine<ModelChoice>[], preferKey: string | undefined, fallbackGroup?: string): void => {
    let at = preferKey === undefined ? -1 : next.findIndex(line => line.kind === 'row' && line.key === preferKey)
    if (at < 0 && fallbackGroup !== undefined) at = headingIndexOf(next, fallbackGroup)
    if (at < 0) at = firstRowIndex(next)
    if (at < 0) at = Math.max(0, next.findIndex(line => isCursorStop(line)))
    setI(at)
    setCtxNotice(null)
    const line = next[at]
    if (line?.kind === 'row') setContext1m(ctxStateOf(line.row.id))
  }
  const setFilterText = (text: string): void => {
    const next = composePickerLines(groups, folds, text, fullRowsOf)
    setFilter(text)
    const keep = focusedModel !== undefined ? rowKey(focusedModel) : undefined
    landOn(next, text.trim() === '' ? (keep ?? currentKey) : keep)
  }
  const setFold = (group: string, fold: FoldState, keep?: string): void => {
    const nextFolds = { ...folds, [group]: fold }
    const next = composePickerLines(groups, nextFolds, filter, fullRowsOf)
    setFolds(nextFolds)
    landOn(next, keep, group)
  }
  const groupHidden = (group: string): boolean => lines.some(line => line.kind === 'more' && line.group === group)
  const commitCurrent = (): void => {
    const line = lines[i]
    if (!line) return
    if (line.kind === 'heading') {
      if (filtering) return
      setFold(line.group, line.fold === 'folded' ? 'top' : 'folded')
      return
    }
    if (line.kind !== 'row') return
    const m = line.row
    if (!onSelect) return
    if (m.gated) {
      if (m.gatedReason) setCtxNotice(`${m.gatedReason} — not selectable`)
      return
    }
    const p = m.id
    if (p && focusedOptionSupports1m(p)) {
      const base = stripContext1m(p)
      onSelect(context1m === has1mContext(p) ? m.id : (context1m ? withContext1m(base) : base), m.door)
    } else if (p && parseGptModelId(p) && focusedGptToggle) {
      onSelect(context1m ? m.id : withGptServedWindowSuffix(m.id), m.door)
    } else {
      onSelect(m.id, m.door)
    }
  }
  const pastOpenEvent = useOpenEventGate()
  const overlayToken = useRegisterOverlay('model-picker', true)
  useInput((input, key, event) => {
    const rowAxis = decodeNavKey(input, key, { orientation: 'vertical', hierarchy: true })
    if (rowAxis === 'cancel') {
      if (overlayToken !== null && !isTopOverlayNow(overlayToken)) return
      event.stopImmediatePropagation()
      if (filterFocus || filter !== '') {
        setFilterFocus(false)
        setFilterText('')
        return
      }
      onClose?.()
      return
    }
    if (rowAxis === 'moveNext') { event.stopImmediatePropagation(); selectRow(nextStop(lines, i, 1)); return }
    if (rowAxis === 'movePrevious') { event.stopImmediatePropagation(); selectRow(nextStop(lines, i, -1)); return }
    if (rowAxis === 'first') { event.stopImmediatePropagation(); selectRow(Math.max(0, lines.findIndex(line => isCursorStop(line)))); return }
    if (rowAxis === 'last') { event.stopImmediatePropagation(); selectRow(lastStop(lines)); return }
    if (rowAxis === 'activate') {
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      commitCurrent()
      return
    }
    if (rowAxis === 'enterChild' || rowAxis === 'leaveChild') {
      event.stopImmediatePropagation()
      if (filtering) return
      const line = lines[i]
      if (!line || (line.kind !== 'row' && line.kind !== 'heading')) return
      const group = line.kind === 'row' ? line.row.group : line.group
      const fold = folds[group] ?? 'top'
      if (rowAxis === 'leaveChild') {
        if (line.kind === 'row') selectRow(headingIndexOf(lines, group))
        else if (fold !== 'folded') setFold(group, 'folded')
        return
      }
      const hidden = groupHidden(group)
      const next = cyclePickerFold(fold, 'open', hidden)
      if (next !== fold) setFold(group, next, line.kind === 'row' ? line.key : undefined)
      else if (line.kind === 'heading') selectRow(firstRowIndex(lines, i))
      return
    }
    if (filterFocus) {
      if (key.backspace || key.delete) {
        event.stopImmediatePropagation()
        setFilterText(filter.slice(0, -1))
        return
      }
      if (input.length > 0 && !key.ctrl && !key.meta && !key.tab) {
        event.stopImmediatePropagation()
        if (!pastOpenEvent()) return
        setFilterText(filter + input)
      }
      return
    }
    if (input === '/' && !key.ctrl && !key.meta) {
      event.stopImmediatePropagation()
      if (!pastOpenEvent()) return
      setFilterFocus(true)
      return
    }
    if (input === 'c' && !key.ctrl && !key.meta && focusedSupports1m) {
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
    else if (input === 'c' && !key.ctrl && !key.meta && focusedModel !== undefined && isModelRow(focusedModel)) {
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      setCtxNotice(focusedModel.ctx !== '' ? `${focusedModel.ctx} · stated by the provider · not a toggle` : 'context window unknown · the provider states none · not a toggle')
    }
    else if (input === 'e' && !key.ctrl && !key.meta && hasEffort) {
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      onEffort?.(efforts![(ei + 1) % efforts!.length]!)
    }
    else if (input === 'E' && !key.ctrl && !key.meta && hasEffort) {
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      onEffort?.(efforts![(ei - 1 + efforts!.length) % efforts!.length]!)
    }
    else if (input === 's' && !key.ctrl && !key.meta && onSlotSwitch && focusedModel) {
      if (!pastOpenEvent()) return
      const receipt = onSlotSwitch(focusedModel.group)
      if (receipt !== null) {
        event.stopImmediatePropagation()
        setCtxNotice(receipt)
      }
    }
  })
  const linePaint = (idx: number): number => {
    const line = lines[idx]
    if (!line) return 0
    if (line.kind !== 'row') return 1
    if (compact || idx !== i) return 1
    const tag = line.row.tag
    return tag === '' ? 3 : 3 + wrapText(tag, panelWidth - 8, 'wrap').split('\n').length
  }
  const reasonLines: string[] | null =
    focusedModel !== undefined && focusedModel.gated && focusedModel.gatedReason
      ? wrapPlain(`${focusedModel.id} · ${focusedModel.gatedReason} — not selectable`, inner)
      : null
  const painted = (text: string): number => wrapText(text, inner, 'wrap').split('\n').length
  const pendingLine = pendingNext
    ? [
        { text: 'current ', color: FAINT },
        { text: listed.find(m => m.id === currentRow)?.name ?? current, color: TEAL },
        { text: ` ${GLYPH.pending} next `, color: AMBER },
        { text: listed.find(m => m.id === pendingNext)?.name ?? pendingNext, color: AMBER },
        { text: ' · applies when the turn settles', color: FAINT },
      ]
    : null
  const noticeLines: string[] = compact
    ? []
    : ctxNotice
      ? wrapPlain(ctxNotice, inner)
      : reasonLines !== null
        ? reasonLines
        : notice
          ? [notice]
          : []
  const basePaint =
    2 + 1 + (compact ? 0 : 2) + (shedMeters ? 0 : 1) + 2 +
    (hasEffort ? (compact ? 1 : painted(effortStripText(efforts!, effort))) : 0) +
    (pendingLine !== null ? painted(pendingLine.map(part => part.text).join('')) : 0) +
    noticeLines.length
  const paintBudget = Math.max(3, availRows - basePaint)
  const windowPaint = (w: PaneWindow): number => {
    let sum = (w.above > 0 ? 1 : 0) + (w.below > 0 ? 1 : 0)
    for (let idx = w.start; idx < w.end; idx++) sum += linePaint(idx)
    return sum
  }
  const win = fitMeasuredWindow(totalLines, paintBudget, span => paneWindow(totalLines, i, span), windowPaint)
  const slack = win.above > 0 || win.below > 0 ? Math.max(0, paintBudget - windowPaint(win)) : 0
  const totalModels = lines.reduce((sum, line) => sum + (line.kind === 'heading' ? (line.total ?? 0) : 0), 0)
  const matched = lines.reduce((sum, line) => sum + (line.kind === 'heading' ? (line.matched ?? 0) : 0), 0)
  const stateWordOf = (m: ModelChoice): [string, string] =>
    m.id === currentRow ? [MODEL_PICKER_CURRENT, TEAL] : pendingNext !== undefined && m.id === pendingNext ? ['next', AMBER] : m.gated ? [MODEL_PICKER_UNAVAILABLE, SAND] : ['', FAINT]
  const footer = modelPickerFooter(
    {
      gated: !!focusedModel?.gated,
      ...(focusedModel?.enableFlag !== undefined ? { enableFlag: focusedModel.enableFlag } : {}),
      ...(focusedHeading !== undefined ? { heading: { fold: focusedHeading.fold === 'folded' ? 'folded' : 'open' } } : {}),
      filterFocus,
      filtering,
    },
    inner,
  )
  const renderLine = (line: PickerLine<ModelChoice>, idx: number): React.ReactNode => {
    if (line.kind === 'heading') {
      const on = idx === i
      const heading = headings?.[line.group]
      const words = headingWords(heading, line.group, { live: line.live, ...(line.matched !== undefined ? { matched: line.matched, total: line.total ?? 0 } : {}) })
      const cut = words.indexOf(' · ')
      const name = cut < 0 ? words : words.slice(0, cut)
      const rest = cut < 0 ? '' : words.slice(cut)
      return (
        <InteractiveRow key={`heading:${line.group}`} id={`model:group:${line.group}`} selected={on} onSelect={() => selectRow(idx)} onActivate={commitCurrent} width={inner} height={1} selectionBand={true}>
          <Text wrap="truncate-end">
            <Text color={on ? TERRA : FAINT}>{on ? `${GLYPH.prompt} ` : line.fold === 'folded' ? FOLD_CLOSED_LEAD : FOLD_OPEN_LEAD}</Text>
            <Text bold color={tokens.info}>{name}</Text>
            <Text color={FAINT}>{rest}</Text>
          </Text>
        </InteractiveRow>
      )
    }
    if (line.kind === 'door') {
      const door = headings?.[line.group]?.doors.find(candidate => candidate.door === line.door)
      const words = doorWords(door ?? { door: line.door }, { live: line.live, ...(line.matched !== undefined ? { matched: line.matched, total: line.total ?? 0 } : {}) })
      return (
        <Box key={`door:${line.group}:${line.door}`} height={1}>
          <Text color={tokens.textSecondary} wrap="truncate-end">{`  ${words}`}</Text>
        </Box>
      )
    }
    if (line.kind === 'more') {
      return (
        <Box key={`more:${line.group}`} height={1}>
          <Text color={FAINT} wrap="truncate-end">{`  ${moreLineWords(line.hidden, line.reach)}`}</Text>
        </Box>
      )
    }
    const m = line.row
    const on = idx === i
    const [stateWord, stateColor] = stateWordOf(m)
    const model = isModelRow(m)
    const alias = model ? (hasAlias(m) ? m.name : '—') : m.name
    const ctxText = on && (focusedSupports1m || focusedGptToggle) ? (context1m ? (m.ctx1m ?? m.ctx) : (m.ctxBase ?? m.ctx)) : m.ctx
    const tail = model && !hasAlias(m) ? MODEL_PICKER_NO_ALIAS : ''
    return (
      <InteractiveRow
        key={line.key}
        id={`model:row:${line.key}`}
        selected={on}
        unavailable={m.gated}
        onSelect={() => selectRow(idx)}
        onActivate={commitCurrent}
        flexDirection="column"
        selectionBand={compact}
      >
        <Box borderStyle={on && !compact ? 'round' : undefined} borderColor={on && !compact ? TERRA : undefined} paddingLeft={on && !compact ? 1 : 2} paddingRight={1} flexDirection="column">
          <Text wrap="truncate-end">
            {compact ? <Text color={on ? TERRA : FAINT}>{on ? `${figures.pointer} ` : '  '}</Text> : null}
            {model ? (
              <>
                <Text bold color={m.gated ? SAND : hasAlias(m) ? IVORY : FAINT}>{cell(alias, columns.alias)}</Text>
                <Text color={FAINT}>{cell(m.id, columns.id)}</Text>
              </>
            ) : (
              <Text bold color={m.gated ? SAND : IVORY}>{cell(m.name, columns.alias + columns.id)}</Text>
            )}
            <Text color={stateColor}>{cell(stateWord, columns.state)}</Text>
            <Text color={FAINT}>{cell(ctxText, columns.ctx)}</Text>
            <Text color={tokens.info}>{tail}</Text>
          </Text>
          {on && !compact && m.tag !== '' ? <Text color={SAND}>{m.tag}</Text> : null}
        </Box>
      </InteractiveRow>
    )
  }
  return (
    <Box flexDirection="column" alignItems={modelPickerCentred() ? 'center' : 'flex-start'}>
    <Box ref={surfaceRef} flexDirection="column" borderStyle="round" borderColor={tokens.borderStrong} paddingX={1} width={panelWidth} flexShrink={0}>
      <ProductLockup view="model" separator=" · " plain {...(filtering ? { subtitle: matchWords(matched, totalModels) } : {})} />
      {compact ? null : <Box height={1} />}
      {pendingLine !== null ? (
        <Text>
          {pendingLine.map((part, k) => (
            <Text key={k} color={part.color}>{part.text}</Text>
          ))}
        </Text>
      ) : null}
      {win.above > 0 ? <Text color={FAINT}>  ↑ {win.above} more</Text> : null}
      {lines.map((line, idx) => (idx < win.start || idx >= win.end ? null : renderLine(line, idx)))}
      {slack > 0 ? <Box height={slack} flexShrink={0} /> : null}
      {win.below > 0 ? <Text color={FAINT}>  ↓ {win.below} more</Text> : null}
      {compact ? null : <Box height={1} />}
      {shedMeters ? null : <Box>
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
            <Text color={FAINT}> e cycles</Text>
          </Text>
        ) : (
          <Text wrap="truncate-end">
            <EffortStrip levels={efforts!} current={effort} accent={TERRA} faint={FAINT} />
            <Text color={FAINT}>· e cycles</Text>
          </Text>
        )
      ) : null}
      {noticeLines.map((line, k) => (
        <Text key={k} color={reasonLines !== null && ctxNotice === null ? FAINT : tokens.info} wrap="truncate-end">{line}</Text>
      ))}
      <MenuFilterLine focused={filterFocus} text={filter} placeholder={MODEL_PICKER_FILTER_PLACEHOLDER} accent={TERRA} muted={FAINT} primary={IVORY} />
      <Text color={FAINT} wrap="truncate-end">{footer}</Text>
    </Box>
    </Box>
  )
}
