import * as React from 'react'
import { useState, useSyncExternalStore } from 'react'
import { useRegisterOverlay } from '../../../screen/overlays/overlayHooks.js'
import { Box, Text, useInput } from '../../../screen/themedRenderer.js'
import { usePopupListPaging } from '../../../screen/select/popup-list.js'
import { panelWidth as panelWidthFor } from '../../../screen/widgets/geometry.js'
import { useModalOrTerminalSize } from '../../../screen/overlays/modalContext.js'
import { PopupFrameContext } from '../../../screen/overlays/PopupGutter.js'
import { decodeNavKey } from '../../../screen/widgets/navSemantics.js'
import { useOpenEventGate } from '../../../screen/widgets/useOpenEventGate.js'
import { useLoad, useMount } from '../../../screen/effects/effects.js'
import { useTerminalSize } from '../../../screen/fullscreen-layout/useTerminalSize.js'
import { useElevatedSurface } from '../../../screen/widgets/useElevatedSurface.js'
import { getInitialSettings } from '../../../platform/settings/settings.js'
import { useSessionAccent } from '../../../screen/widgets/sessionAccent.js'
import { useMercuryTokens } from '../../../screen/widgets/useMercuryTokens.js'
import { focusedOptionSupports1m, stripContext1m } from '../../../models/catalogue/modelOptions.js'
import { has1mContext } from '../../../engine/compaction-window/contextFill.js'
import { parseUserSpecifiedModel } from '../../../models/catalogue/engineModel.js'
import { markTransitionEnd } from '../../../platform/observability/frictionStopwatch.js'
import { getContextWindowForModel } from '../../../engine/compaction-window/contextFill.js'
import { AMBER, FAINT, IVORY, SAND, TEAL } from '../../../screen/theme/mercuryPalette.js'
import { ProductLockup } from '../../../screen/widgets/components.js'
import { truncateStartToWidth } from '../../../platform/text/truncate.js'
import { EffortStrip } from '../../../screen/widgets/EffortStrip.js'
import { gaugeColor } from '../../../screen/widgets/theme.js'
import { modelPickerFooter } from '../../../models/facts/modelPickerFooter.js'
import type { ModelPickerFooterKeys } from '../../../models/facts/modelPickerFooter.js'
import { FOLD_OPEN_LEAD, MenuFilterLine } from '../../../screen/widgets/menuFold.js'
import {
  MODEL_PICKER_CURRENT,
  MODEL_PICKER_EFFORT_WORDS,
  MODEL_PICKER_FILTER_PLACEHOLDER,
  MODEL_PICKER_SEARCH_PLACEHOLDER,
  MODEL_PICKER_PANEL,
  MODEL_PICKER_UNAVAILABLE,
  composePickerLines,
  firstRowIndex,
  groupPickerRows,
  initialPickerFolds,
  isCursorStop,
  isModelRow,
  matchWords,
  nextStop,
  orderPickerGroups,
  pickerColumns,
  pickerReachTotal,
  providerNameOfGroup,
  rowKey,
  type FoldState,
  type PickerGroup,
  type ProviderHeading,
} from '../../../models/facts/modelPickerGroups.js'
import {
  TENSORFOLD_GROUPS,
  TENSORFOLD_HOST_GROUP,
  TENSORFOLD_MODEL_GROUP,
  tensorFoldFoldedOnOpen,
  tensorFoldPickerRows,
  type TensorFoldAct,
  type TensorFoldPickerFacts,
  type TensorFoldTyping,
} from '../../../screen/tensorfold/tensorfoldRows.js'
import { isLocalModelId, LOCAL_MODEL_GROUP, localRecordFor } from '../../../models/roads/local/localCatalogue.js'
import { LOCAL_SETUP_PICKER_OFFER } from '../../localsetup/words.js'
import { localWindowApplication, localWindowRefusalSpan } from '../../../models/roads/local/localWindow.js'
import { localServerTruthStamp, refreshLocalMachineTruth, subscribeLocalServerTruth } from '../../../models/local-server/localServerTruth.js'
import {
  parseGptModelId,
  hasGptServedWindowSuffix,
  stripGptServedWindowSuffix,
} from '../../../models/roads/openai/openaiCatalogue.js'
import type { ModelChoice } from '../../../screen/model-picker/choice.js'
import { chordKeys, filterKeys, navigationKeys, tensorFoldKeys, windowTypingKeys, type PickerKeys } from '../../../screen/model-picker/keys.js'
import { focusedGptFacts } from '../../../screen/model-picker/focus.js'
import { pickerGeometry } from '../../../screen/model-picker/geometry.js'
import { pickerActs, pickerCursor } from '../../../screen/model-picker/moves.js'
import { pickerLineRenderer } from '../../../screen/model-picker/renderLine.js'
import { passedOver, passedOverAs } from '../../../platform/errors/passedOver.js'

export { fmtCtx } from '../../../screen/model-picker/choice.js'
export type { ModelChoice } from '../../../screen/model-picker/choice.js'

export function modelPickerCentred(): boolean {
  try {
    return getInitialSettings().view?.modelPicker?.centred !== false
  } catch (error) {
    passedOver(error)
    return true
  }
}

function bar(pct: number, width = 10): string {
  const f = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  return '█'.repeat(f) + '░'.repeat(width - f)
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
  expandRows?: (group: string) => ModelChoice[]
  initialFilter?: string
  view?: 'model' | 'tensorfold'
  live?: string
  tensorfold?: TensorFoldPickerFacts
  onTensorFold?: (act: TensorFoldAct) => void
  recentAt?: (group: string) => number | undefined
  tensorFoldFirst?: boolean
  hint?: string
}


function withTensorFoldRows(given: ModelChoice[], rows: ModelChoice[]): ModelChoice[] {
  const at = given.findIndex(row => row.group === LOCAL_MODEL_GROUP)
  return at < 0 ? [...given, ...rows] : [...given.slice(0, at), ...rows, ...given.slice(at)]
}

function placeTensorFoldGroups(groups: PickerGroup<ModelChoice>[], opts: { top?: string; recentAt?: (group: string) => number | undefined; first: boolean }): PickerGroup<ModelChoice>[] {
  const missing = TENSORFOLD_GROUPS.filter(name => !groups.some(group => group.group === name)).map(name => ({ group: name, rows: [], doors: [] }))
  const ordered = orderPickerGroups([...groups, ...missing], { ...(opts.top !== undefined ? { top: opts.top } : {}), ...(opts.recentAt !== undefined ? { recentAt: opts.recentAt } : {}), ...(opts.first ? { pinned: TENSORFOLD_GROUPS } : {}) })
  const host = ordered.find(group => group.group === TENSORFOLD_HOST_GROUP)
  const rest = ordered.filter(group => group !== host)
  const at = rest.findIndex(group => group.group === TENSORFOLD_MODEL_GROUP)
  return host === undefined || at < 0 ? ordered : [...rest.slice(0, at + 1), host, ...rest.slice(at + 1)]
}

export function MercuryModelPicker({ models: given, current = 'opus-4-8', ctxPct = 62, efforts, effort, onEffort, onSelect, onClose, notice, pendingNext, headings: givenHeadings, topGroup, expandRows, initialFilter, view = 'model', live, tensorfold, onTensorFold, recentAt, tensorFoldFirst = false, hint }: Props): React.ReactNode {
  const surfaceRef = useElevatedSurface()
  useMount(() => {
    markTransitionEnd('picker-open')
  })
  const TERRA = useSessionAccent().accent
  const tokens = useMercuryTokens()
  const currentRow = stripGptServedWindowSuffix(current)
  const [tfWindows, setTfWindows] = useState<Record<string, number>>({})
  const [tfRowMarks, setTfRowMarks] = useState<Record<string, { serving: boolean; refused: string }>>({})
  let activeTfWindows = tfWindows
  if (tensorfold !== undefined) {
    let marksMoved = false
    const nextMarks: Record<string, { serving: boolean; refused: string }> = {}
    const drop = new Set<string>()
    for (const row of tensorfold.rows) {
      if (row.startedBy === 'outside') continue
      const act = tensorfold.acts?.[row.repo]
      const serving = row.state === 'serving'
      const refused = act?.phase === 'refused' ? `${act.window ?? ''}:${act.asked ?? ''}:${act.line}` : ''
      nextMarks[row.repo] = { serving, refused }
      const prev = tfRowMarks[row.repo]
      if (prev === undefined) {
        marksMoved = true
        continue
      }
      if (prev.serving !== serving || prev.refused !== refused) marksMoved = true
      if ((prev.serving && !serving) || (refused !== '' && prev.refused !== refused)) drop.add(row.repo)
    }
    if (Object.keys(tfRowMarks).length !== Object.keys(nextMarks).length) marksMoved = true
    if (drop.size > 0) {
      const trimmed = Object.fromEntries(Object.entries(tfWindows).filter(([repo]) => !drop.has(repo)))
      if (Object.keys(trimmed).length !== Object.keys(tfWindows).length) {
        activeTfWindows = trimmed
        setTfWindows(trimmed)
      }
    }
    if (marksMoved) setTfRowMarks(nextMarks)
  }
  const [tfTyping, setTfTyping] = useState<TensorFoldTyping | null>(null)
  const [tfConfirm, setTfConfirm] = useState<string | null>(null)
  const tf = React.useMemo(
    () => (tensorfold === undefined ? undefined : tensorFoldPickerRows(tensorfold, { view, current: currentRow, windows: activeTfWindows, ...(tfTyping !== null ? { typing: tfTyping } : {}), ...(tfConfirm !== null ? { confirmStop: tfConfirm } : {}) })),
    [tensorfold, view, currentRow, activeTfWindows, tfTyping, tfConfirm],
  )
  const listed = React.useMemo(() => (tf === undefined ? given : view === 'tensorfold' ? tf.rows : withTensorFoldRows(given, tf.rows)), [tf, given, view])
  const headings = React.useMemo(() => (tf === undefined ? givenHeadings : { ...givenHeadings, ...tf.headings }), [tf, givenHeadings])
  const expandRowsRef = React.useRef(expandRows)
  expandRowsRef.current = expandRows
  const fullCache = React.useRef<{ listed: ModelChoice[]; rows: Map<string, ModelChoice[]> }>({ listed, rows: new Map() })
  if (fullCache.current.listed !== listed) fullCache.current = { listed, rows: new Map() }
  const fullRowsOf = (group: string): ModelChoice[] | undefined => {
    const cache = fullCache.current.rows
    if (!cache.has(group)) cache.set(group, expandRowsRef.current?.(group) ?? [])
    return cache.get(group)
  }
  const seatGroup = (candidates: readonly PickerGroup<ModelChoice>[]): string | undefined =>
    candidates.find(group => TENSORFOLD_GROUPS.includes(group.group) && group.rows.some(row => row.id === currentRow && row.action !== true))?.group
  const groups = React.useMemo(() => {
    const grouped = groupPickerRows(listed)
    if (tf === undefined) return grouped
    const seat = seatGroup(grouped)
    const lead = seat ?? topGroup
    return placeTensorFoldGroups(grouped, { ...(lead !== undefined ? { top: lead } : {}), ...(recentAt !== undefined ? { recentAt } : {}), first: tensorFoldFirst && seat === undefined })
  }, [listed, tf, currentRow, topGroup, recentAt, tensorFoldFirst])
  const top = seatGroup(groups) ?? topGroup ?? groups[0]?.group
  const keyOfId = (id: string): string | undefined => {
    const own = listed.find(m => m.id === id && isModelRow(m))
    if (own !== undefined) return rowKey(own)
    for (const group of groups) {
      if (group.door === undefined) continue
      const deep = fullRowsOf(group.group)?.find(m => m.id === id)
      if (deep !== undefined) return rowKey(deep)
    }
    return undefined
  }
  const currentKey = keyOfId(currentRow)
  const pendingKey = pendingNext === undefined ? undefined : keyOfId(pendingNext)
  const [folds, setFolds] = useState<Record<string, FoldState>>(() => {
    const initial = initialPickerFolds(groups, top, currentKey, tensorfold === undefined ? [] : tensorFoldFoldedOnOpen(tensorfold, view))
    for (const group of groups) {
      if (group.door === undefined || group.rows.some(m => rowKey(m) === currentKey)) continue
      if (fullRowsOf(group.group)?.some(m => rowKey(m) === currentKey)) initial[group.group] = 'full'
    }
    if (view === 'tensorfold' && initial[TENSORFOLD_MODEL_GROUP] !== 'folded') initial[TENSORFOLD_MODEL_GROUP] = 'full'
    return initial
  })
  const [filter, setFilter] = useState(initialFilter ?? '')
  const [filterFocus, setFilterFocus] = useState((initialFilter ?? '') !== '')
  const filtering = filter.trim() !== ''
  const lines = React.useMemo(
    () => composePickerLines(groups, folds, filter, fullRowsOf),
    [groups, folds, filter, listed],
  )
  const { columns: cols, rows: termRows } = useTerminalSize()
  const slot = useModalOrTerminalSize({ rows: termRows, columns: cols })
  const popup = React.useContext(PopupFrameContext)
  const panelWidth = Math.min(popup?.width ?? slot.columns, panelWidthFor(slot.columns, MODEL_PICKER_PANEL))
  const inner = panelWidth - 4
  const columns = pickerColumns(inner - 4)
  const narrowId = columns.id < 20
  if (slot.rows < 20 && narrowId) columns.id = Math.max(0, columns.id - 1)
  const totalLines = lines.length
  const availRows = slot.rows
  const compact = availRows < 20
  const shedMeters = availRows < 13
  const landing = ((): number => {
    const at = currentKey === undefined ? -1 : lines.findIndex(line => line.kind === 'row' && line.key === currentKey)
    if (at >= 0) return at
    const served = view === 'tensorfold' ? lines.findIndex(line => line.kind === 'row' && line.row.tensorfold !== undefined && line.row.action !== true) : -1
    if (served >= 0) return served
    const first = firstRowIndex(lines)
    return first >= 0 ? first : Math.max(0, lines.findIndex(line => isCursorStop(line)))
  })()
  const [cursor, setI] = useState(landing)
  const [lineSnapshot, setLineSnapshot] = useState({ listed, lines })
  const [ctxNotice, setCtxNotice] = useState<string | null>(null)
  let i = Math.min(cursor, Math.max(0, totalLines - 1))
  if (!isCursorStop(lines[i])) i = nextStop(lines, i, 1) !== i ? nextStop(lines, i, 1) : nextStop(lines, i, -1)
  if (lineSnapshot.lines !== lines) {
    if (lineSnapshot.listed !== listed) {
      const prior = lineSnapshot.lines[Math.min(cursor, Math.max(0, lineSnapshot.lines.length - 1))]
      const priorKey = prior?.kind === 'row' ? prior.key : prior?.kind === 'heading' || prior?.kind === 'more' ? `${prior.kind}:${prior.group}` : undefined
      const moved = lines.findIndex(line => (line.kind === 'row' ? line.key : line.kind === 'heading' || line.kind === 'more' ? `${line.kind}:${line.group}` : '') === priorKey)
      if (filtering && (prior?.kind !== 'row' || moved < 0)) {
        const first = firstRowIndex(lines)
        if (first >= 0) i = first
      } else if (moved >= 0) i = moved
      if (i !== cursor) setI(i)
      const after = lines[i]
      if (ctxNotice !== null && prior?.kind === 'row' && prior.row.pending === true && (after?.kind !== 'row' || after.row.pending !== true)) setCtxNotice(null)
    }
    setLineSnapshot({ listed, lines })
  }
  const touched = React.useRef(false)
  const [tfSeat, setTfSeat] = useState(() => seatGroup(groups))
  const seatNow = seatGroup(groups)
  if (seatNow !== undefined && seatNow !== tfSeat) {
    setTfSeat(seatNow)
    if (!touched.current) {
      const nextFolds = { ...folds, ...initialPickerFolds(groups.filter(group => group.group === seatNow), seatNow, currentKey) }
      setFolds(nextFolds)
      const at = composePickerLines(groups, nextFolds, filter, fullRowsOf).findIndex(line => line.kind === 'row' && line.key === currentKey)
      if (at >= 0) setI(at)
    }
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
  const { focusedGptWindow, focusedGptToggle } = focusedGptFacts(focusedModel)
  const [windowTyping, setWindowTyping] = useState<string | null>(null)
  const [, setWindowStamp] = useState(0)
  const focusedTf = focusedModel?.tensorfold
  const focusedLocal = focusedModel !== undefined && focusedTf === undefined && isModelRow(focusedModel) && isLocalModelId(focusedModel.id) ? localRecordFor(focusedModel.id) : undefined
  const focusedLocalCycles = focusedLocal !== undefined && (localWindowApplication(focusedLocal) === 'request' || localWindowApplication(focusedLocal) === 'load')
  useSyncExternalStore(subscribeLocalServerTruth, localServerTruthStamp, localServerTruthStamp)
  const focusedLocalKey = focusedLocal !== undefined ? `${focusedLocal.server}/${focusedLocal.id}` : null
  useLoad(() => {
    if (focusedLocal === undefined || !focusedLocalCycles || focusedLocal.geometry === undefined) return
    void refreshLocalMachineTruth(focusedLocal.server).catch(passedOverAs(undefined))
  }, [focusedLocalKey])
  const panelView = view === 'tensorfold'
  const localOffer = !panelView && !filtering && headings?.[LOCAL_MODEL_GROUP]?.reason !== undefined && !groups.some(group => group.group === LOCAL_MODEL_GROUP)
  const focusedNative1m = ((): boolean => {
    const p = focusedModel?.id
    if (!p || focusedSupports1m || focusedGptWindow) return false
    try {
      return getContextWindowForModel(parseUserSpecifiedModel(stripContext1m(p))) >= 1_000_000
    } catch (error) {
      passedOver(error)
      return false
    }
  })()
  const { selectRow, setFilterText, setFold } = pickerCursor({ setI, setCtxNotice, setWindowTyping, setTfTyping, setTfConfirm, lines, setContext1m, ctxStateOf, groups, folds, setFolds, fullRowsOf, setFilter, focusedModel, currentKey, filter })
  const { stepWindow, groupHidden, commitCurrent } = pickerActs({ setTfWindows, setTfConfirm, setTfTyping, onSelect, onTensorFold, lines, i, filtering, setFold, setCtxNotice, context1m, focusedGptToggle })
  const pastOpenEvent = useOpenEventGate()
  const overlayToken = useRegisterOverlay('model-picker', true)
  useInput((input, key, event) => {
    touched.current = true
    const rowAxis = decodeNavKey(input, key, { orientation: 'vertical', hierarchy: true, tabFocus: true })
    const keys: PickerKeys = { rowAxis, tfTyping, setTfTyping, listed, onTensorFold, tfConfirm, setTfConfirm, focusedTf, filtering, stepWindow, filterFocus, pastOpenEvent, windowTyping, setWindowTyping, focusedLocal, setWindowStamp, overlayToken, filter, setFilterText, onClose, setFilterFocus, selectRow, lines, i, commitCurrent, setFold, folds, groupHidden, focusedSupports1m, setContext1m, focusedGptWindow, context1m, setCtxNotice, focusedNative1m, focusedLocalCycles, focusedModel, focusedHeading, hasEffort, onEffort, efforts, ei }
    if (tensorFoldKeys(input, key, event, keys)) return
    if (windowTypingKeys(input, key, event, keys)) return
    if (navigationKeys(event, keys)) return
    if (chordKeys(input, key, event, keys)) return
    filterKeys(input, key, event, keys)
  })
  const { cardWidth, reasonLines, pendingLine, localWindowLine, noticeInk, noticeLines, liveLine, shedPageHint, shedEffort, paintBudget, markersOn, headingAbove, windowPaint, win } = pickerGeometry({ inner, lines, compact, i, panelWidth, focusedModel, listed, currentRow, current, pendingNext, focusedLocal, windowTyping, tokens, ctxNotice, notice, panelView, live, shedMeters, hasEffort, efforts, effort, availRows, localOffer, totalLines })
  usePopupListPaging(i, totalLines, win.end - win.start, target => selectRow(isCursorStop(lines[target]) ? target : nextStop(lines, target, target > i ? 1 : -1)), windowTyping === null)
  const pinnedHeading = headingAbove(win)
  const slack = win.above > 0 || win.below > 0 ? Math.max(0, paintBudget - windowPaint(win)) : 0
  const totalModels = filtering ? pickerReachTotal(groups, fullRowsOf) : 0
  const matched = lines.reduce((sum, line) => sum + (line.kind === 'heading' ? (line.matched ?? 0) : 0), 0)
  const stateWordOf = (m: ModelChoice, key: string): [string, string] =>
    key === currentKey ? [MODEL_PICKER_CURRENT, TEAL] : pendingKey !== undefined && key === pendingKey ? ['next', AMBER] : m.gated ? [MODEL_PICKER_UNAVAILABLE, SAND] : ['', FAINT]
  const footerKeys = ((): ModelPickerFooterKeys | undefined => {
    if (focusedTf === undefined) return undefined
    const keys = focusedTf.keys
    const action = keys.enter?.words ?? (keys.limit !== undefined ? 'w raise the limit' : keys.stop?.words)
    return {
      ...(action !== undefined ? { action } : {}),
      window: keys.window !== undefined,
      ...(keys.stop !== undefined && action !== keys.stop.words ? { stop: keys.stop.words } : {}),
      ...(keys.share !== undefined ? { share: keys.share.words } : {}),
      ...(keys.terminate !== undefined ? { terminate: keys.terminate.words } : {}),
      support: keys.support !== undefined,
      ...(keys.legend !== undefined ? { legend: keys.legend } : {}),
    }
  })()
  const footer = modelPickerFooter(
    {
      gated: !!focusedModel?.gated,
      ...(focusedModel?.pending ? { pending: true } : {}),
      ...(focusedModel?.enableFlag !== undefined ? { enableFlag: focusedModel.enableFlag } : {}),
      ...(focusedHeading !== undefined ? { heading: { fold: focusedHeading.fold === 'folded' ? 'folded' : 'open' } } : {}),
      ...(focusedLine?.kind === 'more' ? { more: true } : {}),
      filterFocus,
      filtering,
      ...(footerKeys !== undefined ? { keys: footerKeys } : {}),
    },
    inner,
  )
  const renderLine = pickerLineRenderer({ i, headings, inner, selectRow, commitCurrent, TERRA, tokens, compact, narrowId, cardWidth, stateWordOf, focusedSupports1m, focusedGptToggle, context1m, columns, listed: lines.flatMap(line => (line.kind === 'row' ? [line.row.id] : [])) })
  return (
    <Box flexDirection="column" alignItems={modelPickerCentred() ? 'center' : 'flex-start'}>
    <Box ref={surfaceRef} flexDirection="column" borderStyle="round" borderColor={tokens.borderStrong} paddingX={1} width={panelWidth} flexShrink={0}>
      {panelView
        ? <ProductLockup view="tensorfold" separator=" · " plain {...(filtering ? { subtitle: matchWords(matched, totalModels) } : {})} />
        : <ProductLockup view="model" separator=" · " plain {...(filtering ? { subtitle: matchWords(matched, totalModels) } : {})} />}
      <MenuFilterLine focused={filterFocus} text={truncateStartToWidth(filter, inner - 2)} placeholder={filterFocus ? MODEL_PICKER_SEARCH_PLACEHOLDER : MODEL_PICKER_FILTER_PLACEHOLDER} accent={TERRA} muted={FAINT} primary={IVORY} id="model:filter" onFocus={() => setFilterFocus(true)} />
      {compact ? null : <Box height={1} />}
      {pendingLine !== null ? (
        <Text>
          {pendingLine.map((part, k) => (
            <Text key={k} color={part.color}>{part.text}</Text>
          ))}
        </Text>
      ) : null}
      {markersOn && win.above > 0 ? <Text color={FAINT}>  ↑ {win.above} more</Text> : null}
      {pinnedHeading >= 0 ? renderLine(lines[pinnedHeading]!, pinnedHeading) : null}
      {lines.map((line, idx) => (idx < win.start || idx >= win.end ? null : renderLine(line, idx)))}
      {slack > 0 ? <Box height={slack} flexShrink={0} /> : null}
      {markersOn && win.below > 0 ? <Text color={FAINT}>  ↓ {win.below} more</Text> : null}
      {localOffer ? <Text wrap="truncate-end"><Text color={FAINT}>{FOLD_OPEN_LEAD}</Text><Text bold color={tokens.info}>{headings?.[LOCAL_MODEL_GROUP]?.name ?? providerNameOfGroup(LOCAL_MODEL_GROUP)}</Text><Text color={FAINT}>{` · ${LOCAL_SETUP_PICKER_OFFER}`}</Text></Text> : null}
      {compact ? null : <Box height={1} />}
      {liveLine ? <Text color={FAINT} wrap="truncate-end">{live}</Text> : null}
      {shedMeters || panelView ? null : <Box>
        <Text wrap="truncate-end"><Text color={FAINT}>context </Text>{ctxPct === null ? <Text color={FAINT}>—</Text> : <><Text color={gaugeColor(ctxPct)}>{bar(ctxPct, 12)}</Text><Text color={SAND}> {ctxPct}%</Text></>}</Text>
      </Box>}
      {hasEffort && !shedEffort && !panelView ? (
        compact ? (
          <Text wrap="truncate-end">
            <Text color={FAINT}>effort  </Text>
            <Text bold color={TERRA}>[{effort}]</Text>
            <Text color={FAINT}> {MODEL_PICKER_EFFORT_WORDS}</Text>
          </Text>
        ) : (
          <Text wrap="truncate-end">
            <EffortStrip levels={efforts!} current={effort} accent={TERRA} faint={FAINT} />
            <Text color={FAINT}>· {MODEL_PICKER_EFFORT_WORDS}</Text>
          </Text>
        )
      ) : null}
      {noticeLines.map((line, k) => {
        const refusal = localWindowLine !== null && ctxNotice === null && reasonLines === null ? localWindowRefusalSpan(line) : undefined
        return (
          <Text key={k} color={reasonLines !== null && ctxNotice === null ? FAINT : tokens.info} wrap="truncate-end">
            {refusal === undefined ? line : <>{line.slice(0, refusal.start)}<Text color={noticeInk}>{line.slice(refusal.start, refusal.end)}</Text>{line.slice(refusal.end)}</>}
          </Text>
        )
      })}
      <Text color={FAINT} wrap="truncate-end">{hint ?? footer}</Text>
      {shedPageHint || hint !== undefined ? null : <Text color={FAINT} wrap="truncate-end">pgup/pgdn page</Text>}
    </Box>
    </Box>
  )
}
