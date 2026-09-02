import React from 'react';
import { Box, Text, paletteCollapsed, useTheme } from '../../ink.js';
import { useBlink } from '../../hooks/useBlink.js';
import { critterDefForKey } from '../../utils/cockpit/critterData.js';
import { GLYPH, truncateToWidth } from '../mercury-ui/glyphs.js';
import { keyHintLabel } from '../mercury-ui/keyHintLabel.js';
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js';
import { ReadyBreath } from '../mercury-ui/LiveGlyphs.js';
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { composerBorderRole, composerBorderStyle } from '../mercury-ui/replFloor.js';
import { effectiveSeatCeiling } from '../../daemon/concourseSupervisor.js';
import { needsYouCount } from '../../utils/needsYouCount.js';
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
  modeBand,
  keysHint,
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
  modeBand?: { symbol: string; label: string }
  keysHint?: string
}): React.ReactNode {
  const t = useMercuryTokens()
  const [theme] = useTheme()
  const { rows: termRows } = useTerminalSize()
  const empty = draft.text.length === 0
  const [, caretPhaseOn] = useBlink(focused)
  const borderRole = composerBorderRole(empty)
  const borderColor = focused
    ? ((theme as unknown as Record<string, string>)[borderRole] ?? t.info)
    : t.borderStrong
  const style = composerBorderStyle(termRows)

  const lines = draftLines(draft)
  const caretBudget = Math.max(16, width - 14)
  const { windowStart, windowRows, hiddenAbove, hiddenBelow } = draftWindow(draft, bandRows)

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
      {modeBand !== undefined ? (
        <Box height={1} flexShrink={0} overflow="hidden">
          <Text color={t.infoText} wrap="truncate-end">
            {modeBand.symbol} {modeBand.label}
          </Text>
        </Box>
      ) : null}
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
                  {
}
                </Text>
              </Box>
            )
          }
          if (!isCaretLine || !focused) {
            return (
              <Box key={`cl${li}`} height={1} flexShrink={0}>
                <Text wrap="truncate-end">
                  {lead}
                  {
}
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
      <Box height={1} overflow="hidden">
        {contextLine !== null && contextLine !== undefined ? (
          <Box flexGrow={1} overflow="hidden">
            <Text color={contextLine.tone === 'warning' ? t.warning : t.infoText} wrap="truncate-end">
              {contextLine.text}
            </Text>
          </Box>
        ) : composerNote !== undefined ? (
          {
}
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
            {
}
            <Text color={note.tone === 'warning' ? t.warning : t.textMuted} wrap="truncate-middle">
              {note.text}
            </Text>
          </Box>
        ) : (
          <Box flexGrow={1} overflow="hidden">
            <Text color={t.textMuted} wrap="truncate-end">
              {
}
              {focused ? keyHintLabel(keysHint ?? '↵ send · ⇧↵ newline · tab panes') : 'tab or click to type'}
            </Text>
          </Box>
        )}
        {
}
      </Box>
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
  return { text: over ? `${demanded}/${ceiling}·` : `${live}/${ceiling}`, over }
}

export function ConcourseStatusRail({
  snapshot,
  width,
  onOpenModel,
  modelPickerOpen = false,
  onOpenGround,
  groundPickerOpen = false,
}: {
  snapshot: ConcourseSnapshotV1
  width: number
  onOpenModel?: () => void
  modelPickerOpen?: boolean
  onOpenGround?: () => void
  groundPickerOpen?: boolean
}): React.ReactNode {
  const t = useMercuryTokens();
  const mark = critterDefForKey('jellyfish').mark;
  const counts = snapshot.counts;
  const seatsCell = seatsCellText(seatDemandOf(snapshot), counts.live, effectiveSeatCeiling());
  const countsText = `${counts.live} live · ${needsYouCount(counts.needsYou)} · ${seatsCell.text} seats`;
  const chipBudget = width - 4 - 8 - (countsText.length + 1) - (width >= 96 ? 12 : 0);
  const assistNotReady = snapshot.coordinator.assistModelAvailability !== undefined;
  const coordinatorRun =
    snapshot.coordinator.fallbackReason !== undefined
      ? {
          color: t.warning,
          text: truncateToWidth(`coordinator · ${snapshot.coordinator.fallbackReason}`, Math.max(16, chipBudget)),
        }
      : snapshot.coordinator.mode === 'agent-assisted'
        ? {
            color: assistNotReady ? t.warning : t.infoText,
            text: truncateToWidth(
              `coordinator · ${snapshot.coordinator.assistModelLabel ?? 'pick a model'}`,
              Math.max(16, chipBudget),
            ),
          }
        : { color: t.textInstruction, text: 'coordinator off' };
  return (
    <Box
      flexShrink={0}
      overflow="hidden"
      width={width}
      borderStyle="round"
      borderColor={t.borderStrong}
      paddingX={1}
      height={3}
    >
      <Box flexShrink={1} overflow="hidden" flexDirection="row">
        <Box flexShrink={0}>
          <Text>
            <Text color={t.infoText}>{mark.pre + mark.core + mark.post}</Text>
            <Text color={t.textMuted}> {GLYPH.sep} </Text>
          </Text>
        </Box>
        {
}
        <InteractiveRow
          id="concourse:rail:coordinator-model"
          directActivate
          hoverStyle="chrome-ink"
          {...(onOpenModel ? { onActivate: onOpenModel } : {})}
          flexShrink={0}
        >
          {hover => (
            <Text
              color={modelPickerOpen ? t.textInverse : hover ? 'infoShimmer' : coordinatorRun.color}
              bold={modelPickerOpen}
              {...(modelPickerOpen ? { backgroundColor: t.accentSoft } : {})}
            >
              {coordinatorRun.text} {GLYPH.chevronDown}
            </Text>
          )}
        </InteractiveRow>
        {width >= 96 ? (
          <Box flexShrink={1} overflow="hidden" flexDirection="row">
            <Text color={t.textMuted}> {GLYPH.sep} </Text>
            {
}
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
        ) : null}
      </Box>
      <Box flexGrow={1} />
      <Box flexShrink={0} marginLeft={1}>
        {
}
        <Text>
          <Text color={counts.live > 0 ? t.success : t.textSecondary}>{counts.live} live</Text>
          <Text color={t.textMuted}> · </Text>
          <Text color={counts.needsYou > 0 ? t.warning : t.textInstruction}>{needsYouCount(counts.needsYou)}</Text>
          <Text color={t.textMuted}> · </Text>
          <Text color={seatsCell.over ? t.warning : t.textSecondary}>
            {seatsCell.text} seats
          </Text>
        </Text>
      </Box>
    </Box>
  );
}
