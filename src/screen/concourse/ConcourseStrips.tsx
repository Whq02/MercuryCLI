import React from 'react';
import { Box, Text, paletteCollapsed, useTheme } from '../themedRenderer.js';
import { useBlink } from '../effects/useBlink.js';
import { GLYPH } from '../theme/glyphs.js';
import { keyHintLabel } from '../widgets/keyHintLabel.js';
import { InteractiveRow } from '../widgets/InteractiveRow.js';
import { ReadyBreath } from '../widgets/LiveGlyphs.js';
import { useMercuryTokens } from '../widgets/useMercuryTokens.js';
import { useTerminalSize } from '../fullscreen-layout/useTerminalSize.js';
import { composerBorderRole, composerBorderStyle } from '../widgets/composerFloor.js';
import { getShortNewlineInstructions } from '../composer/composerConfig.js';
import { getTheme } from '../theme/theme.js';
import { effectiveSeatCeiling } from '../../daemon/concourse-workers/concourseWorkers.js';
import { controlNoteOf, type ConcourseSnapshotV1 } from './contracts.js';
import { caretLens, draftLines, draftWindow, type LineDraft } from './lineDraft.js';


export function ConcourseComposer({
  width,
  bandRows,
  focused,
  draft,
  pending,
  note,
  restHint,
  contextLine,
  onComposerClick,
  composerNote,
  keysHint,
  minimal = false,
  foot = true,
}: {
  width: number
  bandRows: number
  focused: boolean
  draft: LineDraft
  pending: boolean
  note: { tone: 'muted' | 'warning'; text: string } | null
  restHint: string
  contextLine?: { tone: 'warning' | 'info'; text: string } | null
  onComposerClick?: (visibleRow: number, col: number) => void
  composerNote?: import('./contracts.js').ControlNoteState
  keysHint?: string
  minimal?: boolean
  foot?: boolean
}): React.ReactNode {
  const t = useMercuryTokens()
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const { rows: termRows } = useTerminalSize()
  const empty = draft.text.length === 0
  const [, caretPhaseOn] = useBlink(focused)
  const borderColor = focused ? theme[composerBorderRole(empty)] : t.borderStrong
  const style = composerBorderStyle(termRows)

  const lines = draftLines(draft)
  const caretBudget = minimal ? Math.max(0, width) : Math.max(16, width - 14)
  const { windowStart, windowRows, hiddenAbove, hiddenBelow } = draftWindow(draft, bandRows)
  if (minimal) {
    const count = Math.max(0, Math.min(3, bandRows))
    const start = Math.max(0, Math.min(lines.caretLine - Math.floor(count / 2), lines.lines.length - count))
    return <Box flexDirection="column" width={Math.max(0, width)} height={count} overflow="hidden" onClick={onComposerClick ? e => onComposerClick(e.localRow, e.localCol) : undefined}>
      {lines.lines.slice(start, start + count).map((line, i) => {
        const lens = caretLens({ text: line, caret: lines.caretCol }, caretBudget)
        return <Text key={start + i} wrap="truncate-end" color={t.accentSoft}>{focused && start + i === lines.caretLine ? <>{lens.before}<Text inverse={caretPhaseOn}>{lens.at || ' '}</Text>{lens.after}</> : line}</Text>
      })}
    </Box>
  }

  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      {...(style !== undefined ? { borderStyle: paletteCollapsed() && focused ? 'bold' : style } : {})}
      borderColor={paletteCollapsed() && focused ? t.info : borderColor}
      paddingX={1}
      width={width}
      overflow="hidden"
    >
      <Box
        flexDirection="column"
        flexShrink={0}
        {...(onComposerClick !== undefined
          ? {
              onClick: (e: { localCol: number; localRow: number }) =>
                onComposerClick(Math.max(0, e.localRow), Math.max(0, e.localCol - 2)),
            }
          : {})}
      >
        {hiddenAbove > 0 ? (
          <Text color={t.textMuted} wrap="truncate-end">{`  … +${hiddenAbove} earlier line${hiddenAbove === 1 ? '' : 's'}`}</Text>
        ) : null}
        {lines.lines.slice(windowStart, windowStart + windowRows).map((line, wi) => {
          const li = windowStart + wi
          const isCaretLine = li === lines.caretLine
          const lead =
            li === 0 ? (
              <ReadyBreath deep={t.accentSoft} to={t.accent} active={focused && empty && !pending}>
                <Text color={t.accent}>{GLYPH.prompt} </Text>
              </ReadyBreath>
            ) : (
              <Text>{'  '}</Text>
            )
          if (empty && li === 0) {
            return (
              <Box key="rest" height={1} flexShrink={0}>
                <Text wrap="truncate-end">
                  {lead}
                  {focused ? <Text color={t.info}>{caretPhaseOn ? GLYPH.caretBlock : ' '}</Text> : null}
                  <Text color={t.textSecondary}>{restHint}</Text>
                  {}
                </Text>
              </Box>
            )
          }
          if (!isCaretLine || !focused) {
            return (
              <Box key={`cl${li}`} height={1} flexShrink={0}>
                <Text wrap="truncate-end">
                  {lead}
                  {}
                  <Text color={t.accentSoft}>{line}</Text>
                </Text>
              </Box>
            )
          }
          const lens = caretLens({ text: line, caret: lines.caretCol }, caretBudget)
          return (
            <Box key={`cl${li}`} height={1} flexShrink={0}>
              <Text wrap="truncate-end">
                {lead}
                {lens.clippedLeft ? <Text color={t.textMuted}>…</Text> : null}
                <Text color={t.accentSoft}>{lens.before}</Text>
                {caretPhaseOn ? (
                  <Text color={t.info}>{lens.at === '' ? GLYPH.caretBlock : lens.at}</Text>
                ) : (
                  <Text color={t.accentSoft}>{lens.at === '' ? ' ' : lens.at}</Text>
                )}
                <Text color={t.accentSoft}>{lens.after}</Text>
                {lens.clippedRight ? <Text color={t.textMuted}>…</Text> : null}
              </Text>
            </Box>
          )
        })}
        {hiddenBelow > 0 ? (
          <Text color={t.textMuted} wrap="truncate-end">{`  … +${hiddenBelow} more line${hiddenBelow === 1 ? '' : 's'}`}</Text>
        ) : null}
      </Box>
      {foot ? (
      <Box height={1} overflow="hidden">
        {contextLine !== null && contextLine !== undefined ? (
          <Box flexGrow={1} overflow="hidden">
            <Text color={contextLine.tone === 'warning' ? t.warning : t.infoText} wrap="truncate-end">
              {contextLine.text}
            </Text>
          </Box>
        ) : composerNote !== undefined ? (
          (() => {
            const n = controlNoteOf(composerNote)
            const why = n.reason !== undefined ? ` — ${n.reason.slice(0, 64)}` : ''
            const nxt = n.next !== undefined ? ` · ${n.next}` : ''
            const color =
              n.state === 'pending' ? t.textInstruction
              : n.state === 'applied' ? t.success
              : n.state === 'held' ? t.warning
              : t.failureText
            const label =
              n.state === 'pending' ? 'pending…'
              : n.state === 'applied' ? `${GLYPH.ok} applied${why}`
              : n.state === 'held' ? `${GLYPH.pending} held${why}${nxt}`
              : n.state === 'failed' ? `${GLYPH.fail} failed${why}${nxt}`
              : `${GLYPH.fail} refused${why}${nxt}`
            return (
              <Box flexGrow={1} overflow="hidden">
                <Text color={color} wrap="truncate-end">{label}</Text>
              </Box>
            )
          })()
        ) : note !== null ? (
          <Box flexGrow={1} overflow="hidden">
            {}
            <Text color={note.tone === 'warning' ? t.warning : t.textMuted} wrap="truncate-middle">
              {note.text}
            </Text>
          </Box>
        ) : (
          <Box flexGrow={1} overflow="hidden">
            <Text color={t.textMuted} wrap="truncate-end">
              {}
              {focused ? keyHintLabel(keysHint ?? `↵ send · ${getShortNewlineInstructions().startsWith('shift') ? '⇧↵' : '⌃j'} newline · tab panes`) : ''}
            </Text>
          </Box>
        )}
        {}
      </Box>
      ) : null}
    </Box>
  );
}

export function seatDemandOf(snapshot: ConcourseSnapshotV1): number {
  const queuedForSeat = snapshot.groups
    .flatMap(g => g.rows)
    .filter(r => r.state === 'queued' && (r.waitReason === undefined || r.waitReason === 'seat')).length
  return snapshot.counts.live + queuedForSeat
}

export function seatsCellText(demanded: number, live: number, ceiling: number): { text: string; over: boolean } {
  const over = demanded > ceiling
  return { text: `${over ? demanded : live}/${ceiling}`, over }
}

export function ConcourseStatusRail({
  snapshot,
  width,
  onOpenGround,
  groundPickerOpen = false,
}: {
  snapshot: ConcourseSnapshotV1
  width: number
  onOpenGround?: () => void
  groundPickerOpen?: boolean
}): React.ReactNode {
  const t = useMercuryTokens();
  const seatsCell = seatsCellText(seatDemandOf(snapshot), snapshot.counts.live, effectiveSeatCeiling());
  return (
    <Box
      flexShrink={0}
      overflow="hidden"
      width={width}
      height={1}
    >
      <Box flexShrink={1} overflow="hidden" flexDirection="row">
        <InteractiveRow
          id="concourse:rail:project"
          directActivate
          hoverStyle="chrome-ink"
          {...(onOpenGround ? { onActivate: onOpenGround } : {})}
          flexShrink={1}
        >
          {hover => (
            <Text
              wrap="truncate-end"
              color={groundPickerOpen ? t.textInverse : hover ? 'infoShimmer' : t.textSecondary}
              bold={groundPickerOpen}
              {...(groundPickerOpen ? { backgroundColor: t.accentSoft } : {})}
            >
              {snapshot.context.projectLabel} {GLYPH.chevronDown}
            </Text>
          )}
        </InteractiveRow>
      </Box>
      <Box flexGrow={1} />
      <Box flexShrink={0} marginLeft={1}>
        <Text color={seatsCell.over ? t.warning : t.textSecondary}>{seatsCell.text} seats</Text>
      </Box>
    </Box>
  );
}
