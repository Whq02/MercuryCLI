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

// ============================================================================
//  ConcourseComposer — THE composer-family box (the shared replFloor
//  ladder, the estate caret + blink, the meta row). TWO MOUNTS since the
//  two-composers law (L17 item 1): the COORDINATOR pane's own composer at
//  its foot (its REPL when on, the self-managed launcher when off), and
//  the LIVE pane's small composer (words to the SELECTED row, delivered
//  through session.redirect — the delivery law). The full-width strip mount RETIRED whole;
//  the waiting room keeps its own mount. One component, one owner per
//  pane, never a second input widget.
//
//  ConcourseStatusRail — the ONE always-on home for global facts
// left = mark │ coordinator identity │ project; right =
//  "N live · N needs you · N/<the machine's reading> seats". The old seats-formula and the
//  tri-state mode vocabulary are deleted.
// ============================================================================

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
  /** The computed shell interior (the %-width overhang law). */
  width: number
  /** The GRANTED draft band (geometry's stripDraftRows) — the strip paints
   *  EXACTLY this many draft-band rows through the one draftWindow owner,
   *  so its height always equals the budget (an unbudgeted indicator row
   *  pushed the panes above it out of their bands). */
  bandRows: number
  focused: boolean
  /** The screen's LOCAL multiline echo (batch-safe lineDraft). */
  draft: LineDraft
  /** The coordinator's turn is running (WorkingGlyph — one liveness law). */
  pending: boolean
  /** CU-06: visible send feedback — never a silent restore. */
  note: { tone: 'muted' | 'warning'; text: string } | null
  /** the mode-scoped rest hint (the only place the operator learns
   *  what this box does without trying). */
  restHint: string
  /** The answer/permission context row ("answer · <question> · ↵ delivers
   *  & resumes · esc") — replaces the meta row's left half while armed. */
  contextLine?: { tone: 'warning' | 'info'; text: string } | null
  /** Click-to-caret (IP-4, the pointer half): visible draft row + column. */
  onComposerClick?: (visibleRow: number, col: number) => void
  /** the five-state receipt beside the composer. */
  composerNote?: import('./contracts.js').ControlNoteState
  /** MANAGER MODE's visible wear (ledger T7 — "the composer wears the mode"):
   *  the modeBand grammar's one-row badge above the draft, in the pane's own
   *  ink. Absent ⇒ byte-identical composer. */
  modeBand?: { symbol: string; label: string }
  /** The meta row's key hint while focused — every printed key must be true
   *  (the glyph pass law), so a mount whose keys differ says its own. */
  keysHint?: string
}): React.ReactNode {
  const t = useMercuryTokens()
  const [theme] = useTheme()
  const { rows: termRows } = useTerminalSize()
  const empty = draft.text.length === 0
  // The composer caret blinks on the estate's ONE clock (useBlink — the
  // same absolute-bucket phase the main chat's caret rides, so every
  // composer beats together; never a timer of its own). Armed only while
  // this strip holds focus; unfocused keeps the historical no-caret paint.
  // Width discipline: the off phase paints a same-width cell (space for the
  // block, the neighbour ink for a covered character) — a blink must never
  // shift the row.
  const [, caretPhaseOn] = useBlink(focused)
  // The shared replFloor ladder: resting border when empty, identity on the
  // first composed character; the frame sheds on critically short terminals.
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
        // The modeBand grammar (the main chat's footer badge, sized for the
        // pane): one row, seal + label, the concourse's own info ink — the
        // composer visibly wears its mode without stealing the focus
        // border's meaning.
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
              // ❯ breathes only at genuine ready-idle; typing and
              // pending settle it (frame-0 static under reduced motion).
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
                  {/* Item 6: the turn-in-flight token lives in the
                      coordinator pane (the main chat's placement — above
                      the composer, transcript side); the strip's inline
                      'thinking…' retired so the fact paints once. */}
                </Text>
              </Box>
            )
          }
          if (!isCaretLine || !focused) {
            return (
              <Box key={`cl${li}`} height={1} flexShrink={0}>
                <Text wrap="truncate-end">
                  {lead}
                  {/* input→echo identity — typed text wears the
                      operator's nameplate ink in both transcripts. */}
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
          {/* THE META-ROW SLOT LAW: one slot, three claimants — the broadcast
              arm (contextLine) on top, a card's SELF-EXPIRING receipt next,
              the derived composer hint last. The hint stands on every door
              row ('a door — ↵ opens it'), so a receipt painted beneath it
              was never seen — the card's own answer ('✗ refused — …') is
              the one line the operator must read. */}
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
            {/* Truncate the MIDDLE, the house's own
                actionable-note law (CoordinatorPane's precedent: "the head
                keeps what · why, the tail keeps THE fix") — end-truncation
                in a ~38-col pane gave the operator the problem without the
                "⌃s picks one" tail. The row stays height-1 (the ruled
                strip band is untouched). */}
            <Text color={note.tone === 'warning' ? t.warning : t.textMuted} wrap="truncate-middle">
              {note.text}
            </Text>
          </Box>
        ) : (
          <Box flexGrow={1} overflow="hidden">
            <Text color={t.textMuted} wrap="truncate-end">
              {/* THE PLATFORM SEAM (class 5): the composer hints — the
                  screen's authored keysHint or this fallback — paint in the
                  host's spelling; identity on macOS. */}
              {focused ? keyHintLabel(keysHint ?? '↵ send · ⇧↵ newline · tab panes') : 'tab or click to type'}
            </Text>
          </Box>
        )}
        {/* Operator-ruled (the dedup): the strip carries NO
            model chip — the status rail's coordinator segment is the ONE
            painted AND clickable selector. */}
      </Box>
    </Box>
  );
}

/** THE SEAT-OVERLOAD CHIP (board controls, item 4): the DEMANDED seats —
 *  the live sessions plus every dispatch queued for a seat (the operator
 *  consented past the reading; their demand is real). While demanded runs
 *  past the machine reading the rail's seats cell reads `5/4·` — the
 *  trailing mark is the over sign, warning ink — and returns to the plain
 *  `live/reading` the moment the demand fits again. One pure fold; the
 *  pins read it. */
export function seatDemandOf(snapshot: ConcourseSnapshotV1): number {
  const queuedForSeat = snapshot.groups
    .flatMap(g => g.rows)
    .filter(r => r.state === 'queued' && (r.waitReason === undefined || r.waitReason === 'seat')).length
  return snapshot.counts.live + queuedForSeat
}

/** The seats cell's one spelling — over wears the mark, under stays plain. */
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
  /** Operator-ruled: the rail's coordinator segment IS the model
   *  selector — click (or ⌃s) opens the coordinator model picker. */
  onOpenModel?: () => void
  modelPickerOpen?: boolean
  /** Drive 6b (the ground law): the rail's PROJECT segment IS the repo
   *  selector — click opens the ground picker; the harness follows live. */
  onOpenGround?: () => void
  groundPickerOpen?: boolean
}): React.ReactNode {
  const t = useMercuryTokens();
  // SR-064's no-substitution law: the rail leads with the fixed BRAND mark.
  const mark = critterDefForKey('jellyfish').mark;
  const counts = snapshot.counts;
  // the rail's left cluster is the COORDINATOR's identity — the one
  // always-on model location, with the owner word inside the label.:
  // operator vocabulary is on/off ('rules-only' is the off posture's
  // internal rail — it paints as off).
  // A chosen model that is not ready paints in warning ink with its state
  // WORD beside the name when the rail has room for it, else the warn glyph
  // alone (the picker behind ⌃s and the switch receipt spell the whole
  // label). The budget is the rail's own: the brand mark, the counts cell
  // and (at ≥96 columns) the project segment's floor are fixed; the chip
  // never shrinks, so it must never claim what the counts need.
  // Item 4's over mark rides the SAME cell (and the same budget line).
  const seatsCell = seatsCellText(seatDemandOf(snapshot), counts.live, effectiveSeatCeiling());
  const countsText = `${counts.live} live · ${needsYouCount(counts.needsYou)} · ${seatsCell.text} seats`;
  const chipBudget = width - 4 - 8 - (countsText.length + 1) - (width >= 96 ? 12 : 0);
  // THE STATUS LINE READS role · model, NOTHING MORE (the verdict-word
  // removal, operator-ruled): no availability word, no warn glyph — the
  // credential/catalogue truth still drives the INK, and the picker behind
  // ⌃s plus the switch receipt spell the whole label.
  const assistNotReady = snapshot.coordinator.assistModelAvailability !== undefined;
  // G1 (overflow integrity): the chip is flexShrink=0 by design (the model
  // name never shears mid-word) — so ITS text must respect the budget: an
  // unbounded fallbackReason once pushed the project segment and the
  // counts off the rail. One clamp, the honest ellipsis.
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
        {/* The ONE model surface (operator dedup ruling): painted here,
            clickable here — chrome-ink hover, ⌄ affordance, click ≡ ⌃s. */}
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
            {/* Drive 6b: the project segment is the REPO SELECTOR — same
                chrome-ink click grammar as the model segment beside it. */}
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
        {/* the ONE home for the global counts — the 5-lease is
            the only seat vocabulary on the screen. */}
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
