import React from 'react';
import { Box, Text, paletteCollapsed } from '../../ink.js';
import { shedToFit } from '../mercury-ui/geometry.js';
import { displayWidth, GLYPH, truncateToWidth } from '../mercury-ui/glyphs.js';
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js';
import { paneWindow } from '../mercury-ui/paneWindow.js';
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js';
import type { ConcourseSnapshotV1 } from './contracts.js';

// ============================================================================
// NeedsYouRail — the full-width AMBER attention card (design-layout
//  r5-r9): the consent-card 'warning' role pattern composed from Box +
//  InteractiveRow + tokens — a consumer of the role system, never a new one.
//  Amber is reserved for operator attention; the rows are the durable
//  obligations oldest-first. ↵ on the focused row = answer &
//  resume; 'o' = open without resolving (the row actions ride the screen's
//  region focus — the rail's list instance gates on region === 'rail').
// ============================================================================

export const RAIL_MAX_ROWS = 3;

/** One colored run inside a rail-row tail part (seps stay muted while the
 * labels carry their own tone — the role table, not literal hexes). */
export interface RailTailChunk {
  text: string
  tone: 'muted' | 'affordance-primary' | 'affordance'
}

export interface RailTailPart {
  key: 'meta' | 'answer' | 'open' | 'dismiss'
  /** shedToFit keepability — higher survives longer. The METADATA yields
   *  before any AFFORDANCE (B2: a row that can still be acted on but no
   *  longer says how is worse than one missing its age). */
  priority: number
  /** The part's full text (width truth for shedToFit). */
  text: string
  chunks: RailTailChunk[]
}

/** B2: the rail row's tail — metadata + the affordances —
 *  sheds by DECLARED priority through the shared shedToFit owner instead of
 *  the wrap's blind truncate-end (which ate the affordances FIRST, being
 *  rightmost). Pure and exported so the prover pins the shed ORDER: meta
 *  drops first, then open; 'answer & resume' survives to the last. The
 *  visible affordance set is the REFERENCE's exactly — 'answer & resume'
 *  and 'open'; the old foreign 'claim' chip is retired (
 * the V2 reference carries no claim action). */
export function railTailParts(
  o: { projectLabel: string; agentLabel: string; ageLabel: string },
  budget: number,
  /** THE CROSS-PROJECT DOOR (law 5): the row's need lives in another
   *  project — its one affordance is 'switch & open' (↵ / o), the typed
   *  answer stays in the chat it opens. */
  door = false,
): RailTailPart[] {
  const part = (key: RailTailPart['key'], priority: number, chunks: RailTailChunk[]): RailTailPart => ({
    key,
    priority,
    text: chunks.map(c => c.text).join(''),
    chunks,
  });
  const parts: RailTailPart[] = [
    // The reference's meta cluster stands alone at its band — the interior
    // dots stay, the leading joiner does not (the head is band-aligned).
    // meta = project · age (the agent-handle segment retired with
    // the word-ban); 'open session' says what actually opens — after W2 it
    // is the full one-terminal swap, and the operator should see it coming.
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
    // Operator finding 3: a visible dismiss — a notice you can
    // always clear by hand. Outranks 'open' in the shed order (priority
    // 3.5): a row you can act on but not clear was the exact pain.
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
  /** (total-allocation): the budget owner may NARROW the window
   *  below RAIL_MAX_ROWS under viewport row pressure (never below 1; never
   *  above the cap) — the header count and ↑N/↓N markers stay the
   *  hidden-row truth at every window size. */
  maxRows?: number
  /** the inner rule is ornament — it sheds under extreme pressure
   *  (content rows outrank the hairline). */
  showRule?: boolean
  /** pointer semantics — row click selects; chip click settles the
   *  SAME typed action as its key (↵ answer & resume · o open). */
  onSelectRow?: (index: number) => void
  onAnswer?: (obligationId: string) => void
  onOpen?: (obligationId: string) => void
  /** Finding 3: '✕ dismiss' settles through the SAME withdraw owner as 'w'. */
  onDismiss?: (obligationId: string) => void
}): React.ReactNode {
  const t = useMercuryTokens();
  // The rail is a height-capped WINDOW that FOLLOWS
  // the cursor (paneWindow), so ↵ can never act on an obligation the
  // operator cannot see (the invisible-obligation class — the screen clamps
  // its index to the FULL list). The rail's height stays DECLARED to the
  // panes' chromeRows (min(N,3) rows, or the budget's narrower allowance —
  // an unbounded list would push the bottom chrome off-canvas), so the
  // hidden-row truth rides the header line at zero extra height: the count
  // is the TOTAL, ↑N/↓N are the exact hidden counts (the paneWindow
  // indicator vocabulary).
  const total = snapshot.needsYou.length;
  const win = paneWindow(total, selectedIndex, Math.max(1, Math.min(RAIL_MAX_ROWS, maxRows)));
  const rows = snapshot.needsYou.slice(win.start, win.end);
  if (rows.length === 0) return null;
  return (
    // width is the COMPUTED interior — %-width resolves against the parent's
    // full width in this ink, so every framed "100%" strip overhung the
    // canvas by the shell padding and lost its right border (the
    // reference closes every frame).
    <Box
      flexDirection="column"
      flexShrink={0}
      // the bold border SHAPE carries rail focus where a collapsed
      // palette cannot (colour modes keep the amber attention grammar + the
      // focused row's selection band).
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
      {/* The reference's inner rule under the heading:
          sheds under extreme viewport pressure (ornament yields last). */}
      {showRule ? (
        <Box height={1} flexShrink={0} overflow="hidden">
          <Text color={t.borderSubtle}>{'─'.repeat(Math.max(1, width - 4))}</Text>
        </Box>
      ) : null}
      {(() => {
        // B2: the tail sheds by declared priority (meta before affordances)
        // against the row's REAL remaining budget. The head is BAND-aligned
        // per the reference: the title and question sit at column
        // bands SHARED by every visible row — never a dotted run — and the
        // interior is the rail's width minus its border+padding (4).
        // The bands fit the window's widest CONTENT (floor 14/18, ceiling
        // the old width shares): the fixed 27%/34% shares reserved ~19
        // blank columns beside short titles while shedToFit starved the
        // affordances out of the tail (a row that sheds 'open
        // session' beside dead space says the budget, not the content, was
        // wrong).
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
