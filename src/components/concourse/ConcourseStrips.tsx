import React from 'react';
import { Box, Text, paletteCollapsed, useTheme } from '../../ink.js';
import { useBlink } from '../../hooks/useBlink.js';
import { critterDefForKey } from '../../utils/cockpit/critterData.js';
import { GLYPH } from '../../utils/glyphs.js';
import { keyHintLabel } from '../mercury-ui/keyHintLabel.js';
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js';
import { ReadyBreath } from '../mercury-ui/LiveGlyphs.js';
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { useLayoutChrome } from '../../context/layoutChromeContext.js';
import { composerBorderRole, composerBorderStyle } from '../mercury-ui/composerFloor.js';
import { getTheme } from '../../utils/theme.js';
import { effectiveSeatCeiling } from '../../daemon/concourseWorkers.js';
import { controlNoteOf, type ConcourseSnapshotV1 } from './contracts.js';
import { caretLens, draftLines, draftWindow, type LineDraft } from './lineDraft.js';
import { notBuilt } from '../../pi/holes.js'


export function ConcourseComposer(arg0: {
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
  return notBuilt('src/components/concourse/ConcourseStrips.tsx:19')
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
  const mark = critterDefForKey('jellyfish').mark;
  const { isCompact } = useLayoutChrome();
  const seatsCell = seatsCellText(seatDemandOf(snapshot), snapshot.counts.live, effectiveSeatCeiling());
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
        {!isCompact ? <Box flexShrink={0}>
          <Text>
            <Text color={t.infoText}>{mark.pre + mark.core + mark.post}</Text>
            <Text color={t.textMuted}> {GLYPH.sep} </Text>
          </Text>
        </Box> : null}
        {}
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
