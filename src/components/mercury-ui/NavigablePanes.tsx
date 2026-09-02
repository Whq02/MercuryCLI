import * as React from 'react'
import { useEffect, useRef, useLayoutEffect } from 'react'
import { Box, Text, useInput, type DOMElement } from '../../ink.js'
import { AlternateScreen } from '../../ink/components/AlternateScreen.js'
import ScrollBox, { type ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type { MercuryThemeTokens } from '../../utils/mercuryTokens.js'
import { packFooter } from './footerHint.js'
import { innerWidth as innerPaneWidth, viewportRows } from './geometry.js'
import { truncateToWidth } from './glyphs.js'
import { EmptyState, ProductLockup } from './components.js'
import { InteractiveRow } from './InteractiveRow.js'
import { CursorCell } from './LiveGlyphs.js'
import { useMercuryTokens } from './useMercuryTokens.js'
import { useNavigablePanes } from './useNavigablePanes.js'


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

export type NavigablePanesProps<Row> = {
  view: string
  subtitle?: string
  headerLine?: React.ReactNode
  sections: SectionDef<Row>[]
  columns: ColumnDef<Row>[]
  rowKey: (row: Row) => string
  renderDetail: (row: Row) => React.ReactNode
  onClose: () => void
  footerHints?: string
  detailFooterHints?: string
  composerSlot?: {
    active: boolean
    node: React.ReactNode
    onInput: (input: string, key: Record<string, boolean>) => void
    onEscape: () => void
    rows?: number
  }
  onTypeToCompose?: (row: Row, input: string) => void
  expandable?: boolean
  loading?: boolean
  emptyState?: { title: string; hint?: string }
  mouseTracking?: boolean
  onActivate?: (row: Row) => void
  rowActions?: RowAction<Row>[]
  initialRowKey?: string
  initialSectionId?: string
  onSectionChange?: (id: string, index: number) => void
  closeHint?: string
  maxContentWidth?: number
  headerRight?: React.ReactNode
  sideInfo?: (row: Row) => React.ReactNode
  detailTitle?: (row: Row) => string
  regionChrome?: {
    headerBlock: React.ReactNode
    aboveBody?: React.ReactNode
    belowBody?: React.ReactNode
    mainTitle: React.ReactNode
    sideTitle: (row: Row) => React.ReactNode
    sideWidthPct: number
    chromeRows: number
  }
  inputActive?: boolean
}

const COL_GAP = 2
const NAV_WIDTH = 22
const DETAIL_WIDTH_WIDE = 40
const DETAIL_WIDTH_MID = 34
const VIEWPORT_RESERVE = 11
const COMPOSER_SLOT_RESERVE = 2
const ROW_OVERSCAN = 12

type Layout = 'wide' | 'mid' | 'fold' | 'inline'
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
      {
}
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
  closeHint,
  maxContentWidth,
  headerRight,
  sideInfo,
  detailTitle,
  composerSlot,
  onTypeToCompose,
  regionChrome,
  inputActive = true,
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
  useEffect(() => {
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
  useEffect(() => {
    if (sel !== nav.sel) nav.selectRow(sel)
  })

  useInput(
    (input, key) => {
      if ((key as Record<string, boolean>).escape) return
      composerSlot?.onInput(input, key as unknown as Record<string, boolean>)
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
  useLayoutEffect(() => {
    if (nav.rowRef.current && scrollRef.current) {
      scrollRef.current.scrollToElement(nav.rowRef.current, -2)
    }
  }, [sel, nav.section, nav.rowRef])

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

  const viewportBudget = viewportRows(termRows, {
    reserve:
      (regionChrome ? regionChrome.chromeRows : VIEWPORT_RESERVE) +
      (composerSlot?.node ? (composerSlot.rows ?? COMPOSER_SLOT_RESERVE) : 0),
    min: 3,
  })
  const detailBaseRows = nav.detailRows + 1
  const listCap =
    detailVisible && (layout === 'fold' || layout === 'inline')
      ? viewportRows(viewportBudget, { reserve: detailBaseRows + 1, min: 3 })
      : viewportBudget
  const contentRows = Math.max(sectionRows.length, showNav ? safeSections.length : 0, 1)
  const listHeight = Math.max(Math.min(1, listCap), Math.min(listCap, contentRows))
  const slackRows =
    detailVisible && (layout === 'fold' || layout === 'inline')
      ? Math.max(0, viewportBudget - listHeight - detailBaseRows - 2)
      : 0
  const splitDetailHeight = detailBaseRows + slackRows
  const idleSlack =
    !detailVisible && (layout === 'fold' || layout === 'inline') && !!sideInfo
      ? Math.max(0, viewportBudget - listHeight - 3)
      : 0

  const N = sectionRows.length
  const winSpan = listHeight + 2 * ROW_OVERSCAN
  const winStart =
    N <= winSpan
      ? 0
      : Math.min(Math.max(0, sel - (listHeight >> 1) - ROW_OVERSCAN), N - winSpan)
  const winEnd = Math.min(N, winStart + winSpan)

  const resizeActive =
    expandable && (layout === 'fold' || layout === 'inline') && slackRows === 0
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
    listNavLive && !composerOwnsInput && nav.level !== 'detail' && liveRowCount > 0 ? '↑↓ select' : undefined,
    listNavLive && !composerOwnsInput && nav.level !== 'detail' && liveRowCount > 0 ? '↵/→ view' : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
  const footerFullParts = [
    footerHeadText || undefined,
    actionHints,
  ]
  const footerTailText =
    composerSlot?.active
      ? 'esc composer'
      : nav.level === 'detail'
        ? ['↑↓ select', resizeActive ? '+/- size' : undefined, detailFooterHints, '←/esc back']
            .filter(Boolean)
            .join(' · ')
        : [
          listNavLive && showNav ? 'tab/1-9 section' : undefined,
          footerHints,
          closeHint ?? 'esc close',
        ]
          .filter(Boolean)
          .join(' · ')

  let body: React.ReactNode
  if (loading) {
    body = (
      <Box marginTop={1} flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center">
        <Text color={tokens.textMuted}>loading…</Text>
      </Box>
    )
  } else if (emptyState) {
    body = (
      <Box marginTop={1} flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center">
        <EmptyState title={emptyState.title} hint={emptyState.hint} />
      </Box>
    )
  } else {
    const totalWidth = maxContentWidth ? Math.min(mainWidth, maxContentWidth) : mainWidth
    const mainList = (
      <Box flexDirection="column" overflow="hidden">
        {
}
        {(layout === 'fold' || layout === 'inline' || (layout === 'mid' && infoVisible)) &&
        showNav ? (
          <TabStrip
            sections={safeSections}
            active={nav.section}
            idBase={idBase}
            onSelectSection={nav.selectSection}
            tokens={tokens}
          />
        ) : null}
        {(layout === 'inline' || layout === 'fold') && !showNav ? (
          <Box height={1} overflow="hidden">
            <Text bold color={accent}>
              {section?.label ?? view}
            </Text>
            <Text color={tokens.textMuted}> ({section?.count ?? sectionRows.length})</Text>
          </Box>
        ) : null}
        <Box paddingLeft={2} flexShrink={0}>
          <ColumnHeader columns={columns} totalWidth={totalWidth - 2} tokens={tokens} />
        </Box>
        {sectionRows.length === 0 ? (
          <Box marginTop={1}>
            <Text color={tokens.textMuted}>{section?.emptyHint ?? 'nothing here'}</Text>
          </Box>
        ) : (
          <ScrollBox
            ref={scrollRef}
            height={listHeight}
            flexShrink={0}
            flexDirection="column"
          >
            {winStart > 0 ? <Box height={winStart} flexShrink={0} /> : null}
            {sectionRows.slice(winStart, winEnd).map((r, i) => {
              const gi = winStart + i
              return (
                <PaneRow
                  key={rowKey(r)}
                  row={r}
                  rowId={`${idBase}:row:${rowKey(r)}`}
                  columns={columns}
                  selected={gi === sel}
                  totalWidth={totalWidth}
                  rowRef={gi === sel ? (nav.rowRef as React.Ref<DOMElement>) : undefined}
                  onSelect={() => nav.selectRow(gi)}
                  onActivate={nav.activateCurrent}
                  tokens={tokens}
                />
              )
            })}
            {winEnd < N ? <Box height={N - winEnd} flexShrink={0} /> : null}
          </ScrollBox>
        )}
      </Box>
    )

    const rightDetail = selectedRow ? (
      <Box flexDirection="column" overflow="hidden">
        {
}
        <Text bold color={accent} wrap="truncate-end">
          {(detailTitle?.(selectedRow) || '').trim() || 'detail'}
        </Text>
        <ScrollBox height={Math.max(1, viewportBudget - 3)} flexShrink={0} flexDirection="column">
          {renderDetail(selectedRow)}
        </ScrollBox>
      </Box>
    ) : null

    const infoPane =
      infoVisible && selectedRow && sideInfo ? (
        <Box width={detailWidth} flexShrink={0} marginLeft={regionChrome ? 1 : 2} overflow="hidden" flexDirection="column" borderStyle="round" borderColor={tokens.borderSubtle} paddingX={1}>
          {regionChrome ? (
            <Box flexShrink={0} height={1} overflow="hidden">
              {regionChrome.sideTitle(selectedRow)}
            </Box>
          ) : null}
          <ScrollBox height={Math.max(1, viewportBudget - 2 - (regionChrome ? 1 : 0))} flexShrink={0} flexDirection="column">
            {sideInfo(selectedRow)}
          </ScrollBox>
        </Box>
      ) : null

    const splitDetail = selectedRow ? (
      <Box flexDirection="column" height={splitDetailHeight + 1} flexShrink={0} marginTop={1} overflow="hidden">
        <Text bold color={accent} wrap="truncate-end">
          {(detailTitle?.(selectedRow) || '').trim() || 'detail'}
          {nav.expanded ? <Text color={tokens.textMuted}> (expanded)</Text> : null}
        </Text>
        <ScrollBox height={splitDetailHeight} flexShrink={0} flexDirection="column">
          {renderDetail(selectedRow)}
        </ScrollBox>
      </Box>
    ) : null

    if (layout === 'wide') {
      body = (
        <Box marginTop={regionChrome ? 0 : 1} overflow="hidden">
          {showNav ? (
            <SectionNav
              sections={safeSections}
              active={nav.section}
              width={NAV_WIDTH}
              idBase={idBase}
              onSelectSection={nav.selectSection}
              tokens={tokens}
            />
          ) : null}
          <Box
            flexDirection="column"
            flexGrow={1}
            overflow="hidden"
            borderStyle={regionChrome ? 'round' : undefined}
            borderColor={regionChrome ? tokens.borderSubtle : undefined}
            paddingX={regionChrome ? 1 : 0}
          >
            {regionChrome ? (
              <Box flexShrink={0} height={1} overflow="hidden">
                {regionChrome.mainTitle}
              </Box>
            ) : null}
            {mainList}
          </Box>
          {detailVisible ? (
            <Box width={detailWidth} flexShrink={0} marginLeft={2} overflow="hidden" borderStyle="round" borderColor={tokens.borderSubtle} paddingX={1} flexDirection="column">
              {rightDetail}
            </Box>
          ) : (
            infoPane
          )}
        </Box>
      )
    } else if (layout === 'mid') {
      body = (
        <Box marginTop={regionChrome ? 0 : 1} overflow="hidden">
          {showNav && !detailVisible && !infoVisible ? (
            <SectionNav
              sections={safeSections}
              active={nav.section}
              width={NAV_WIDTH}
              idBase={idBase}
              onSelectSection={nav.selectSection}
              tokens={tokens}
            />
          ) : null}
          <Box
            flexDirection="column"
            flexGrow={1}
            overflow="hidden"
            borderStyle={regionChrome ? 'round' : undefined}
            borderColor={regionChrome ? tokens.borderSubtle : undefined}
            paddingX={regionChrome ? 1 : 0}
          >
            {regionChrome ? (
              <Box flexShrink={0} height={1} overflow="hidden">
                {regionChrome.mainTitle}
              </Box>
            ) : null}
            {mainList}
          </Box>
          {detailVisible ? (
            <Box width={detailWidth} flexShrink={0} marginLeft={2} overflow="hidden" borderStyle="round" borderColor={tokens.borderSubtle} paddingX={1} flexDirection="column">
              {rightDetail}
            </Box>
          ) : (
            infoPane
          )}
        </Box>
      )
    } else {
      body = (
        <Box flexDirection="column" marginTop={regionChrome ? 0 : 1} overflow="hidden">
          <Box flexDirection="column" overflow="hidden">
            {mainList}
          </Box>
          {detailVisible ? splitDetail : null}
          {!detailVisible && idleSlack >= 6 && sideInfo && selectedRow ? (
            <Box
              flexDirection="column"
              marginTop={1}
              height={idleSlack}
              overflow="hidden"
              borderStyle="round"
              borderColor={tokens.borderSubtle}
              paddingX={1}
            >
              <ScrollBox height={Math.max(1, idleSlack - 2)} flexShrink={0} flexDirection="column">
                {sideInfo(selectedRow)}
              </ScrollBox>
            </Box>
          ) : null}
        </Box>
      )
    }
  }

  return (
    <AlternateScreen mouseTracking={mouseTracking}>
      {
}
      <Box
        flexDirection="column"
        borderStyle={regionChrome ? undefined : 'round'}
        borderColor={regionChrome ? undefined : accent}
        paddingX={regionChrome ? 2 : 1}
        width="100%"
        flexShrink={0}
        minHeight={Math.max(0, termRows - 1)}
      >
        {regionChrome ? (
          <Box flexShrink={0} flexDirection="column" overflow="hidden">
            {regionChrome.headerBlock}
          </Box>
        ) : (
          <Box flexShrink={0} height={1} overflow="hidden">
            {
}
            <ProductLockup view={view} {...(subtitle !== undefined ? { subtitle } : {})} />
            {headerRight ? (
              <>
                <Box flexGrow={1} />
                <Box flexShrink={0} marginLeft={2}>
                  {headerRight}
                </Box>
              </>
            ) : null}
          </Box>
        )}
        {headerLine ? <Box flexShrink={0}>{headerLine}</Box> : null}
        {regionChrome?.aboveBody ? (
          <Box flexShrink={0} flexDirection="column" overflow="hidden">
            {regionChrome.aboveBody}
          </Box>
        ) : null}

        {}
        {body}

        {
}
        <Box flexGrow={1} />

        {regionChrome?.belowBody ? (
          <Box flexShrink={0} flexDirection="column" overflow="hidden">
            {regionChrome.belowBody}
          </Box>
        ) : null}

        {}
        {composerSlot?.node ? (
          <Box flexShrink={0} flexDirection="column">
            {composerSlot.node}
          </Box>
        ) : null}

        {
}
        <Box marginTop={regionChrome ? 0 : 1} flexShrink={0} height={regionChrome ? 0 : 1} overflow="hidden" columnGap={0}>
          {(() => {
            const hintable =
              nav.level !== 'detail' &&
              listNavLive &&
              !composerSlot?.active &&
              !!selectedRow &&
              !!rowActions
            const hints = hintable
              ? rowActions!.filter(a => a.when(selectedRow!))
              : []
            const headText = footerHeadText
            const fullText = [...footerFullParts, footerTailText]
              .filter(Boolean)
              .join(' · ')
            const hintsWidth = hints.reduce(
              (w, a) => w + (a.hint ?? `${a.key} ${a.label}`).length + 3,
              0,
            )
            const budget = Math.max(0, cols - 4)
            const clickable =
              hints.length > 0 &&
              headText.length + 3 + hintsWidth + footerTailText.length <= budget
            if (!clickable) {
              return (
                <Text color={tokens.textMuted} wrap="truncate-end">
                  {packFooter(fullText, budget)}
                </Text>
              )
            }
            return (
              <>
                {headText ? <Text color={tokens.textMuted}>{headText} · </Text> : null}
                {hints.map(a => (
                  <Box key={a.key} flexShrink={0} columnGap={0}>
                    <InteractiveRow
                      id={`${idBase}:hint:${a.key}`}
                      selected={false}
                      directActivate
                      onActivate={() => a.run(selectedRow!)}
                      height={1}
                    >
                      <Text color={tokens.textMuted}>
                        {a.hint ?? `${a.key} ${a.label}`}
                      </Text>
                    </InteractiveRow>
                    <Text color={tokens.textMuted}> · </Text>
                  </Box>
                ))}
                <Text color={tokens.textMuted}>{footerTailText}</Text>
              </>
            )
          })()}
        </Box>
      </Box>
    </AlternateScreen>
  )
}
