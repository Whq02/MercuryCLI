import React from 'react'
import { Box, Text, paletteCollapsed } from '../../ink.js'
import { GLYPH } from '../mercury-ui/glyphs.js'
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js'
import { WorkingGlyph } from '../mercury-ui/LiveGlyphs.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import { caretLens } from './lineDraft.js'
import { STATE_GLYPH, STATE_WORD } from './ConcourseLayout.js'
import type { ConcourseRowV1 } from './contracts.js'
import {
  COMPACT_FILTER_TAIL,
  COMPACT_NEW_SESSION_ROW,
  compactBoardFoot,
  compactBoardRowText,
  compactBoardTitle,
  compactConcourseGeometry,
  compactFrameBottom,
  compactFrameGlyphs,
  compactFrameTop,
  compactListFoot,
  compactListRowText,
  compactListTitle,
  compactListWindow,
  compactLiveFoot,
  compactLiveTitle,
  compactOpenedFoot,
  type CompactConcourseProfile,
  type CompactFrameSpan,
} from './compactBoard.js'

export interface CompactConcourseWiring {
  selectSession: (sessionId: string) => void
  activateSession: (sessionId: string) => void
  focusList: () => void
  focusLive: () => void
  newSession?: () => void
}

export type CompactFootNote = { tone: 'muted' | 'warning' | 'info' | 'failure' | 'success'; text: string }

function Frame({
  span,
  rows,
  inner,
  title,
  focused,
  onFocus,
  id,
  children,
}: {
  span: CompactFrameSpan
  rows: number
  inner: number
  title: string
  focused: boolean
  onFocus: () => void
  id: string
  children: React.ReactNode
}): React.ReactNode {
  const t = useMercuryTokens()
  const width = span.x1 - span.x0 + 1
  const glyphs = compactFrameGlyphs(paletteCollapsed() && focused)
  const ink = focused ? t.info : t.borderSubtle
  const edge = (side: 'left' | 'right'): React.ReactNode => (
    <Box flexDirection="column" width={1} flexShrink={0}>
      {Array.from({ length: inner }, (_, i) => (
        <Box key={i} height={1} flexShrink={0}>
          <Text color={ink}>{side === 'left' ? glyphs.left : glyphs.right}</Text>
        </Box>
      ))}
    </Box>
  )
  return (
    <Box flexDirection="column" width={width} height={rows} flexShrink={0} overflow="hidden">
      <Box height={1} flexShrink={0} overflow="hidden">
        <InteractiveRow id={id} directActivate hoverStyle="chrome-ink" onActivate={onFocus} flexGrow={1}>
          {hover => (
            <Text color={focused || hover ? t.info : t.borderSubtle} wrap="truncate-end">
              {compactFrameTop(title, width, glyphs)}
            </Text>
          )}
        </InteractiveRow>
      </Box>
      <Box flexDirection="row" height={inner} flexShrink={0} overflow="hidden">
        {edge('left')}
        <Box flexDirection="column" width={span.inner} height={inner} flexShrink={0} overflow="hidden">
          {children}
        </Box>
        {edge('right')}
      </Box>
      <Box height={1} flexShrink={0} overflow="hidden">
        <Text color={ink} wrap="truncate-end">
          {compactFrameBottom(width, glyphs)}
        </Text>
      </Box>
    </Box>
  )
}

function FootRow({ text, note, filtering, filterText, filterCaret }: { text: string; note: CompactFootNote | null; filtering: boolean; filterText: string; filterCaret: number }): React.ReactNode {
  const t = useMercuryTokens()
  if (filtering) {
    const lens = caretLens({ text: filterText, caret: filterCaret }, 40)
    return (
      <Box height={1} flexShrink={0} overflow="hidden">
        <Text wrap="truncate-end">
          <Text color={t.textMuted}> / </Text>
          {lens.clippedLeft ? <Text color={t.textMuted}>…</Text> : null}
          <Text color={t.textPrimary}>{lens.before}</Text>
          {lens.at === '' ? <Text color={t.info}>{GLYPH.caretBlock}</Text> : <Text color={t.textPrimary} inverse>{lens.at}</Text>}
          <Text color={t.textPrimary}>{lens.after}</Text>
          {lens.clippedRight ? <Text color={t.textMuted}>…</Text> : null}
          <Text color={t.textInstruction}> · {COMPACT_FILTER_TAIL}</Text>
        </Text>
      </Box>
    )
  }
  if (note !== null) {
    const ink =
      note.tone === 'warning' ? t.warning
      : note.tone === 'failure' ? t.failureText
      : note.tone === 'success' ? t.success
      : note.tone === 'info' ? t.infoText
      : t.textMuted
    return (
      <Box height={1} flexShrink={0} overflow="hidden">
        <Text color={ink} wrap="truncate-middle">
          {' '}
          {note.text}
        </Text>
      </Box>
    )
  }
  return (
    <Box height={1} flexShrink={0} overflow="hidden">
      <Text color={t.textInstruction} wrap="truncate-end">
        {' '}
        {text}
      </Text>
    </Box>
  )
}

function stateGlyphOf(row: ConcourseRowV1, ink: string): React.ReactNode {
  if (row.state === 'working') return <WorkingGlyph color={ink} active />
  const spine = STATE_GLYPH[row.state]
  return spine !== undefined ? <Text color={ink}>{spine.glyph}</Text> : <Text color={ink}>{GLYPH.read}</Text>
}

export function CompactConcourse({
  profile,
  cols,
  rows,
  region,
  sessionRows,
  selectedId,
  filtering,
  filterText,
  filterCaret,
  reduced,
  liveDraftRows,
  liveDraftHeld,
  verbsFire,
  showLive,
  note,
  composerNote,
  mirrorNode,
  liveComposerNode,
  wiring,
}: {
  profile: CompactConcourseProfile
  cols: number
  rows: number
  region: 'list' | 'live'
  sessionRows: ConcourseRowV1[]
  selectedId: string | null
  filtering: boolean
  filterText: string
  filterCaret: number
  reduced: boolean
  liveDraftRows: number
  liveDraftHeld: boolean
  verbsFire: boolean
  showLive: boolean
  note: CompactFootNote | null
  composerNote: string | null
  mirrorNode: (rows: number, width: number) => React.ReactNode
  liveComposerNode?: (bandRows: number, width: number) => React.ReactNode
  wiring: CompactConcourseWiring
}): React.ReactNode {
  const t = useMercuryTokens()
  const geo = compactConcourseGeometry(cols, rows, {
    sessionCount: sessionRows.length,
    newSessionDoor: wiring.newSession !== undefined,
    composerBand: reduced || liveComposerNode === undefined ? 0 : Math.max(1, liveDraftRows),
  })
  const selectedIndex = Math.max(0, sessionRows.findIndex(r => r.sessionId === selectedId))
  const selected = sessionRows[selectedIndex]
  const stateWordOf = (row: ConcourseRowV1): string => STATE_WORD[row.state] ?? row.state
  const stateInkOf = (row: ConcourseRowV1): string => {
    const spine = STATE_GLYPH[row.state]
    return spine !== undefined ? t[spine.color] : t.textMuted
  }

  if (!geo.framed) {
    return (
      <Box flexDirection="column" width={cols} height={rows} overflow="hidden">
        {sessionRows.slice(0, Math.max(0, rows)).map(r => (
          <Box key={r.sessionId} height={1} flexShrink={0} overflow="hidden">
            <Text color={r.sessionId === selectedId ? t.info : t.textSecondary} wrap="truncate-end">
              {r.sessionId === selectedId ? '❯ ' : '  '}
              {r.title}
            </Text>
          </Box>
        ))}
      </Box>
    )
  }

  const listRows = (single: boolean): React.ReactNode => {
    const win = compactListWindow(sessionRows.length, selectedIndex, geo.listWindowRows)
    const out: React.ReactNode[] = []
    if (sessionRows.length === 0 && geo.listWindowRows > 0) {
      out.push(
        <Box key="empty" height={1} flexShrink={0} overflow="hidden">
          <Text color={t.textMuted} wrap="truncate-end">
            {'   no sessions yet'}
          </Text>
        </Box>,
      )
    }
    for (const r of sessionRows.slice(win.start, win.end)) {
      const isSel = r.sessionId === selectedId
      const ink = stateInkOf(r)
      const glyph = stateGlyphOf(r, ink)
      const cells = single
        ? compactBoardRowText({ title: r.title, stateWord: stateWordOf(r), ageLabel: r.ageLabel }, isSel, geo.list.inner, ' ')
        : { ...compactListRowText(r, isSel, geo.list.inner, ' '), state: '', age: '' }
      out.push(
        <Box key={r.sessionId} height={1} flexShrink={0} overflow="hidden">
          <InteractiveRow
            id={`concourse:compact:row:${r.sessionId}`}
            selected={isSel}
            focused={region === 'list'}
            onSelect={() => wiring.selectSession(r.sessionId)}
            onActivate={() => wiring.activateSession(r.sessionId)}
            flexGrow={1}
          >
            <Box flexGrow={1} overflow="hidden">
              <Text wrap="truncate-end">
                <Text color={isSel ? (region === 'list' ? t.info : t.textPrimary) : t.textMuted}>{cells.lead.slice(0, 3)}</Text>
                {glyph}
                <Text> </Text>
                <Text color={isSel ? t.textPrimary : t.textSecondary} bold={isSel}>
                  {cells.name}
                </Text>
              </Text>
            </Box>
            {cells.state.length > 0 ? (
              <Box flexShrink={0} overflow="hidden">
                <Text>
                  <Text color={ink}>{` ${cells.state}`}</Text>
                  <Text color={t.textInstruction}>{` ${cells.age} `}</Text>
                </Text>
              </Box>
            ) : null}
          </InteractiveRow>
        </Box>,
      )
    }
    if (win.moreRow > 0) {
      out.push(
        <Box key="more" height={1} flexShrink={0} overflow="hidden">
          <Text color={t.textMuted} wrap="truncate-end">
            {'   '}
            {win.above > 0 ? `↑ ${win.above} more` : ''}
            {win.above > 0 && win.below > 0 ? ' · ' : ''}
            {win.below > 0 ? `↓ ${win.below} more` : ''}
          </Text>
        </Box>,
      )
    }
    if (geo.newSessionRows > 0 && wiring.newSession !== undefined) {
      const door = wiring.newSession
      if (geo.newSessionRows === 2) out.push(<Box key="gap" height={1} flexShrink={0} />)
      out.push(
        <Box key="new" height={1} flexShrink={0} overflow="hidden">
          <InteractiveRow id="concourse:compact:new-session" directActivate hoverStyle="row-fill" onActivate={door} flexGrow={1}>
            {hover => (
              <Text color={hover ? t.textPrimary : t.info} wrap="truncate-end">
                {COMPACT_NEW_SESSION_ROW}
              </Text>
            )}
          </InteractiveRow>
        </Box>,
      )
    }
    out.push(<Box key="fill" flexGrow={1} />)
    return out
  }

  const composerNoteRows = composerNote !== null && geo.composerRows > 0 && geo.mirrorRows > 0 ? 1 : 0
  const mirrorRows = geo.mirrorRows - composerNoteRows
  const liveBody = (): React.ReactNode => (
    <>
      <Box height={mirrorRows} flexShrink={0} overflow="hidden" paddingX={1}>
        {mirrorRows > 0 ? mirrorNode(mirrorRows, Math.max(0, geo.live.inner - 2)) : null}
      </Box>
      {composerNoteRows > 0 ? (
        <Box height={1} flexShrink={0} overflow="hidden" paddingX={1}>
          <Text color={t.warning} dimColor wrap="truncate-end">
            {composerNote}
          </Text>
        </Box>
      ) : null}
      {geo.composerRows > 0 && liveComposerNode !== undefined ? (
        <Box height={geo.composerRows} flexShrink={0} overflow="hidden" paddingX={1}>
          {liveComposerNode(geo.composerBand, Math.max(0, geo.live.inner - 2))}
        </Box>
      ) : null}
      <Box flexGrow={1} />
    </>
  )

  const liveTitle = compactLiveTitle(selected !== undefined ? { title: selected.title, stateWord: stateWordOf(selected), ageLabel: selected.ageLabel } : undefined)

  if (profile === 'single') {
    if (showLive) {
      return (
        <Box flexDirection="column" width={cols} height={rows} overflow="hidden">
          <Frame span={geo.live} rows={rows} inner={geo.inner} title={liveTitle} focused={region === 'live'} onFocus={wiring.focusLive} id="concourse:compact:live-title">
            {liveBody()}
            {geo.liveFootRows > 0 ? (
              <FootRow text={compactOpenedFoot({ reduced, verbsFire, draftHeld: liveDraftHeld })} note={note} filtering={false} filterText="" filterCaret={0} />
            ) : null}
          </Frame>
        </Box>
      )
    }
    return (
      <Box flexDirection="column" width={cols} height={rows} overflow="hidden">
        <Frame span={geo.list} rows={rows} inner={geo.inner} title={compactBoardTitle(sessionRows)} focused={region === 'list'} onFocus={wiring.focusList} id="concourse:compact:list-title">
          {listRows(true)}
          {geo.listFootRows > 0 ? (
            <FootRow
              text={compactBoardFoot(Math.max(0, geo.list.inner - 1), { filtering, newSessionDoor: wiring.newSession !== undefined })}
              note={filtering ? null : note}
              filtering={filtering}
              filterText={filterText}
              filterCaret={filterCaret}
            />
          ) : null}
        </Frame>
      </Box>
    )
  }

  return (
    <Box flexDirection="row" width={cols} height={rows} overflow="hidden">
      <Frame span={geo.list} rows={rows} inner={geo.inner} title={compactListTitle(sessionRows.length, filterText)} focused={region === 'list'} onFocus={wiring.focusList} id="concourse:compact:list-title">
        {listRows(false)}
        {geo.listFootRows > 0 ? (
          <FootRow text={compactListFoot({ filtering, reduced })} note={null} filtering={filtering} filterText={filterText} filterCaret={filterCaret} />
        ) : null}
      </Frame>
      <Box width={1} flexShrink={0} />
      <Frame span={geo.live} rows={rows} inner={geo.inner} title={liveTitle} focused={region === 'live'} onFocus={wiring.focusLive} id="concourse:compact:live-title">
        {liveBody()}
        {geo.liveFootRows > 0 ? (
          <FootRow text={compactLiveFoot({ verbsFire })} note={note} filtering={false} filterText="" filterCaret={0} />
        ) : null}
      </Frame>
    </Box>
  )
}
