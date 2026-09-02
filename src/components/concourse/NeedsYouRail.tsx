import React from 'react';
import { Box, Text, paletteCollapsed } from '../../ink.js';
import { shedToFit } from '../mercury-ui/geometry.js';
import { displayWidth, GLYPH, truncateToWidth } from '../mercury-ui/glyphs.js';
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js';
import { paneWindow } from '../mercury-ui/paneWindow.js';
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js';
import type { ConcourseSnapshotV1 } from './contracts.js';


export const RAIL_MAX_ROWS = 3;

export interface RailTailChunk {
  text: string
  tone: 'muted' | 'affordance-primary' | 'affordance'
}

export interface RailTailPart {
  key: 'meta' | 'answer' | 'open' | 'dismiss'
  priority: number
  text: string
  chunks: RailTailChunk[]
}

export function railTailParts(
  o: { projectLabel: string; agentLabel: string; ageLabel: string },
  budget: number,
  door = false,
): RailTailPart[] {
  const part = (key: RailTailPart['key'], priority: number, chunks: RailTailChunk[]): RailTailPart => ({
    key,
    priority,
    text: chunks.map(c => c.text).join(''),
    chunks,
  });
  const parts: RailTailPart[] = [
    part('meta', 1, [{ text: `${o.projectLabel} · ${o.ageLabel}`, tone: 'muted' }]),
    part('answer', 4, [
      { text: ` ${GLYPH.sep} `, tone: 'muted' },
      { text: door ? 'switch & open' : 'answer & resume', tone: 'affordance-primary' },
    ]),
    ...(door
      ? []
      : [
          part('open', 3, [
            { text: ` ${GLYPH.sep} `, tone: 'muted' },
            { text: 'open session', tone: 'affordance' },
          ]),
        ]),
    part('dismiss', 3.5, [
      { text: ` ${GLYPH.sep} `, tone: 'muted' },
      { text: '✕ dismiss', tone: 'affordance' },
    ]),
  ];
  return shedToFit(parts, budget, '');
}

export function NeedsYouRail({
  snapshot,
  focused,
  selectedIndex,
  width,
  maxRows = RAIL_MAX_ROWS,
  showRule = true,
  onSelectRow,
  onAnswer,
  onOpen,
  onDismiss,
}: {
  snapshot: ConcourseSnapshotV1
  focused: boolean
  selectedIndex: number
  width: number
  maxRows?: number
  showRule?: boolean
  onSelectRow?: (index: number) => void
  onAnswer?: (obligationId: string) => void
  onOpen?: (obligationId: string) => void
  onDismiss?: (obligationId: string) => void
}): React.ReactNode {
  const t = useMercuryTokens();
  const total = snapshot.needsYou.length;
  const win = paneWindow(total, selectedIndex, Math.max(1, Math.min(RAIL_MAX_ROWS, maxRows)));
  const rows = snapshot.needsYou.slice(win.start, win.end);
  if (rows.length === 0) return null;
  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      borderStyle={paletteCollapsed() && focused ? 'bold' : 'round'}
      borderColor={t.warning}
      paddingX={1}
      width={width}
      overflow="hidden"
    >
      <Box height={1} overflow="hidden">
        <Text>
          <Text color={t.warning} bold>
            {GLYPH.mission} NEEDS YOU
          </Text>
          <Text color={t.textSecondary}> · {total}</Text>
          {win.above > 0 ? <Text color={t.textMuted}> · ↑{win.above}</Text> : null}
          {win.below > 0 ? <Text color={t.textMuted}> · ↓{win.below}</Text> : null}
        </Text>
      </Box>
      {
}
      {showRule ? (
        <Box height={1} flexShrink={0} overflow="hidden">
          <Text color={t.borderSubtle}>{'─'.repeat(Math.max(1, width - 4))}</Text>
        </Box>
      ) : null}
      {(() => {
        const titleBand = Math.min(
          Math.max(14, Math.floor(width * 0.27)),
          Math.max(14, ...rows.map(o => displayWidth(o.title) + 3)),
        );
        const questionBand = Math.min(
          Math.max(18, Math.floor(width * 0.34)),
          Math.max(18, ...rows.map(o => displayWidth(o.question) + 1)),
        );
        return rows.map((o, i) => {
        const title = truncateToWidth(o.title, titleBand - 3);
        const question = truncateToWidth(o.question, questionBand - 1);
        const tail = railTailParts(o, Math.max(0, width - 4 - titleBand - questionBand), o.foreignProject !== undefined);
        const chunkText = (p: RailTailPart, keyPrefix: string): React.ReactNode =>
          p.chunks.map((c, ci) =>
            c.tone === 'affordance-primary' ? (
              <Text key={`${keyPrefix}-${ci}`} color={t.warning} bold>
                {c.text}
              </Text>
            ) : c.tone === 'affordance' ? (
              <Text key={`${keyPrefix}-${ci}`} color={t.textSecondary}>{c.text}</Text>
            ) : (
              <Text key={`${keyPrefix}-${ci}`} color={t.textMuted}>{c.text}</Text>
            ),
          );
        const meta = tail.find(p => p.key === 'meta');
        const answer = tail.find(p => p.key === 'answer');
        const openPart = tail.find(p => p.key === 'open');
        const dismissPart = tail.find(p => p.key === 'dismiss');
        return (
          <Box key={o.obligationId} height={1} width={width - 4} overflow="hidden">
            <InteractiveRow
              id={`concourse:rail:${o.obligationId}`}
              selected={win.start + i === selectedIndex}
              focused={focused}
              {...(onSelectRow ? { onSelect: () => onSelectRow(win.start + i) } : {})}
              flexShrink={1}
            >
              <Box width={titleBand} flexShrink={0} overflow="hidden">
                <Text wrap="truncate-end">
                  <Text color={t.warning}>{GLYPH.mission} </Text>
                  <Text color={t.textPrimary} bold>
                    {title}
                  </Text>
                </Text>
              </Box>
              <Box width={questionBand} flexShrink={0} overflow="hidden">
                <Text color={t.textSecondary} wrap="truncate-end">
                  {question}
                </Text>
              </Box>
              {meta ? <Text wrap="truncate-end">{chunkText(meta, 'meta')}</Text> : null}
            </InteractiveRow>
            <Box flexGrow={1} />
            {answer ? (
              <InteractiveRow
                id={`concourse:rail:${o.obligationId}:answer`}
                directActivate
                {...(onAnswer ? { onActivate: () => onAnswer(o.obligationId) } : {})}
                flexShrink={0}
              >
                <Text>{chunkText(answer, 'answer')}</Text>
              </InteractiveRow>
            ) : null}
            {openPart ? (
              <InteractiveRow
                id={`concourse:rail:${o.obligationId}:open`}
                directActivate
                {...(onOpen ? { onActivate: () => onOpen(o.obligationId) } : {})}
                flexShrink={0}
              >
                <Text>{chunkText(openPart, 'open')}</Text>
              </InteractiveRow>
            ) : null}
            {dismissPart ? (
              <InteractiveRow
                id={`concourse:rail:${o.obligationId}:dismiss`}
                directActivate
                {...(onDismiss ? { onActivate: () => onDismiss(o.obligationId) } : {})}
                flexShrink={0}
              >
                <Text>{chunkText(dismissPart, 'dismiss')}</Text>
              </InteractiveRow>
            ) : null}
          </Box>
        );
        });
      })()}
    </Box>
  );
}
