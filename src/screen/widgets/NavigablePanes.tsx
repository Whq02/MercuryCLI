import * as React from 'react'
import { useRef } from 'react'
import { useLayoutPublish, usePublish } from '../effects/effects.js'
import { Box, Text, useInput, wrapText, type DOMElement } from '../themedRenderer.js'
import type { ScrollBoxHandle } from '../renderer/elements/ScrollBox.js'
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js'
import type { MercuryThemeTokens } from '../theme/mercuryTokens.js'
import { innerWidth as innerPaneWidth, viewportRows } from './geometry.js'
import { InteractiveRow } from './InteractiveRow.js'
import { CursorCell } from './LiveGlyphs.js'
import { useMercuryTokens } from './useMercuryTokens.js'
import { useNavigablePanes } from './useNavigablePanes.js'
import { panesBodyOf, panesFrameOf, type Layout, type NavigablePanesProps } from './navigable-panes/views.js'


export type ColumnDef<Row> = {
  key: string
  header: string
  width?: number
  align?: 'left' | 'right'
  cell: (row: Row) => React.ReactNode
}

export type RowAction<Row> = {
  key: string
  label: string
  hint?: string
  when: (row: Row) => boolean
  run: (row: Row) => void
}

export type SectionDef<Row> = {
  id: string
  label: string
  count?: number
  rows: Row[]
  emptyHint?: string
}

const COL_GAP = 2
const NAV_WIDTH = 22
const DETAIL_WIDTH_WIDE = 40
const DETAIL_WIDTH_MID = 34
const VIEWPORT_RESERVE = 11
const COMPOSER_SLOT_RESERVE = 2
const ROW_OVERSCAN = 12
const SELECTED_ROW_OFFSET = -2

function pickLayout(cols: number): Layout {
  if (cols >= 140) return 'wide'
  if (cols >= 120) return 'mid'
  if (cols >= 100) return 'fold'
  return 'inline'
}


function ColumnHeader<R>({
  columns,
  totalWidth,
  tokens,
}: {
  columns: ColumnDef<R>[]
  totalWidth: number
  tokens: MercuryThemeTokens
}): React.ReactNode {
  return (
    <Box width={totalWidth} columnGap={COL_GAP} flexShrink={0}>
      {columns.map(c => (
        <Box
          key={c.key}
          width={c.width}
          flexGrow={c.width ? 0 : 1}
          flexShrink={c.width ? 0 : 1}
          justifyContent={c.align === 'right' ? 'flex-end' : 'flex-start'}
          overflow="hidden"
        >
          <Text color={tokens.textMuted} wrap="truncate-end">
            {c.header}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

function PaneRow<R>({
  row,
  rowId,
  columns,
  selected,
  totalWidth,
  rowRef,
  onSelect,
  onActivate,
  tokens,
}: {
  row: R
  rowId: string
  columns: ColumnDef<R>[]
  selected: boolean
  totalWidth: number
  rowRef?: React.Ref<DOMElement>
  onSelect: () => void
  onActivate: () => void
  tokens: MercuryThemeTokens
}): React.ReactNode {
  return (
    <InteractiveRow
      id={rowId}
      selected={selected}
      onSelect={onSelect}
      onActivate={onActivate}
      rowRef={rowRef}
      width={totalWidth}
      height={1}
      flexShrink={0}
    >
      {}
      <Box width={2} flexShrink={0}>
        <CursorCell focused={selected} color={tokens.accent} />
      </Box>
      <Box flexGrow={1} columnGap={COL_GAP} overflow="hidden">
        {columns.map(c => (
          <Box
            key={c.key}
            width={c.width}
            flexGrow={c.width ? 0 : 1}
            flexShrink={c.width ? 0 : 1}
            justifyContent={c.align === 'right' ? 'flex-end' : 'flex-start'}
            height={1}
            overflow="hidden"
          >
            {c.cell(row)}
          </Box>
        ))}
      </Box>
    </InteractiveRow>
  )
}


function SectionNav<R>({
  sections,
  active,
  width,
  idBase,
  onSelectSection,
  tokens,
}: {
  sections: SectionDef<R>[]
  active: number
  width: number
  idBase: string
  onSelectSection: (i: number) => void
  tokens: MercuryThemeTokens
}): React.ReactNode {
  return (
    <Box flexDirection="column" width={width} flexShrink={0} marginRight={2}>
      <Box height={1} overflow="hidden">
        <Text color={tokens.textMuted}>sections</Text>
      </Box>
      {sections.map((s, i) => {
        const on = i === active
        const count = s.count ?? s.rows.length
        return (
          <InteractiveRow
            key={s.id}
            id={`${idBase}:sec:${s.id}`}
            selected={on}
            directActivate
            onActivate={() => onSelectSection(i)}
            height={1}
            width="100%"
          >
            <Text color={on ? tokens.accent : tokens.textMuted} wrap="truncate-end">
              {on ? '▸ ' : '  '}
              {i < 9 ? `${i + 1} ` : '  '}
              {s.label}
            </Text>
            <Text color={tokens.textMuted}> ({count})</Text>
          </InteractiveRow>
        )
      })}
    </Box>
  )
}

function TabStrip<R>({
  sections,
  active,
  idBase,
  onSelectSection,
  tokens,
}: {
  sections: SectionDef<R>[]
  active: number
  idBase: string
  onSelectSection: (i: number) => void
  tokens: MercuryThemeTokens
}): React.ReactNode {
  return (
    <Box columnGap={2} flexShrink={0} height={1} overflow="hidden">
      {sections.map((s, i) => {
        const on = i === active
        const count = s.count ?? s.rows.length
        return (
          <InteractiveRow
            key={s.id}
            id={`${idBase}:tab:${s.id}`}
            selected={on}
            directActivate
            onActivate={() => onSelectSection(i)}
            height={1}
          >
            <Text color={on ? tokens.accent : tokens.textMuted} bold={on}>
              {s.label} ({count})
            </Text>
          </InteractiveRow>
        )
      })}
    </Box>
  )
}


export function NavigablePanes<Row>({
  view,
  subtitle,
  headerLine,
  sections,
  columns,
  rowKey,
  renderDetail,
  onClose,
  footerHints,
  detailFooterHints,
  expandable = true,
  loading = false,
  emptyState,
  mouseTracking = true,
  onActivate,
  rowActions,
  initialRowKey,
  initialSectionId,
  onSectionChange,
  onRowChange,
  closeHint,
  maxContentWidth,
  headerRight,
  sideInfo,
  detailTitle,
  composerSlot,
  onTypeToCompose,
  regionChrome,
  inputActive = true,
  borderColor,
}: NavigablePanesProps<Row>): React.ReactNode {
  const { columns: cols, rows: termRows } = useTerminalSize()
  const layout = pickLayout(cols)
  const tokens = useMercuryTokens()
  const accent = tokens.accent
  const idBase = `np:${view}`

  const safeSections = sections.length > 0 ? sections : []
  const showNav = safeSections.length > 1

  const seed = ((): { section: number; sel: number } => {
    if (initialRowKey !== undefined) {
      for (let s = 0; s < safeSections.length; s++) {
        const i = (safeSections[s]?.rows ?? []).findIndex(r => rowKey(r) === initialRowKey)
        if (i >= 0) return { section: s, sel: i }
      }
    }
    if (initialSectionId !== undefined) {
      const s = safeSections.findIndex(sec => sec.id === initialSectionId)
      if (s >= 0) return { section: s, sel: 0 }
    }
    return { section: 0, sel: 0 }
  })()
  const sectionRef = useRef(seed.section)
  const liveSection = Math.min(sectionRef.current, Math.max(0, safeSections.length - 1))
  const liveRowCount = safeSections[liveSection]?.rows.length ?? 0
  const nav = useNavigablePanes({
    sectionCount: Math.max(1, safeSections.length),
    rowCount: liveRowCount,
    pageSize: () => listHeight,
    onClose,
    escOverride: () => {
      if (!composerSlot?.active) return false
      composerSlot.onEscape()
      return true
    },
    active: inputActive && !loading && !emptyState && safeSections.length > 0 && !composerSlot?.active,
    sectionIds: safeSections.map(s => s.id),
    expandable,
    initialSection: seed.section,
    initialSel: seed.sel,
    sectionRowKeys: safeSections.map(s => s.rows.map(rowKey)),
    onActivateRow: onActivate
      ? (sectionIdx, selIdx) => {
          const sec = safeSections[sectionIdx] ?? safeSections[0]
          const rows = sec?.rows ?? []
          const i = Math.min(selIdx, Math.max(0, rows.length - 1))
          const row = rows[i]
          if (row) onActivate(row)
        }
      : undefined,
  })
  sectionRef.current = nav.section

  const activeSectionId = safeSections[Math.min(nav.section, Math.max(0, safeSections.length - 1))]?.id
  const notifiedSectionIdRef = useRef(activeSectionId)
  const onSectionChangeRef = useRef(onSectionChange)
  onSectionChangeRef.current = onSectionChange
  usePublish(() => {
    if (activeSectionId === undefined || activeSectionId === notifiedSectionIdRef.current) return
    notifiedSectionIdRef.current = activeSectionId
    onSectionChangeRef.current?.(activeSectionId, sectionRef.current)
  }, [activeSectionId])

  const section = safeSections[nav.section] ?? safeSections[0]
  const sectionRows = section?.rows ?? []
  let sel = Math.min(nav.sel, Math.max(0, sectionRows.length - 1))
  const prevNavSelRef = useRef(nav.sel)
  const selKeyRef = useRef<string | null>(null)
  const selMoved = nav.sel !== prevNavSelRef.current
  if (!selMoved && selKeyRef.current !== null && sectionRows.length > 0) {
    const under = sectionRows[sel]
    if (!under || rowKey(under) !== selKeyRef.current) {
      const followed = sectionRows.findIndex(r => rowKey(r) === selKeyRef.current)
      if (followed >= 0) sel = followed
    }
  }
  prevNavSelRef.current = nav.sel
  const selectedRow = sectionRows[sel]
  selKeyRef.current = selectedRow ? rowKey(selectedRow) : null
  if (sel !== nav.sel) nav.selectRow(sel)
  const selectedKey = selKeyRef.current
  usePublish(() => onRowChange?.(selectedKey), [selectedKey])

  useInput(
    (input, key) => {
      if ((key as Record<string, boolean>).escape) return
      composerSlot?.onInput(input, key)
    },
    { isActive: !!composerSlot?.active },
  )

  useInput(
    (input, key) => {
      const k = key as Record<string, boolean>
      if (!input || k.escape || k.return || k.ctrl || k.meta || k.tab) return
      if (!selectedRow) return
      onTypeToCompose?.(selectedRow, input)
    },
    {
      isActive:
        !!onTypeToCompose && !composerSlot?.active && !loading && nav.level === 'detail',
    },
  )

  useInput(
    (input, key) => {
      const k = key as Record<string, boolean>
      if (k.ctrl || k.meta) return
      if (!nav.pastBuffer() || !selectedRow || !rowActions) return
      for (const a of rowActions) {
        if (a.key.length === 1 && input === a.key && a.when(selectedRow)) {
          a.run(selectedRow)
          return
        }
      }
    },
    {
      isActive:
        inputActive &&
        !loading &&
        !emptyState &&
        safeSections.length > 0 &&
        !composerSlot?.active &&
        !!rowActions &&
        rowActions.length > 0 &&
        nav.level !== 'detail',
    },
  )

  const scrollRef = useRef<ScrollBoxHandle>(null)
  useLayoutPublish(() => {
    if (nav.rowRef.current && scrollRef.current) {
      scrollRef.current.scrollToElement(nav.rowRef.current, SELECTED_ROW_OFFSET)
    }
  }, [sel, nav.section, nav.rowRef])
  const listMounted = !loading && !emptyState && sectionRows.length > 0
  const subscribeScroll = React.useCallback(
    (onStoreChange: () => void) => {
      const handle = scrollRef.current
      if (!listMounted || !handle) return () => {}
      return handle.subscribe(() => {
        if (handle.getPendingDelta() !== 0) onStoreChange()
      })
    },
    [listMounted],
  )
  const readScrollKey = (): string => {
    const handle = scrollRef.current
    if (!listMounted || !handle) return '0:0'
    return `${handle.getScrollTop()}:${handle.getPendingDelta()}`
  }
  React.useSyncExternalStore(subscribeScroll, readScrollKey, readScrollKey)

  const detailVisible = nav.drilled && !!selectedRow
  const regionInner = Math.max(0, cols - 4)
  const regionSideWidth = regionChrome
    ? Math.max(24, Math.round((regionInner * regionChrome.sideWidthPct) / 100))
    : null
  const detailWidth =
    regionSideWidth ?? (layout === 'wide' ? DETAIL_WIDTH_WIDE : DETAIL_WIDTH_MID)
  const infoVisible =
    !!sideInfo && !!selectedRow && !detailVisible && (layout === 'wide' || layout === 'mid')
  const navW =
    showNav && (layout === 'wide' || (layout === 'mid' && !detailVisible && !infoVisible))
      ? NAV_WIDTH + 2
      : 0
  const sideDetailW = (layout === 'wide' || layout === 'mid') && detailVisible ? detailWidth + 2 : 0
  const sideInfoW = infoVisible ? detailWidth + 2 : 0
  const innerWidth = regionChrome ? regionInner : innerPaneWidth(cols, { border: true, paddingX: 1 })
  const mainWidth = Math.max(0, innerWidth - navW - sideDetailW - sideInfoW - (regionChrome ? 5 : 0))

  const detailBaseRows = nav.detailRows + 1
  const contentRows = Math.max(sectionRows.length, showNav ? safeSections.length : 0, 1)
  const listNavLive = !loading && !emptyState && safeSections.length > 0
  const composerOwnsInput = !!composerSlot?.active
  const actionHints =
    listNavLive && !composerOwnsInput && nav.level !== 'detail' && selectedRow && rowActions
      ? rowActions
          .filter(a => a.when(selectedRow))
          .map(a => a.hint ?? `${a.key} ${a.label}`)
          .join(' · ')
      : undefined
  const footerHeadText = [
    listNavLive && !composerOwnsInput && nav.level !== 'detail' && liveRowCount > 0 ? '↑↓ select · pgup/pgdn page' : undefined,
    listNavLive && !composerOwnsInput && nav.level !== 'detail' && liveRowCount > 0 ? '↵/→ view' : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
  const footerFullParts = [
    footerHeadText || undefined,
    actionHints,
  ]
  const computeGeometry = (reservedFooterRows: number) => {
    const viewportBudget = viewportRows(termRows, {
      reserve:
        (regionChrome ? regionChrome.chromeRows : VIEWPORT_RESERVE + Math.max(0, reservedFooterRows - 1)) +
        (composerSlot?.node ? (composerSlot.rows ?? COMPOSER_SLOT_RESERVE) : 0),
      min: 3,
    })
    const listCap =
      detailVisible && (layout === 'fold' || layout === 'inline')
        ? viewportRows(viewportBudget, { reserve: detailBaseRows + 1, min: 3 })
        : viewportBudget
    const listHeight = Math.max(Math.min(1, listCap), Math.min(listCap, contentRows))
    const slackRows =
      detailVisible && (layout === 'fold' || layout === 'inline')
        ? Math.max(0, viewportBudget - listHeight - detailBaseRows - 2)
        : 0
    const resizeActive =
      expandable && (layout === 'fold' || layout === 'inline') && slackRows === 0
    const footerTailText =
      composerSlot?.active
        ? 'esc composer'
        : nav.level === 'detail'
          ? ['↑↓ select · pgup/pgdn page', resizeActive ? '+/- size' : undefined, detailFooterHints, '←/esc back']
              .filter(Boolean)
              .join(' · ')
          : [
            listNavLive && showNav ? 'tab/1-9 section' : undefined,
            footerHints,
            closeHint ?? 'esc close',
          ]
            .filter(Boolean)
            .join(' · ')
    const footerText = [...footerFullParts, footerTailText].filter(Boolean).join(' · ')
    const measuredFooterRows = regionChrome ? 0 : wrapText(footerText, Math.max(1, innerWidth), 'wrap').split('\n').length
    return { viewportBudget, listHeight, slackRows, footerTailText, footerText, measuredFooterRows }
  }
  let geo = computeGeometry(1)
  if (!regionChrome && geo.measuredFooterRows !== 1) {
    const next = computeGeometry(geo.measuredFooterRows)
    geo = next.measuredFooterRows !== geo.measuredFooterRows ? computeGeometry(next.measuredFooterRows) : next
  }
  const { viewportBudget, listHeight, slackRows, footerTailText, footerText, measuredFooterRows } = geo
  const splitDetailHeight = detailBaseRows + slackRows
  const idleSlack =
    !detailVisible && (layout === 'fold' || layout === 'inline') && !!sideInfo
      ? Math.max(0, viewportBudget - listHeight - 3)
      : 0

  const N = sectionRows.length
  const winSpan = listHeight + 2 * ROW_OVERSCAN
  const maxTop = Math.max(0, N - listHeight)
  const anchoredTop = Math.min(Math.max(0, sel + SELECTED_ROW_OFFSET), maxTop)
  const restingTop = Math.min(Math.max(0, scrollRef.current?.getScrollTop() ?? anchoredTop), maxTop)
  const settlingTop = Math.min(Math.max(0, restingTop + (scrollRef.current?.getPendingDelta() ?? 0)), maxTop)
  const winStart =
    N <= winSpan
      ? 0
      : Math.min(Math.max(0, Math.min(anchoredTop, restingTop, settlingTop) - ROW_OVERSCAN), N - winSpan)
  const winEnd = Math.min(N, Math.max(winStart + winSpan, Math.max(anchoredTop, restingTop, settlingTop) + listHeight + ROW_OVERSCAN))

  const body = panesBodyOf({ loading, tokens, emptyState, maxContentWidth, mainWidth, layout, infoVisible, showNav, TabStrip, safeSections, nav, idBase, accent, section, view, sectionRows, ColumnHeader, columns, scrollRef, listHeight, winStart, winEnd, PaneRow, rowKey, sel, N, selectedRow, detailTitle, viewportBudget, renderDetail, sideInfo, detailWidth, regionChrome, splitDetailHeight, SectionNav, NAV_WIDTH, detailVisible, idleSlack })

  return panesFrameOf({ mouseTracking, regionChrome, borderColor: borderColor ?? accent, termRows, view, subtitle, headerRight, headerLine, body, composerSlot, measuredFooterRows, nav, listNavLive, selectedRow, rowActions, footerHeadText, cols, footerTailText, tokens, footerText, idBase })
}
