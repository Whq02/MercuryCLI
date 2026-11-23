import * as React from 'react'
import { Box, Text } from '../../themedRenderer.js'
import { AMBER } from '../../theme/mercuryPalette.js'
import { EmptyState, StateBadge } from '../../widgets/components.js'
import { GLYPH, padTo, truncateToWidth } from '../../theme/glyphs.js'
import { MenuFilterLine } from '../../widgets/menuFold.js'
import { memoryStatusWords } from '../../../sessions/mneme/memoryRefs.js'
import { readPinnedStatus } from '../../../sessions/mneme/mnemeFrontPage.js'
import { pinnedTextLimit, type PinRecord } from '../../../sessions/mneme/mnemeUsage.js'
import { mnemeProjectKey } from '../../../sessions/mneme/paths.js'
import { readLedger } from '../../../sessions/mneme/ledger.js'
import { conversationIdHere } from '../../../engine/connector/focusedConnector.js'
import { MEMORY_SEARCH_READS, LINEAGE_COLUMNS, OVERVIEW_COLUMNS, VIEW_LEGEND, journalHeading, lineageHeading, lineageWidths, type memoryBodySpacing, overviewWidths, type pageWindow, pinnedHeading, plural, searchPlaceholder, tableLine, topicsHeading, wrapText, type OverviewRow, type PageLine } from '../memoryCentreLayout.js'
import type { MercuryThemeTokens } from '../../theme/mercuryTokens.js'
import { NOTE_COLOR, STATUS_TONE, WARNING_STATES, QUIET_STATES, type View, VIEW_WORDS, EMPTY_WORDS, type CentreRow, type Page, type OpenRef, fileWords, refHeader, refWhyLine, type CentreCorrecting, type CentreFlatList } from './refs.js'

export function centreView({
  view,
  list,
  query,
  searchFocus,
  detail,
  page,
  correcting,
  inner,
  tok,
  accent,
  textWidth,
  roomy,
  detailLineBudget,
  pageWin,
  openLines,
  fl,
  pins,
  detailPinned,
  detailPin,
  correctingLines,
  loadError,
  searching,
  above,
  visible,
  clampedSel,
  below,
  note,
  selectedOverview,
  onHint,
  footer,
}: {
  view: View
  list: CentreFlatList['list']
  query: string
  searchFocus: boolean
  detail: OpenRef | null
  page: Page | null
  correcting: CentreCorrecting | null
  inner: number
  tok: MercuryThemeTokens
  accent: string
  textWidth: number
  roomy: ReturnType<typeof memoryBodySpacing>['roomy']
  detailLineBudget: ReturnType<typeof memoryBodySpacing>['detailLines']
  pageWin: ReturnType<typeof pageWindow>
  openLines: PageLine[]
  fl: CentreFlatList
  pins: PinRecord[]
  detailPinned: boolean
  detailPin: PinRecord | undefined
  correctingLines: string[]
  loadError: CentreFlatList['loadError']
  searching: boolean
  above: CentreFlatList['above']
  visible: CentreFlatList['visible']
  clampedSel: CentreFlatList['clampedSel']
  below: CentreFlatList['below']
  note: CentreFlatList['note']
  selectedOverview: OverviewRow | null
  onHint: ((hint: string) => void) | undefined
  footer: string
}): React.ReactNode {
  const subHeading = (): string => {
    if (view === 'facts') return `${plural(list.length, 'fact')}, newest first · ↵ opens one with its keys`
    if (view === 'pinned') return pinnedHeading(readPinnedStatus(), pinnedTextLimit())
    if (view === 'topics') return topicsHeading(list.length)
    if (view === 'lineage') return lineageHeading(readLedger(mnemeProjectKey()), conversationIdHere())
    if (view === 'journal') return journalHeading(list.length)
    return ''
  }

  const widths = view === 'lineage' ? lineageWidths(inner) : overviewWidths(inner)
  const columns = view === 'lineage' ? LINEAGE_COLUMNS : OVERVIEW_COLUMNS
  const stateColor = (state: string): string => (WARNING_STATES.has(state) ? tok.warning : QUIET_STATES.has(state) ? tok.textMuted : tok.textSecondary)
  const placeholder = searchPlaceholder(detail || page || correcting ? 'open' : view === 'overview' ? 'overview' : 'list')
  const legendLines = (text: string): string[] => (detailLineBudget === 2 ? wrapText(text, inner - 2).slice(0, 2) : [truncateToWidth(text, inner - 2)])

  const renderTableRow = (row: CentreRow, active: boolean): React.ReactNode => {
    const cells = row.cells ?? []
    const head = cells.slice(0, -1).map((cell, i) => padTo(cell, widths[i] ?? 0)).join(' ')
    const last = cells[cells.length - 1] ?? ''
    const lastWidth = widths[cells.length - 1] ?? 0
    return (
      <Text key={row.id} wrap="truncate-end">
        <Text color={active ? accent : tok.textMuted}>{active ? `${GLYPH.prompt} ` : '  '}</Text>
        <Text color={active ? tok.textPrimary : tok.textSecondary} bold={active}>{head}</Text>
        <Text> </Text>
        <Text color={active ? tok.textPrimary : stateColor(last)}>{truncateToWidth(last, lastWidth)}</Text>
      </Text>
    )
  }

  const renderListRow = (row: CentreRow, active: boolean): React.ReactNode => {
    const tone = row.ref && (row.kind === 'ref' || row.kind === 'pin') ? STATUS_TONE[row.ref.status] : row.kind === 'convention' ? { glyph: '§', color: tok.textInstruction } : null
    return (
      <Text key={row.id} wrap="truncate-end">
        <Text color={active ? accent : tok.textMuted}>{active ? `${GLYPH.prompt} ` : '  '}</Text>
        {tone ? <Text color={tone.color}>{`${tone.glyph} `}</Text> : null}
        <Text color={active ? tok.textPrimary : tok.textSecondary} bold={active}>{truncateToWidth(row.label, inner - (tone ? 4 : 2))}</Text>
      </Text>
    )
  }

  const renderPageLine = (line: PageLine, i: number): React.ReactNode => {
    const marked = line.marked === true
    const color = line.kind === 'heading' ? tok.textPrimary : line.kind === 'meta' ? tok.textMuted : marked ? tok.textPrimary : tok.textSecondary
    return (
      <Text key={i} wrap="truncate-end">
        <Text color={marked ? accent : tok.textMuted}>{marked ? `${GLYPH.prompt} ` : '  '}</Text>
        <Text color={color} bold={line.kind === 'heading' || marked}>{truncateToWidth(line.text, textWidth)}</Text>
      </Text>
    )
  }

  const pageBlock = (title: string, meta: string, crumb: string): React.ReactNode => (
    <Box flexDirection="column">
      <Text color={tok.textMuted} wrap="truncate-end">{truncateToWidth(`memory › ${crumb}`, inner)}</Text>
      <Text color={tok.textPrimary} bold wrap="truncate-end">{truncateToWidth(title, inner)}</Text>
      <Text color={tok.textInstruction} wrap="truncate-end">{truncateToWidth(meta, inner)}</Text>
      {roomy ? <Box height={1} /> : null}
      {pageWin.above > 0 ? <Text color={tok.textMuted}>{`  +${pageWin.above} above`}</Text> : null}
      {openLines.slice(pageWin.start, pageWin.end).map((line, i) => renderPageLine(line, pageWin.start + i))}
      {pageWin.below > 0 ? <Text color={tok.textMuted}>{`  +${pageWin.below} more below`}</Text> : null}
    </Box>
  )

  const selectedWhy = (): string => {
    const row = fl.selected
    if (!row) return MEMORY_SEARCH_READS
    if (row.kind === 'convention' && row.convention) return `instruction file · line ${row.convention.line} · loads every session · ↵ opens it there · ${fileWords(row.convention.path)}`
    if (row.ref) return `${refWhyLine(row.ref, pins)} · ${memoryStatusWords(row.ref)}`
    return MEMORY_SEARCH_READS
  }

  return (
    <Box flexDirection="column">
      <MenuFilterLine focused={query !== '' || searchFocus} text={query} placeholder={placeholder} accent={accent} muted={tok.textMuted} primary={tok.textPrimary} />
      {roomy ? <Box height={1} /> : null}
      {correcting && detail ? (
        <Box flexDirection="column">
          <Text color={AMBER} wrap="truncate-end">{correcting.seq === null ? 'correcting the pending fact — retype it; the wording below is struck:' : `correcting seq ${correcting.seq} — retype it; the wording below goes to history:`}</Text>
          {detailPinned ? <Text color={AMBER} wrap="truncate-end">the pin and its asked-for mark follow the new wording</Text> : null}
          {correctingLines.map((line, i) => (
            <Text key={i} color={tok.textSecondary} wrap="truncate-end">{`${i === 0 ? 'now: ' : '     '}${line}`}</Text>
          ))}
          <Text color={tok.textPrimary}>{`> ${correcting.buffer}`}<Text color={accent}>▁</Text></Text>
        </Box>
      ) : detail ? (
        <Box flexDirection="column">
          <Box>
            <StateBadge state={detail.status === 'current' ? 'live' : 'gated'} label={memoryStatusWords(detail)} />
            <Text color={tok.textMuted}>{`  ${refHeader(detail, detailPinned, detailPin?.asked === true)}`}</Text>
          </Box>
          <Text color={tok.textInstruction} wrap="truncate-end">{truncateToWidth(refWhyLine(detail, pins), inner)}</Text>
          {roomy ? <Box height={1} /> : null}
          {pageWin.above > 0 ? <Text color={tok.textMuted}>{`  +${pageWin.above} above`}</Text> : null}
          {openLines.slice(pageWin.start, pageWin.end).map((line, i) => renderPageLine(line, pageWin.start + i))}
          {pageWin.below > 0 ? <Text color={tok.textMuted}>{`  +${pageWin.below} more below`}</Text> : null}
        </Box>
      ) : page ? (
        pageBlock(page.title, page.meta, page.crumb)
      ) : fl.raw === null ? (
        <Text color={tok.textMuted}>◓ reading memory stores …</Text>
      ) : loadError ? (
        <Box flexDirection="column">
          <Text color={AMBER}>{`▲ memory unreadable — ${truncateToWidth(loadError, inner - 22)}`}</Text>
          <Text color={tok.textMuted}>the stores are unknown, not empty · r retries</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {view === 'overview' && !searching ? (
            <Text color={tok.textInstruction} wrap="truncate-end">{`  ${tableLine([...columns], widths)}`}</Text>
          ) : view === 'lineage' ? (
            <Box flexDirection="column">
              <Text color={tok.textMuted} wrap="truncate-end">{truncateToWidth(`memory › ${VIEW_WORDS.lineage} · ${subHeading()}`, inner)}</Text>
              <Text color={tok.textInstruction} wrap="truncate-end">{`  ${tableLine([...columns], widths)}`}</Text>
            </Box>
          ) : searching ? (
            <Text color={tok.textMuted} wrap="truncate-end">{truncateToWidth(`memory › matches for “${query}” · ${plural(list.length, 'match', 'matches')}`, inner)}</Text>
          ) : (
            <Text color={tok.textMuted} wrap="truncate-end">{truncateToWidth(`memory › ${VIEW_WORDS[view as Exclude<View, 'overview'>]} · ${subHeading()}`, inner)}</Text>
          )}
          {list.length === 0 ? (
            <Box marginTop={1}>
              <EmptyState glyph="○" title={searching || query ? 'nothing matches' : 'nothing here yet'} hint={searching || query ? 'different words, or esc to clear the search' : view === 'overview' ? '' : EMPTY_WORDS[view as Exclude<View, 'overview'>]} />
            </Box>
          ) : null}
          {above > 0 ? <Text color={tok.textMuted}>{`  +${above} above`}</Text> : null}
          {visible.map((row, i) => (row.cells ? renderTableRow(row, i === clampedSel) : renderListRow(row, i === clampedSel)))}
          {below > 0 ? <Text color={tok.textMuted}>{`  +${below} more below`}</Text> : null}
          <Box marginTop={roomy ? 1 : 0} flexDirection="column">
            {note ? (
              legendLines(note.text).map((line, i) => <Text key={i} color={NOTE_COLOR[note.kind]} wrap="truncate-end">{`  ${line}`}</Text>)
            ) : selectedOverview ? (
              legendLines(selectedOverview.detail).map((line, i) => <Text key={i} color={tok.textInstruction} wrap="truncate-end">{`  ${line}`}</Text>)
            ) : searching ? (
              legendLines(selectedWhy()).map((line, i) => <Text key={i} color={tok.textInstruction} wrap="truncate-end">{`  ${line}`}</Text>)
            ) : view !== 'overview' && view !== 'facts' ? (
              legendLines(VIEW_LEGEND[view]).map((line, i) => <Text key={i} color={tok.textInstruction} wrap="truncate-end">{`  ${line}`}</Text>)
            ) : null}
          </Box>
        </Box>
      )}
      {note && (detail !== null || page !== null || correcting !== null || fl.raw === null || loadError !== null) ? (
        <Box marginTop={1}>
          <Text color={NOTE_COLOR[note.kind]} wrap="truncate-end">{truncateToWidth(note.text, inner)}</Text>
        </Box>
      ) : null}
      {onHint === undefined ? (
        <Box marginTop={1}>
          <Text color={tok.textMuted} wrap="truncate-end">{truncateToWidth(footer, inner)}</Text>
        </Box>
      ) : null}
    </Box>
  )
}
