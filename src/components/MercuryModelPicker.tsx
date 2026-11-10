import figures from 'figures'
import * as React from 'react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { isTopOverlayNow, useRegisterOverlay } from '../context/overlayContext.js'
import { Box, Text, useInput, wrapText } from '../ink.js'
import { usePopupListPaging } from './CustomSelect/popup-list.js'
import { escapeFromOutsidePress } from '../ink/recessLayer.js'
import { fitMeasuredWindow, paneWindow, panelWidth as panelWidthFor, type PaneWindow } from './mercury-ui/geometry.js'
import { useModalOrTerminalSize } from '../context/modalContext.js'
import { PopupFrameContext } from './PopupGutter.js'
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
import { GLYPH, padTo, truncateToWidth } from './mercury-ui/glyphs.js'
import { truncateStartToWidth } from '../utils/truncate.js'
import { InteractiveRow } from './mercury-ui/InteractiveRow.js'
import { EffortStrip, effortStripText } from './mercury-ui/EffortStrip.js'
import { gaugeColor } from './mercury-ui/theme.js'
import { modelPickerFooter } from '../utils/model/modelPickerFooter.js'
import type { ModelPickerFooterKeys } from '../utils/model/modelPickerFooter.js'
import { wrapPlain } from './BootHealthScreen.js'
import { FOLD_CLOSED_LEAD, FOLD_OPEN_LEAD, MenuFilterLine } from './mercury-ui/menuFold.js'
import {
  MODEL_PICKER_CONTEXT_CHORD,
  MODEL_PICKER_CONTEXT_CHORD_KEY,
  MODEL_PICKER_CURRENT,
  MODEL_PICKER_EFFORT_CHORD_KEY,
  MODEL_PICKER_EFFORT_WORDS,
  MODEL_PICKER_FILTER_PLACEHOLDER,
  MODEL_PICKER_SEARCH_PLACEHOLDER,
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
  isCuratedGroup,
  isCursorStop,
  isModelRow,
  isSearchCharacter,
  lastStop,
  matchWords,
  moreLineWords,
  nextStop,
  orderPickerGroups,
  pickerCellColumns,
  pickerColumns,
  pickerReachTotal,
  providerNameOfGroup,
  rowKey,
  type CatalogueDoorFacet,
  type FoldState,
  type PickerGroup,
  type PickerLine,
  type ProviderHeading,
} from '../utils/model/modelPickerGroups.js'
import {
  TENSORFOLD_GROUPS,
  TENSORFOLD_HOST_GROUP,
  TENSORFOLD_MODEL_GROUP,
  tensorFoldFoldedOnOpen,
  tensorFoldPickerRows,
  type TensorFoldAct,
  type TensorFoldChoice,
  type TensorFoldPickerFacts,
  type TensorFoldTyping,
} from './tensorfold/tensorfoldRows.js'
import { TensorFoldCard, tensorFoldInk } from './tensorfold/TensorFoldCard.js'
import { isLocalModelId, LOCAL_MODEL_GROUP, localPickerWindowNotice, localRecordFor } from '../services/providers/local/localCatalogue.js'
import { LOCAL_SETUP_PICKER_OFFER } from '../commands/localsetup/words.js'
import { LOCAL_WINDOW_CHOICES, localWindowApplication, localWindowChoiceLine, localWindowNoticeKind, localWindowRefusalSpan, localWindowSettingOf, nextLocalWindowSetting, parseLocalWindowSetting, writeLocalWindowSetting } from '../services/providers/local/localWindow.js'
import { localServerTruthStamp, refreshLocalMachineTruth, subscribeLocalServerTruth } from '../services/localServer/localServerTruth.js'
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
    return getInitialSettings().view?.modelPicker?.centred !== false
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
  searchableAction?: boolean
  expand?: CatalogueDoorFacet
  choice?: string
  rest?: boolean
  key?: string
  tensorfold?: TensorFoldChoice
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

const cell = (text: string, width: number): string => (width <= 2 ? '' : `${padTo(text, width - 2)}  `)
const idCell = (id: string, width: number, narrow: boolean): string => cell(narrow ? truncateStartToWidth(id, Math.max(0, width - 2)) : id, width)

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
  React.useEffect(() => {
    markTransitionEnd('picker-open')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const TERRA = useSessionAccent().accent
  const tokens = useMercuryTokens()
  const currentRow = stripGptServedWindowSuffix(current)
  const [tfWindows, setTfWindows] = useState<Record<string, number>>({})
  const [tfTyping, setTfTyping] = useState<TensorFoldTyping | null>(null)
  const [tfConfirm, setTfConfirm] = useState<string | null>(null)
  const tf = React.useMemo(
    () => (tensorfold === undefined ? undefined : tensorFoldPickerRows(tensorfold, { view, current: currentRow, windows: tfWindows, ...(tfTyping !== null ? { typing: tfTyping } : {}), ...(tfConfirm !== null ? { confirmStop: tfConfirm } : {}) })),
    [tensorfold, view, currentRow, tfWindows, tfTyping, tfConfirm],
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const [windowTyping, setWindowTyping] = useState<string | null>(null)
  const [, setWindowStamp] = useState(0)
  const focusedTf = focusedModel?.tensorfold
  const focusedLocal = focusedModel !== undefined && focusedTf === undefined && isModelRow(focusedModel) && isLocalModelId(focusedModel.id) ? localRecordFor(focusedModel.id) : undefined
  const focusedLocalCycles = focusedLocal !== undefined && (localWindowApplication(focusedLocal) === 'request' || localWindowApplication(focusedLocal) === 'load')
  useSyncExternalStore(subscribeLocalServerTruth, localServerTruthStamp, localServerTruthStamp)
  const focusedLocalKey = focusedLocal !== undefined ? `${focusedLocal.server}/${focusedLocal.id}` : null
  useEffect(() => {
    if (focusedLocal === undefined || !focusedLocalCycles || focusedLocal.geometry === undefined) return
    void refreshLocalMachineTruth(focusedLocal.server).catch(() => undefined)
  }, [focusedLocalKey])
  const panelView = view === 'tensorfold'
  const localOffer = !panelView && !filtering && headings?.[LOCAL_MODEL_GROUP]?.reason !== undefined && !groups.some(group => group.group === LOCAL_MODEL_GROUP)
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
    setWindowTyping(null)
    setTfTyping(null)
    setTfConfirm(null)
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
    setWindowTyping(null)
    setTfTyping(null)
    setTfConfirm(null)
    const line = next[at]
    if (line?.kind === 'row') setContext1m(ctxStateOf(line.row.id))
  }
  const setFilterText = (text: string): void => {
    const next = composePickerLines(groups, folds, text, fullRowsOf)
    setFilter(text)
    const keep = focusedModel !== undefined ? rowKey(focusedModel) : undefined
    landOn(next, text.trim() === '' ? (keep ?? currentKey) : keep)
  }
  const setFold = (group: string, fold: FoldState, keep?: string, reveal = false): void => {
    const nextFolds = { ...folds, [group]: fold }
    const next = composePickerLines(groups, nextFolds, filter, fullRowsOf)
    setFolds(nextFolds)
    const own = groups.find(candidate => candidate.group === group)
    const revealed = keep === undefined && fold !== 'folded' && own !== undefined && (reveal || isCuratedGroup(own))
      ? next.find(line => line.kind === 'row' && line.row.group === group && !lines.some(seen => seen.kind === 'row' && seen.key === line.key))
      : undefined
    landOn(next, revealed?.kind === 'row' ? revealed.key : keep, group)
  }
  const stepWindow = (window: { rungs: readonly number[]; at: number; repo: string }, step: 1 | -1): void => {
    const at = window.rungs.indexOf(window.at)
    const next = window.rungs[Math.max(0, Math.min(window.rungs.length - 1, (at < 0 ? 0 : at) + step))]
    if (next === undefined || next === window.at) return
    setTfWindows(prev => ({ ...prev, [window.repo]: next }))
    setTfConfirm(null)
  }
  const tensorFoldEnter = (m: ModelChoice): void => {
    const enter = m.tensorfold?.keys.enter
    if (enter === undefined) return
    if (enter.input !== undefined) {
      setTfTyping({ key: rowKey(m), input: enter.input, text: '' })
      return
    }
    if (enter.act?.kind === 'switch') onSelect?.(enter.act.id)
    else if (enter.act !== undefined) onTensorFold?.(enter.act)
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
    if (line.kind === 'more') {
      setFold(line.group, 'full', undefined, true)
      return
    }
    if (line.kind !== 'row') return
    const m = line.row
    if (m.tensorfold !== undefined) {
      tensorFoldEnter(m)
      return
    }
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
    touched.current = true
    const rowAxis = decodeNavKey(input, key, { orientation: 'vertical', hierarchy: true, tabFocus: true })
    if (tfTyping !== null) {
      event.stopImmediatePropagation()
      if (rowAxis === 'cancel') {
        setTfTyping(null)
        return
      }
      if (rowAxis === 'activate') {
        const text = tfTyping.text.trim()
        const typed = listed.find(m => rowKey(m) === tfTyping.key)?.tensorfold?.keys.typed
        setTfTyping(null)
        if (text !== '' && typed !== undefined) onTensorFold?.(typed(text))
        return
      }
      if (key.backspace || key.delete) {
        setTfTyping(typing => (typing === null ? typing : { ...typing, text: typing.text.slice(0, -1) }))
        return
      }
      if (tfTyping.input === 'code' ? !key.ctrl && !key.meta && /^\d+$/.test(input) : isSearchCharacter(input, key)) setTfTyping(typing => (typing === null ? typing : { ...typing, text: typing.input === 'code' ? (typing.text + input).slice(0, 6) : typing.text + input }))
      return
    }
    if (rowAxis === 'cancel' && tfConfirm !== null) {
      event.stopImmediatePropagation()
      setTfConfirm(null)
      return
    }
    const tfKeys = focusedTf?.keys
    if ((rowAxis === 'enterChild' || rowAxis === 'leaveChild') && !filtering && tfKeys?.window !== undefined) {
      event.stopImmediatePropagation()
      stepWindow(tfKeys.window, rowAxis === 'enterChild' ? 1 : -1)
      return
    }
    if (key.ctrl && !key.meta && input === MODEL_PICKER_CONTEXT_CHORD_KEY && focusedTf !== undefined) {
      event.stopImmediatePropagation()
      if (tfKeys?.window !== undefined) stepWindow(tfKeys.window, 1)
      return
    }
    if (!filterFocus && !key.ctrl && !key.meta && tfKeys !== undefined && ((input === 's' && tfKeys.stop !== undefined) || (input === 't' && tfKeys.terminate !== undefined) || (input === 'w' && tfKeys.limit !== undefined) || (input === 'c' && !key.ctrl && tfKeys.support !== undefined) || (input === 'n' && tfKeys.share !== undefined))) {
      event.stopImmediatePropagation()
      if (!pastOpenEvent()) return
      if (input === 's' && tfKeys.stop !== undefined) {
        const repo = tfKeys.stop.act.kind === 'stop' ? tfKeys.stop.act.row.repo : undefined
        if (tfKeys.stop.confirm && repo !== undefined && tfConfirm !== repo) {
          setTfConfirm(repo)
          return
        }
        setTfConfirm(null)
        onTensorFold?.(tfKeys.stop.act)
        return
      }
      const act = input === 'w' ? tfKeys.limit : input === 'n' ? tfKeys.share?.act : input === 't' ? tfKeys.terminate?.act : tfKeys.support
      if (act !== undefined) onTensorFold?.(act)
      return
    }
    if (windowTyping !== null) {
      event.stopImmediatePropagation()
      if (rowAxis === 'cancel') {
        setWindowTyping(null)
        return
      }
      if (rowAxis === 'activate') {
        const parsed = parseLocalWindowSetting(windowTyping)
        if (parsed !== undefined && focusedLocal !== undefined) {
          writeLocalWindowSetting(focusedLocal, parsed)
          setWindowStamp(s => s + 1)
        }
        setWindowTyping(null)
        return
      }
      if (key.backspace || key.delete) {
        setWindowTyping(t => (t ?? '').slice(0, -1))
        return
      }
      if (/^[0-9kK]$/.test(input) && !key.ctrl && !key.meta) setWindowTyping(t => `${t ?? ''}${input.toLowerCase()}`)
      return
    }
    if (rowAxis === 'cancel') {
      if (overlayToken !== null && !isTopOverlayNow(overlayToken)) return
      event.stopImmediatePropagation()
      if (filter !== '' && !escapeFromOutsidePress()) {
        setFilterText('')
        return
      }
      onClose?.()
      return
    }
    if (rowAxis === 'focusNext' || rowAxis === 'focusPrevious') {
      event.stopImmediatePropagation()
      if (!pastOpenEvent()) return
      setFilterFocus(!filterFocus)
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
      if (line?.kind === 'more') {
        setFold(line.group, rowAxis === 'enterChild' ? 'full' : 'folded', undefined, true)
        return
      }
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
    const chord = key.ctrl && !key.meta ? input : ''
    if (chord === MODEL_PICKER_CONTEXT_CHORD_KEY && focusedSupports1m) {
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      setContext1m(v => !v)
      return
    }
    if (chord === MODEL_PICKER_CONTEXT_CHORD_KEY && focusedGptWindow && focusedGptWindow.ceiling !== undefined) {
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      const big = !context1m
      setContext1m(big)
      setCtxNotice(
        big
          ? `${fmtCtx(focusedGptWindow.ceiling)} ctx active · default ${fmtCtx(focusedGptWindow.served)} · ${MODEL_PICKER_CONTEXT_CHORD} toggles`
          : `${fmtCtx(focusedGptWindow.served)} ctx active · max ${fmtCtx(focusedGptWindow.ceiling)} · ${MODEL_PICKER_CONTEXT_CHORD} toggles`,
      )
      return
    }
    if (chord === MODEL_PICKER_CONTEXT_CHORD_KEY && focusedGptWindow) {
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      setCtxNotice(`${fmtCtx(focusedGptWindow.served)} ctx · no alternate window`)
      return
    }
    if (chord === MODEL_PICKER_CONTEXT_CHORD_KEY && focusedNative1m) {
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      setCtxNotice('1M ctx · no alternate window')
      return
    }
    if (chord === MODEL_PICKER_CONTEXT_CHORD_KEY && focusedLocal !== undefined && focusedLocalCycles) {
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      setCtxNotice(null)
      const current = localWindowSettingOf(focusedLocal)
      if (current === 'max') {
        setWindowTyping('')
        return
      }
      const next = typeof current === 'number' && !LOCAL_WINDOW_CHOICES.includes(current) ? undefined : nextLocalWindowSetting(current, 1)
      writeLocalWindowSetting(focusedLocal, next)
      setWindowStamp(s => s + 1)
      return
    }
    if (chord === MODEL_PICKER_CONTEXT_CHORD_KEY && focusedModel !== undefined && isModelRow(focusedModel) && isLocalModelId(focusedModel.id)) {
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      setCtxNotice(localPickerWindowNotice(focusedModel.id))
      return
    }
    if (chord === MODEL_PICKER_CONTEXT_CHORD_KEY && focusedModel !== undefined && isModelRow(focusedModel)) {
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      setCtxNotice(focusedModel.ctx !== '' ? `${focusedModel.ctx} · stated by the provider · not a toggle` : 'context window unknown · the provider states none · not a toggle')
      return
    }
    if (chord === MODEL_PICKER_CONTEXT_CHORD_KEY && focusedModel !== undefined) {
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      setCtxNotice(focusedModel.choice ?? `${focusedModel.name} · not a model · no context window`)
      return
    }
    if (chord === MODEL_PICKER_CONTEXT_CHORD_KEY && focusedHeading !== undefined) {
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      setCtxNotice('no context window on a provider heading · ↓ reaches its rows')
      return
    }
    if (chord === MODEL_PICKER_EFFORT_CHORD_KEY && hasEffort) {
      if (!pastOpenEvent()) return
      event.stopImmediatePropagation()
      onEffort?.(efforts![(ei + 1) % efforts!.length]!)
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
    if (isSearchCharacter(input, key)) {
      event.stopImmediatePropagation()
      if (!pastOpenEvent()) return
      setFilterFocus(true)
      setFilterText(filter + input)
    }
  })
  const cardWidth = inner - 4
  const linePaint = (idx: number): number => {
    const line = lines[idx]
    if (!line) return 0
    if (line.kind !== 'row') return 1
    if (compact || idx !== i) return 1
    if (line.row.tensorfold !== undefined) return 3 + line.row.tensorfold.card(cardWidth).length
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
        { text: ' · ', color: FAINT },
        { text: `${GLYPH.pending} next `, color: AMBER },
        { text: listed.find(m => m.id === pendingNext)?.name ?? pendingNext, color: AMBER },
        { text: ' · applies when the turn settles', color: FAINT },
      ]
    : null
  const localWindowLine = focusedLocal !== undefined ? localWindowChoiceLine(focusedLocal, { wide: inner >= 90, ...(windowTyping !== null ? { typing: windowTyping } : {}) }) : null
  const noticeInk = localWindowLine !== null && localWindowNoticeKind(localWindowLine) === 'warning' ? tokens.warning : tokens.failureText
  const noticeLines: string[] = compact
    ? []
    : ctxNotice
      ? wrapPlain(ctxNotice, inner)
      : reasonLines !== null
        ? reasonLines
        : [...(localWindowLine !== null ? wrapPlain(localWindowLine, inner) : []), ...(notice ? wrapPlain(notice, inner) : [])]
  const liveLine = panelView && live !== undefined && live !== ''
  const chromeBase =
    2 + 1 + (compact ? 0 : 2) + (panelView ? (liveLine ? 1 : 0) : shedMeters ? 0 : 1) + 2 +
    (pendingLine !== null ? painted(pendingLine.map(part => part.text).join('')) : 0) +
    noticeLines.length + (localOffer ? 1 : 0)
  const effortPaint = hasEffort && !panelView ? (compact ? 1 : painted(effortStripText(efforts!, effort))) : 0
  const shedPageHint = panelView || (compact && availRows - chromeBase - 1 - effortPaint < 4)
  const chromePaint = chromeBase + (shedPageHint ? 0 : 1)
  const shedEffort = compact && effortPaint > 0 && availRows - chromePaint - effortPaint < 4
  const room = availRows - chromePaint - (shedEffort ? 0 : effortPaint)
  const paintBudget = Math.max(1, room)
  const markersOn = room >= 3
  const pinnedOn = room >= 4
  const headingAbove = (w: PaneWindow): number => {
    if (!pinnedOn || w.above === 0) return -1
    const first = lines[w.start]
    if (first === undefined || first.kind === 'heading') return -1
    const at = headingIndexOf(lines, first.kind === 'row' ? first.row.group : first.group)
    return at >= 0 && at < w.start ? at : -1
  }
  const windowPaint = (w: PaneWindow): number => {
    let sum = (markersOn && w.above > 0 ? 1 : 0) + (markersOn && w.below > 0 ? 1 : 0) + (headingAbove(w) >= 0 ? 1 : 0)
    for (let idx = w.start; idx < w.end; idx++) sum += linePaint(idx)
    return sum
  }
  const win = fitMeasuredWindow(totalLines, paintBudget, span => paneWindow(totalLines, i, span), windowPaint)
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
      ...(focusedModel?.enableFlag !== undefined ? { enableFlag: focusedModel.enableFlag } : {}),
      ...(focusedHeading !== undefined ? { heading: { fold: focusedHeading.fold === 'folded' ? 'folded' : 'open' } } : {}),
      ...(focusedLine?.kind === 'more' ? { more: true } : {}),
      filterFocus,
      filtering,
      ...(footerKeys !== undefined ? { keys: footerKeys } : {}),
    },
    inner,
  )
  const renderLine = (line: PickerLine<ModelChoice>, idx: number): React.ReactNode => {
    if (line.kind === 'heading') {
      const on = idx === i
      const heading = headings?.[line.group]
      const words = headingWords(heading, line.group, { live: line.live, ...(line.matched !== undefined ? { matched: line.matched, total: line.total ?? 0 } : {}) }, inner - 2)
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
      const words = doorWords(door ?? { door: line.door }, { live: line.live, ...(line.matched !== undefined ? { matched: line.matched, total: line.total ?? 0 } : {}) }, inner - 2)
      return (
        <Box key={`door:${line.group}:${line.door}`} height={1}>
          <Text color={tokens.textSecondary} wrap="truncate-end">{`  ${words}`}</Text>
        </Box>
      )
    }
    if (line.kind === 'more') {
      const on = idx === i
      return (
        <InteractiveRow key={`more:${line.group}`} id={`model:more:${line.group}`} selected={on} onSelect={() => selectRow(idx)} onActivate={commitCurrent} width={inner} height={1} selectionBand={true}>
          <Text wrap="truncate-end">
            <Text color={on ? TERRA : FAINT}>{on ? `${GLYPH.prompt} ` : '  '}</Text>
            <Text color={FAINT}>{moreLineWords(line.hidden, line.reach)}</Text>
          </Text>
        </InteractiveRow>
      )
    }
    const m = line.row
    const on = idx === i
    if (m.tensorfold !== undefined) {
      const choice = m.tensorfold
      const cells = pickerCellColumns(inner - 4)
      if (compact && narrowId) cells.id = Math.max(0, cells.id - 1)
      const ink = (tone: Parameters<typeof tensorFoldInk>[0]): string => tensorFoldInk(tone, tokens, TERRA)
      return (
        <InteractiveRow key={line.key} id={`model:row:${line.key}`} selected={on} onSelect={() => selectRow(idx)} onActivate={commitCurrent} flexDirection="column" selectionBand={compact}>
          <Box borderStyle={on && !compact ? 'round' : undefined} borderColor={on && !compact ? TERRA : undefined} paddingLeft={on && !compact ? 1 : 2} paddingRight={1} flexDirection="column">
            <Text wrap="truncate-end">
              {compact ? <Text color={on ? TERRA : FAINT}>{on ? `${figures.pointer} ` : '  '}</Text> : null}
              {m.action === true ? (
                <>
                  <Text bold color={IVORY}>{m.name}</Text>
                  {choice.words !== undefined ? <Text color={FAINT}>{` — ${choice.words}`}</Text> : null}
                  {choice.state !== undefined ? <Text color={ink(choice.state.tone)}>{`  ${choice.state.text}`}</Text> : null}
                </>
              ) : (
                <>
                  <Text bold color={IVORY}>{cell(m.name, cells.alias)}</Text>
                  <Text color={FAINT}>{idCell(m.id, cells.id, narrowId)}</Text>
                  <Text color={ink(choice.state?.tone ?? 'faint')}>{cell(choice.state?.text ?? '', cells.state)}</Text>
                  <Text color={FAINT}>{cell(m.ctx, cells.ctx)}</Text>
                  <Text color={ink(choice.memory?.tone ?? 'faint')}>{truncateToWidth(choice.memory?.text ?? '', cells.tail)}</Text>
                </>
              )}
            </Text>
            {on && !compact ? <TensorFoldCard lines={choice.card(cardWidth)} tokens={tokens} accent={TERRA} /> : null}
          </Box>
        </InteractiveRow>
      )
    }
    const [stateWord, stateColor] = stateWordOf(m, line.key)
    const model = isModelRow(m)
    const alias = model ? (hasAlias(m) ? m.name : '—') : m.name
    const ctxText = on && (focusedSupports1m || focusedGptToggle) ? (context1m ? (m.ctx1m ?? m.ctx) : (m.ctxBase ?? m.ctx)) : m.ctx
    const tail = model && !hasAlias(m) ? truncateToWidth(MODEL_PICKER_NO_ALIAS, columns.tail) : ''
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
                <Text color={FAINT}>{idCell(m.id, columns.id, narrowId)}</Text>
              </>
            ) : (
              <Text bold color={m.gated ? SAND : IVORY}>{m.name}</Text>
            )}
            {model ? <>
              <Text color={stateColor}>{cell(stateWord, columns.state)}</Text>
              <Text color={FAINT}>{cell(ctxText, columns.ctx)}</Text>
              <Text color={tokens.info}>{tail}</Text>
            </> : null}
          </Text>
          {on && !compact && m.tag !== '' ? <Text color={SAND}>{m.tag}</Text> : null}
        </Box>
      </InteractiveRow>
    )
  }
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
        <Text wrap="truncate-end"><Text color={FAINT}>context </Text>{ctxPct === null ? <Text color={FAINT}>—</Text> : <><Text color={gaugeColor(ctxPct)}>{bar(ctxPct, 12)}</Text><Text color={SAND}> {ctxPct}%</Text></>}{((): React.ReactNode => {
          if (compact) return null
          const tier = activeSourceUsage().tier
          return tier ? <Text><Text color={FAINT}>  · tier </Text><Text color={IVORY}>{tier}</Text></Text> : null
        })()}</Text>
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
