import * as React from 'react'
import { Box, Text, type DOMElement } from '../../themedRenderer.js'
import { AlternateScreen } from '../../renderer/elements/AlternateScreen.js'
import ScrollBox, { type ScrollBoxHandle } from '../../renderer/elements/ScrollBox.js'
import type { MercuryThemeTokens } from '../../theme/mercuryTokens.js'
import { EmptyState, ProductLockup } from '../components.js'
import { InteractiveRow } from '../InteractiveRow.js'
import type { useNavigablePanes } from '../useNavigablePanes.js'
import { PopupScrollViewport } from '../../select/popup-list.js'
import type { ColumnDef, RowAction, SectionDef } from '../NavigablePanes.js'

export type Layout = 'wide' | 'mid' | 'fold' | 'inline'

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

export function panesBodyOf<Row>({
  loading,
  tokens,
  emptyState,
  maxContentWidth,
  mainWidth,
  layout,
  infoVisible,
  showNav,
  TabStrip,
  safeSections,
  nav,
  idBase,
  accent,
  section,
  view,
  sectionRows,
  ColumnHeader,
  columns,
  scrollRef,
  listHeight,
  winStart,
  winEnd,
  PaneRow,
  rowKey,
  sel,
  N,
  selectedRow,
  detailTitle,
  viewportBudget,
  renderDetail,
  sideInfo,
  detailWidth,
  regionChrome,
  splitDetailHeight,
  SectionNav,
  NAV_WIDTH,
  detailVisible,
  idleSlack,
}: {
  loading: boolean
  tokens: MercuryThemeTokens
  emptyState: NavigablePanesProps<Row>['emptyState']
  maxContentWidth: number | undefined
  mainWidth: number
  layout: Layout
  infoVisible: boolean
  showNav: boolean
  TabStrip: <R>(props: { sections: SectionDef<R>[]; active: number; idBase: string; onSelectSection: (i: number) => void; tokens: MercuryThemeTokens }) => React.ReactNode
  safeSections: SectionDef<Row>[]
  nav: ReturnType<typeof useNavigablePanes>
  idBase: string
  accent: string
  section: SectionDef<Row>
  view: string
  sectionRows: Row[]
  ColumnHeader: <R>(props: { columns: ColumnDef<R>[]; totalWidth: number; tokens: MercuryThemeTokens }) => React.ReactNode
  columns: ColumnDef<Row>[]
  scrollRef: React.RefObject<ScrollBoxHandle | null>
  listHeight: number
  winStart: number
  winEnd: number
  PaneRow: <R>(props: { row: R; rowId: string; columns: ColumnDef<R>[]; selected: boolean; totalWidth: number; rowRef?: React.Ref<DOMElement>; onSelect: () => void; onActivate: () => void; tokens: MercuryThemeTokens }) => React.ReactNode
  rowKey: (row: Row) => string
  sel: number
  N: number
  selectedRow: Row
  detailTitle: NavigablePanesProps<Row>['detailTitle']
  viewportBudget: number
  renderDetail: (row: Row) => React.ReactNode
  sideInfo: NavigablePanesProps<Row>['sideInfo']
  detailWidth: number
  regionChrome: NavigablePanesProps<Row>['regionChrome']
  splitDetailHeight: number
  SectionNav: <R>(props: { sections: SectionDef<R>[]; active: number; width: number; idBase: string; onSelectSection: (i: number) => void; tokens: MercuryThemeTokens }) => React.ReactNode
  NAV_WIDTH: number
  detailVisible: boolean
  idleSlack: number
}): React.ReactNode {
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
        {}
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
          <PopupScrollViewport scrollRef={scrollRef}>
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
                  totalWidth={Math.max(1, totalWidth - (N > listHeight ? 1 : 0))}
                  rowRef={gi === sel ? (nav.rowRef as React.Ref<DOMElement>) : undefined}
                  onSelect={() => nav.selectRow(gi)}
                  onActivate={nav.activateCurrent}
                  tokens={tokens}
                />
              )
            })}
            {winEnd < N ? <Box height={N - winEnd} flexShrink={0} /> : null}
          </ScrollBox>
          </PopupScrollViewport>
        )}
      </Box>
    )

    const rightDetail = selectedRow ? (
      <Box flexDirection="column" overflow="hidden">
        {}
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
  return body
}

export function panesFrameOf<Row>({
  mouseTracking,
  regionChrome,
  accent,
  termRows,
  view,
  subtitle,
  headerRight,
  headerLine,
  body,
  composerSlot,
  measuredFooterRows,
  nav,
  listNavLive,
  selectedRow,
  rowActions,
  footerHeadText,
  cols,
  footerTailText,
  tokens,
  footerText,
  idBase,
}: {
  mouseTracking: boolean
  regionChrome: NavigablePanesProps<Row>['regionChrome']
  accent: string
  termRows: number
  view: string
  subtitle: string | undefined
  headerRight: React.ReactNode
  headerLine: React.ReactNode
  body: React.ReactNode
  composerSlot: NavigablePanesProps<Row>['composerSlot']
  measuredFooterRows: number
  nav: ReturnType<typeof useNavigablePanes>
  listNavLive: boolean
  selectedRow: Row
  rowActions: RowAction<Row>[] | undefined
  footerHeadText: string
  cols: number
  footerTailText: string
  tokens: MercuryThemeTokens
  footerText: string
  idBase: string
}): React.ReactNode {
  return (
    <AlternateScreen mouseTracking={mouseTracking}>
      {}
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
            {}
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
        {headerLine ? <Box flexShrink={0} maxHeight={2} overflow="hidden">{headerLine}</Box> : null}
        {regionChrome?.aboveBody ? (
          <Box flexShrink={0} flexDirection="column" overflow="hidden">
            {regionChrome.aboveBody}
          </Box>
        ) : null}

        {}
        {body}

        {}
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

        <Box marginTop={regionChrome ? 0 : 1} flexShrink={0} height={measuredFooterRows} overflow="hidden" columnGap={0}>
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
                <Text color={tokens.textMuted} wrap="wrap">
                  {footerText}
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
