import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, useAnimationValue, useInput } from '../../ink.js'
import ScrollBox, { type ScrollBoxHandle } from '../../ink/components/ScrollBox.js'
import { isXtermJs } from '../../ink/session/capabilities.js'
import { topOverlay } from '../../context/overlayStack.js'
import { useAppState, type AppState } from '../../state/AppState.js'
import { getTools } from '../../tools.js'
import type { RenderableMessage } from '../../types/message.js'
import type { Screen } from '../../screens/REPL.js'
import { EMPTY_STRING_SET } from '../../utils/messages.js'
import { liveGlyphsEnabled, WORK_TICK_MS } from '../../utils/cockpit/liveGlyphs.js'
import { hasContentAfterIndex, MessageRow } from '../MessageRow.js'
import { SentryErrorBoundary } from '../SentryErrorBoundary.js'
import { controlNoteOf, type ControlNoteState } from './contracts.js'
import { isAssistantContinuationRow } from '../Messages.js'
import {
  AttachedAttributionContext,
  NameplateAccentContext,
  NameplateContinuationContext,
} from '../messages/TranscriptNameplate.js'
import {
  computeWheelStep,
  initWheelAccel,
  readScrollSpeedBase,
  type WheelAccelState,
} from '../ScrollKeybindingHandler.js'
import { GLYPH, truncateToWidth } from '../mercury-ui/glyphs.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { WorkingGlyph } from '../mercury-ui/LiveGlyphs.js'
import { InteractiveRow } from '../mercury-ui/InteractiveRow.js'
import { pageStepRows } from '../mercury-ui/replFloor.js'
import { useSessionAccent } from '../mercury-ui/sessionAccent.js'
import { useMercuryTokens } from '../mercury-ui/useMercuryTokens.js'
import {
  deriveTranscriptRows,
  useCoordinatorAttribution,
  useWorkerTranscriptFold,
} from './workerTranscriptFold.js'
import { rememberSessionWarmth } from '../../services/concourse/sessionWarmth.js'
import { readSessionReceipts, type SessionReceiptEntry } from '../../services/switchboard/sessionReceipts.js'
import { getProjectDir } from '../../utils/sessionStorage/paths.js'

// ── the Receipt section (ledger T5–T6: READY-TO-REVIEW opens the trail) ─────
//
// The finished row's peek paints the session's receipt entries NEWEST-FIRST
// under the mirrored chat: the agent's own close as text (clipped honestly,
// the newest entry getting the deeper row), the machine floor's numbers in
// the fact-row grammar its summary already carries, a contract close as the
// contract estate wrote it. The section exists only when entries exist —
// no empty chrome — and reuses the peek's own grammar (Text rows, GLYPH.dot,
// muted/secondary inks); the row's existing open door is the only door.

const RECEIPT_ENTRIES_SHOWN = 4

/** The section's paint plan — GEOMETRY-DERIVED from the pane it was given,
 *  never an assumed frame (the pane around this section is being reshaped
 *  by its own lanes): the section takes at most a third of the pane's rows
 *  (cap 6), needs the 2-row minimum (header + one entry) to exist at all,
 *  grants the newest agent-close its deep row only where it fits, and adds
 *  the "+N older" row only where IT fits — the header's count is the total
 *  either way, so nothing hidden is ever uncounted. */
function planReceiptSection(
  entryCount: number,
  firstIsAgentClose: boolean,
  paneRows: number,
): { shown: number; deepFirst: boolean; olderLine: boolean } | null {
  if (entryCount === 0) return null
  const budget = Math.min(6, Math.floor(paneRows / 3))
  if (budget < 2) return null
  const rowsLeft = budget - 1
  const deepFirst = firstIsAgentClose && rowsLeft >= 2
  const shown = Math.min(entryCount, RECEIPT_ENTRIES_SHOWN, rowsLeft - (deepFirst ? 1 : 0))
  if (shown < 1) return null
  const olderLine = entryCount > shown && shown + (deepFirst ? 1 : 0) < rowsLeft
  return { shown, deepFirst, olderLine }
}

/** Re-read keyed on the session, its board state and the fold's growth —
 *  receipts change at close edges and on appends, both of which move one of
 *  these; the file is small and the read is the seam's own torn-tail-safe
 *  reader. */
function useSessionReceiptsNewestFirst(
  sessionId: string,
  workspaceId: string,
  state: string | undefined,
  foldLength: number,
): SessionReceiptEntry[] {
  return useMemo(() => {
    try {
      // Newest-first: the file is append-ordered; the viewer reverses.
      return readSessionReceipts(getProjectDir(workspaceId), sessionId).slice().reverse()
    } catch {
      return []
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- state + foldLength are the re-read triggers
  }, [sessionId, workspaceId, state, foldLength])
}

function receiptRowText(e: SessionReceiptEntry): string {
  const flat = e.summary.replace(/\s+/g, ' ').trim()
  return e.kind === 'machine-floor'
    ? `floor: ${flat}`
    : e.kind === 'agent-close'
      ? `close (${e.by}): ${flat}`
      : e.kind === 'kit-restamp' || e.kind === 'kit-refused' || e.kind === 'kit-dial'
        ? `kit: ${flat}`
        : e.kind === 'schedule-set' || e.kind === 'schedule-fire' || e.kind === 'schedule-held'
          ? `schedule: ${flat}`
          : `contract: ${flat}`
}

// ============================================================================
//  SessionMirror — the switchboard's right-pane live chat mirror (the
//  mirror addendum).
//
//  The selected session's ACTUAL chat text through the REAL renderers: the
//  shared byte-cursor fold (workerTranscriptFold) feeds the focused chat's own
//  normalize → reorder → group → collapse → MessageRow pipeline — markdown,
//  nameplates, disclosure folds, tool cards and turn spacing are inherited,
//  never imitated as plain text lines.
//
//  Density: every fold CLOSED by default — thinking renders its
//  collapsed line (verbose=false outside transcript mode), read/search
//  groups collapse to one-line rows, no recap cards, no lockup, no
//  MercuryFrame; nameplated conversation rows only. Click-to-expand keeps
//  whatever affordance the rows themselves carry.
//
//  One-caret law (IP-3): this pane never mounts a caret, prompt glyph, or
//  composer-family border. The title row is the session's board title in its
//  identity ink with a right-aligned "↵ enter" hint while focused/hovered —
//  a chrome-ink InteractiveRow whose activate runs the caller's real enter.
//
//  Follow: the title tracks the list cursor instantly; the BODY
//  adopts the selection only at the next 160ms bucket edge of the shared
//  clock family at rest (useAnimationValue on the truth lattice — no new
//  interval primitive), so arrowing through the board never thrashes the
//  fold: at most one refold per bucket, always to the latest selection.
//
//  Wheel (IP-2): the caller routes the wheel by pane geometry — this pane
//  consumes wheel events only while `focused` or `pointerOver` (the caller
//  stamps pointerOver from its geometry owner); steps ride the shared
//  computeWheelStep physics, never a flat constant. Bare pgup/pgdn scroll
//  only while focused; a top overlay that owns page keys is yielded to
//  (IA-3), except the route surface's own parking claim.
// ============================================================================

export function SessionMirror({
  sessionId,
  workspaceId,
  title,
  accent,
  paneRows,
  paneWidth,
  focused,
  pointerOver = false,
  onEnter,
  note,
  state,
  nowLabel,
  bare = false,
  liveTailLine,
  idScope = 'mirror',
  wheelBand,
}: {
  sessionId: string
  workspaceId: string
  /** Drive-12 (the thinking-life law): the board row's state + NOW label —
   *  a WORKING background session shows its life in the mirror title row
   *  (the working glyph + its latest activity), the same truth the REPL's
   *  lift paints once entered; the operator can always tell it is thinking. */
  state?: string
  nowLabel?: string | null
  /** The selected session's board title — painted as the pane title in its
   *  identity ink. Tracks the list cursor instantly. */
  title: string
  /** Identity accent for the title + the Mercury nameplates (the critter
   *  accent the caller resolves for the selected session). Absent ⇒ the app
   *  session's critter accent — the exact ink Mercury plates wear by default. */
  accent?: string
  paneRows: number
  paneWidth: number
  focused: boolean
  /** The caller's pointer-cell truth: the pointer currently sits over this
   *  pane (IP-2 — the wheel router's geometry owner stamps it). Wheel events
   *  are consumed only while focused || pointerOver. */
  pointerOver?: boolean
  /** ↵-enter affordance — the caller runs the real enter. */
  onEnter?: () => void
  /** EA-01 (polish wave): the enter journey's ONE painted receipt home —
   *  while a 'board:open' note is live it replaces the hint in this title
   *  row, so ↵ can never fail silently again. */
  note?: ControlNoteState
  /** Line 5 (the row peek): BARE mounts render the live body alone — no
   *  title row, no enter hint; the board row above carries the identity. */
  bare?: boolean
  /** The pointer-region namespace. TWO mirrors mount
   *  under split (the live pane's and the chat pane's) — fixed ids made
   *  them ONE hover region: hovering one lit the other and clicks routed
   *  ambiguously. The board's mount keeps the default ids. */
  idScope?: string
  /** The pane's COLUMN band [x0, x1] — a wheel event
   *  whose own x sits outside it is NEVER consumed, focused or not: the
   *  split divider partitions the wheel by the pointer's side. Absent =
   *  the whole width (the un-split board keeps its behavior). */
  wheelBand?: [number, number]
  /** The streaming reply's last line (the live-tiles feed) — painted as
   *  one live row under the settled records, so a peek scrolls DURING a
   *  reply, not one flush later. Null/absent between blocks. */
  liveTailLine?: string | null
}): React.ReactNode {
  const t = useMercuryTokens()
  const critter = useSessionAccent()
  const identityInk = accent ?? critter.accent

  // ── follow: body adoption on the shared 160ms lattice at rest ──────
  const [body, setBody] = useState({ sessionId, workspaceId })
  const changePending = sessionId !== body.sessionId || workspaceId !== body.workspaceId
  const [, bucket] = useAnimationValue(changePending ? WORK_TICK_MS : null, time =>
    Math.floor(time / WORK_TICK_MS),
  )
  // Armed at the bucket the cursor step landed in; the NEXT edge adopts the
  // then-current selection (steps inside one bucket coalesce to the latest).
  const armedBucketRef = useRef<number | null>(null)
  useEffect(() => {
    if (!changePending) {
      armedBucketRef.current = null
      return
    }
    if (armedBucketRef.current === null) {
      armedBucketRef.current = bucket
      return
    }
    if (bucket !== armedBucketRef.current) {
      armedBucketRef.current = null
      setBody({ sessionId, workspaceId })
    }
  }, [changePending, bucket, sessionId, workspaceId])

  // ── the shared fold + attribution + real pipeline ─────────────────────────
  const { fold } = useWorkerTranscriptFold(body.sessionId, body.workspaceId)
  // paint-from-warmth (the entry's paint hint): the tail this peek already
  // folded is exactly what the entered chat's first frame can carry —
  // published per fold beat, keyed by the PEEKED session (the adopted body,
  // never the pending selection). Bounded at the store (tail slice, LRU);
  // a paint hint only — the connector's own fold replaces it at landing.
  useEffect(() => {
    if (fold !== null && fold.messages.length > 0) rememberSessionWarmth(body.sessionId, fold.messages, fold.shed)
  }, [fold, body.sessionId])
  const classifyAttribution = useCoordinatorAttribution(body.sessionId, fold)
  const toolPermissionContext = useAppState((s: AppState) => s.toolPermissionContext)
  const tools = useMemo(() => getTools(toolPermissionContext), [toolPermissionContext])
  const derived = useMemo(() => deriveTranscriptRows(fold?.messages ?? [], tools), [fold, tools])
  const lastRecord = fold?.messages[fold.messages.length - 1]
  // The fold-derived in-turn truth (AR-7) — the mirror adds no spinner of its
  // own; in-progress tool rows keep their live treatment (one shared clock).
  const turnLive = derived.inProgress.size > 0 || lastRecord?.type === 'user'
  const canAnimate = liveGlyphsEnabled()

  // ── the scroll pane (sticky tail; jump-newest when scrolled up) ──────────
  const scrollRef = useRef<ScrollBoxHandle | null>(null)
  const [away, setAway] = useState(false)
  const awayBaseRef = useRef(0)
  const jumpNewest = useCallback((): void => {
    scrollRef.current?.scrollToBottom()
    setAway(false)
  }, [])
  // Re-anchor on body adoption: the new session's tail is the anchor
  // (scrollToBottom also re-arms stickyScroll after an away episode).
  useEffect(() => {
    jumpNewest()
  }, [body.sessionId, body.workspaceId, jumpNewest])

  const scrollRows = useCallback(
    (dy: number): void => {
      const el = scrollRef.current
      if (el === null) return
      if (dy > 0) {
        const max = Math.max(0, el.getFreshScrollHeight() - el.getViewportHeight())
        if (el.getScrollTop() + el.getPendingDelta() + dy >= max) {
          jumpNewest()
          return
        }
      } else if (!away) {
        awayBaseRef.current = fold?.messages.length ?? 0
        setAway(true)
      }
      el.scrollBy(dy)
    },
    [away, fold, jumpNewest],
  )
  const newSince = away ? Math.max(0, (fold?.messages.length ?? 0) - awayBaseRef.current) : 0

  // ── wheel + page keys (IP-2: consumed only while focused/pointer-over) ───
  const wheelAccel = useRef<WheelAccelState | null>(null)
  useInput(
    (_input, key, event) => {
      // IA-3: a top overlay with its own pager owns page keys AND the wheel —
      // except the route surface's OWN parking claim ('surface:*'), which
      // exists to stand the covered REPL down, never this pane.
      const pagerTop = topOverlay()
      if (pagerTop?.ownsPageKeys === true && !pagerTop.id.startsWith('surface:')) return
      if (key.wheelUp || key.wheelDown) {
        // D4 (SP-5): the divider partitions — an event on the OTHER side of
        // the split is not this pane's, however focus sits.
        const kp = event.keypress as { x?: number }
        if (wheelBand !== undefined && kp.x !== undefined && (kp.x < wheelBand[0] || kp.x > wheelBand[1])) {
          return
        }
        event.stopImmediatePropagation()
        wheelAccel.current ??= initWheelAccel(isXtermJs(), readScrollSpeedBase())
        const dir = key.wheelDown ? 1 : -1
        const step = computeWheelStep(wheelAccel.current, dir, performance.now())
        if (step > 0) scrollRows(dir * step)
        return
      }
      // Bare page keys only, and only while the pane holds focus — modified
      // page keys stay with their global owners.
      if (focused && (key.pageUp || key.pageDown) && !key.ctrl && !key.meta) {
        event.stopImmediatePropagation()
        const viewport = scrollRef.current?.getViewportHeight() ?? 8
        scrollRows(key.pageDown ? pageStepRows(viewport) : -pageStepRows(viewport))
      }
    },
    { isActive: focused || pointerOver },
  )

  // ── the Receipt section's entries (empty ⇒ no section) ───────────────────
  const receiptsNewestFirst = useSessionReceiptsNewestFirst(
    body.sessionId,
    body.workspaceId,
    state,
    fold?.messages.length ?? 0,
  )
  const receiptPlan = planReceiptSection(
    receiptsNewestFirst.length,
    receiptsNewestFirst[0]?.kind === 'agent-close',
    paneRows,
  )

  // ── paint ─────────────────────────────────────────────────────────────────
  const hintVisible = onEnter !== undefined
  // THE TITLE ROW's BUDGET: the title reserved a
  // fixed 10 columns for a right cluster that really measures 15 ("↵ enter
  // session") to ~31 cells (working glyph + activity + hint) — so the two
  // sides chopped each other in the shared overflow-hidden row. The
  // cluster is MEASURED first (the note text when a note stands, else the
  // hint + the working activity's own third-of-pane cap), bounded to half
  // the pane; the title takes the true remainder.
  const noteView = note !== undefined ? controlNoteOf(note) : undefined
  const noteText =
    noteView === undefined
      ? null
      : noteView.state === 'refused' || noteView.state === 'failed'
        ? `✕ ${noteView.reason ?? 'refused'}${noteView.next !== undefined ? ` · ${noteView.next}` : ''}`
        : noteView.state === 'applied'
          ? `✓ ${noteView.reason ?? 'entering'}`
          : (noteView.reason ?? 'working…')
  const nowText =
    state === 'working'
      ? nowLabel !== undefined && nowLabel !== null && nowLabel.length > 0
        ? truncateToWidth(nowLabel, Math.max(8, Math.floor(paneWidth / 3)))
        : // wording follows facts (the C4 class): the row fact is "a turn is
          // live", not which phase — a bare fallback never claims one.
          'working…'
      : null
  const clusterDesired =
    noteText !== null
      ? stringWidth(noteText)
      : hintVisible
        ? stringWidth('↵ enter session') + (nowText !== null ? stringWidth(nowText) + 3 : 0)
        : 0
  const clusterReserve = Math.min(clusterDesired, Math.max(10, Math.floor(paneWidth / 2)))
  const titleBudget = Math.max(8, paneWidth - clusterReserve - 2)
  return (
    <Box flexDirection="column" height={paneRows} width={paneWidth} flexShrink={0} overflow="hidden">
      {bare ? null : (
      <Box height={1} flexShrink={0} overflow="hidden">
        <InteractiveRow
          id={`${idScope}:title`}
          directActivate
          hoverStyle="chrome-ink"
          flexGrow={1}
          onActivate={onEnter}
        >
          {hover => (
            <Box flexDirection="row" width="100%" overflow="hidden">
              <Text color={identityInk} wrap="truncate-end">
                {truncateToWidth(title, titleBudget)}
              </Text>
              <Box flexGrow={1} />
              {noteView !== undefined && noteText !== null ? (
                <Text
                  color={
                    noteView.state === 'refused' || noteView.state === 'failed'
                      ? t.failureText
                      : noteView.state === 'applied'
                        ? t.success
                        : t.textInstruction
                  }
                  wrap="truncate-end"
                >
                  {truncateToWidth(noteText, clusterReserve)}
                </Text>
              ) : hintVisible ? (
                // Live-drive finding 2: the enter affordance
                // was invisible until focus — it is now ALWAYS advertised
                // beside the mirrored title; focus/hover brighten it.
                // Drive-12: a WORKING session's life rides beside it — the
                // glyph + its latest activity — so a background thought is
                // never mistaken for a paused session.
                <Box flexDirection="row" overflow="hidden">
                  {state === 'working' ? (
                    <Box flexDirection="row" marginRight={1} overflow="hidden">
                      <WorkingGlyph color={t.info} active />
                      <Text color={t.textInstruction} wrap="truncate-end">
                        {' '}
                        {nowText}
                      </Text>
                    </Box>
                  ) : null}
                  <Text color={hover || focused ? t.textPrimary : t.textMuted}>
                    ↵ enter session
                  </Text>
                </Box>
              ) : null}
            </Box>
          )}
        </InteractiveRow>
      </Box>
      )}
      {fold === null || derived.collapsed.length === 0 ? (
        <Box flexDirection="column" flexGrow={1} marginTop={bare ? 0 : 1}>
          <Text color={t.textMuted}>
            {state === 'parked'
              ? 'parked — ↵ brings it back'
              : state === 'ready-to-review'
                ? 'no chat yet — ready for your first words · ↵ enters it'
                : 'no chat yet — the session is starting'}
          </Text>
        </Box>
      ) : (
        <AttachedAttributionContext.Provider value={classifyAttribution}>
          <NameplateAccentContext.Provider value={identityInk}>
            <ScrollBox ref={scrollRef} stickyScroll flexGrow={1} flexDirection="column" marginTop={bare ? 0 : 1}>
              {fold.shed > 0 ? (
                // AR-5: the retention cap is an EXPLICIT on-screen boundary —
                // the session's own transcript keeps everything.
                <Text color={t.textMuted} wrap="truncate-end">
                  {GLYPH.dot} older history capped here — {fold.shed} earlier record
                  {fold.shed === 1 ? '' : 's'} stay in the session&apos;s transcript
                </Text>
              ) : null}
              {derived.collapsed.map((m, i) => (
                <NameplateContinuationContext.Provider
                  key={m.uuid}
                  value={isAssistantContinuationRow(derived.collapsed, i, false)}
                >
                  {/* One mirrored row's render throw degrades to that row's
                      fallback line, exactly as in the main transcript
                      (Messages.tsx) — never the whole session through the
                      board's preview pane. */}
                  <SentryErrorBoundary>
                  <MessageRow
                    message={m}
                    isUserContinuation={m.type === 'user' && derived.collapsed[i - 1]?.type === 'user'}
                    hasContentAfter={
                      m.type === 'collapsed_read_search' &&
                      hasContentAfterIndex(
                        derived.collapsed as RenderableMessage[],
                        i,
                        tools,
                        EMPTY_STRING_SET as Set<string>,
                      )
                    }
                    tools={tools}
                    commands={[]}
                    verbose={false}
                    inProgressToolUseIDs={derived.inProgress}
                    streamingToolUseIDs={EMPTY_STRING_SET as Set<string>}
                    screen={'prompt' as Screen}
                    canAnimate={canAnimate}
                    lastThinkingBlockId={null}
                    latestBashOutputUUID={null}
                    columns={paneWidth}
                    isLoading={turnLive}
                    lookups={derived.lookups}
                  />
                  </SentryErrorBoundary>
                </NameplateContinuationContext.Provider>
              ))}
            </ScrollBox>
          </NameplateAccentContext.Provider>
        </AttachedAttributionContext.Provider>
      )}
      {receiptPlan !== null ? (
        // The Receipt section — entries newest-first inside the plan the
        // pane's own rows granted (the frame around this pane belongs to
        // other lanes and WILL change size; nothing here assumes it). The
        // newest agent close takes its deep row only where the plan fits
        // it, pre-clipped to two width-true rows so the wrap can never
        // push a third; every other entry is one truncated fact row.
        <Box flexDirection="column" flexShrink={0} overflow="hidden">
          <Box height={1} overflow="hidden">
            <Text color={t.textMuted} wrap="truncate-end">
              {GLYPH.dot} receipt · {receiptsNewestFirst.length}{' '}
              {receiptsNewestFirst.length === 1 ? 'entry' : 'entries'}
            </Text>
          </Box>
          {receiptsNewestFirst.slice(0, receiptPlan.shown).map((e, i) => {
            const deep = i === 0 && receiptPlan.deepFirst
            const text = receiptRowText(e)
            return (
              <Box key={`${e.at}:${e.kind}:${i}`} height={deep ? 2 : 1} overflow="hidden">
                <Text
                  color={e.kind === 'machine-floor' ? t.textMuted : t.textSecondary}
                  wrap={deep ? 'wrap' : 'truncate-end'}
                >
                  {deep ? truncateToWidth(text, Math.max(16, paneWidth * 2 - 2)) : text}
                </Text>
              </Box>
            )
          })}
          {receiptPlan.olderLine ? (
            <Box height={1} overflow="hidden">
              <Text color={t.textMuted} wrap="truncate-end">
                +{receiptsNewestFirst.length - receiptPlan.shown} older
              </Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
      {liveTailLine !== undefined && liveTailLine !== null && liveTailLine.length > 0 ? (
        // The streaming reply's last line, live at the tail (the tile's own
        // truth at peek depth) — one row, muted, never a second renderer.
        <Box height={1} flexShrink={0} overflow="hidden">
          <Text color={t.textMuted} wrap="truncate-start">
            {GLYPH.dot} {liveTailLine}
          </Text>
        </Box>
      ) : null}
      {away ? (
        // The NewMessagesPill-style control — a scrolled-up reader sees how
        // much arrived and jumps back with one action.
        <Box height={1} flexShrink={0}>
          <InteractiveRow id={`${idScope}:jump-newest`} directActivate hoverStyle="row-fill" onActivate={jumpNewest}>
            {hover => (
              <Text
                color={hover ? t.textPrimary : newSince > 0 ? t.warning : t.textMuted}
                wrap="truncate-end"
              >
                ↓ {newSince > 0 ? `+${newSince} new · ` : ''}return to newest
              </Text>
            )}
          </InteractiveRow>
        </Box>
      ) : null}
    </Box>
  )
}
