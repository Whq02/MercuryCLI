import type { UUID } from 'crypto'
import * as React from 'react'
import { useMemo, useRef, useState } from 'react'
import { getSessionId } from '../../../bootstrap/state.js'
import type { ResumeEntrypoint } from '../../../commands.js'
import { Box, Text, useInput } from '../../../ink.js'
import type { LogOption } from '../../../types/logs.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { formatFileSize, formatRelativeTimeAgo } from '../../../utils/format.js'
import { retentionWindowDays } from '../../../utils/cleanup.js'
import {
  buildPruneOffer,
  operatorPruneTranscripts,
  type PruneOffer,
  type PruneReceipt,
} from '../../../utils/sessionStorage/transcriptPruneDoor.js'
import { boardHomedSessionIds } from '../../../daemon/concourseSupervisor.js'
import { getSessionIdFromLog } from '../../../utils/sessionStorage.js'
import { AMBER, CRIMSON, DUNE, FAINT, IVORY, SECOND, TEAL } from '../../mercuryPalette.js'
import { useSessionPickerModel, type SessionScope } from './sessionPickerModel.js'
import { useMercuryTokens } from '../useMercuryTokens.js'
import {
  CommandCenter,
  EmptyState,
  SectionHeader,
  StateBadge,
} from '../components.js'
import { padTo, truncateToWidth } from '../glyphs.js'
import { useSessionAccent } from '../sessionAccent.js'
import { critterForKey } from '../../../utils/cockpit/critterVariant.js'
import { Spinner } from '../../Spinner.js'
import { useOpenEventGate } from '../useOpenEventGate.js'
import { useInteractiveList } from '../useInteractiveList.js'
import { useStableSelection } from '../useStableSelection.js'
import { decodeNavKey } from '../navSemantics.js'
import { InteractiveRow } from '../InteractiveRow.js'

// Inner content width inside the CommandCenter shell (round border + paddingX=1
// = 4 cols of chrome) — dynamic text truncates to the LIVE interior so the
// surface holds at 80 cols without wrapping AND uses the width wider
// terminals actually have (the hard-coded 76 capped the body at every size).
function shellInteriorWidth(columns: number): number {
  return Math.max(40, columns - 4)
}

// ============================================================================
//  SessionManagerView — the multi-session switcher (parity-sessions).
//
//  In Mercury this is a LIVE switcher: it lists the real resumable
//  sessions through the ONE picker core (sessionPickerModel — the load,
//  the projection and the scope rows the Boot face's resume entrance also
//  presents), groups them by project, marks the active session as a
//  TAB, and on ↵ calls the REPL's in-place resume() (threaded in as `onResume`)
//  to swap the active session WITHOUT a relaunch — the outgoing session's
//  transcript stays on disk and is restored when you switch back. `n` opens a
//  fresh session in-place via the same /clear path the operator would type.
//
//  HONEST LIMIT — this is switch-not-concurrent. Single-process Ink renders one
//  message tree and runs one API streaming loop; two sessions cannot stream at
//  once without rebuilding the render/event loop. So the inactive session is
//  paused (its JSONL preserved) and resumes on switch-back — never faked as
//  live concurrent streaming.
//
//  When no in-place switch wiring is threaded in (a bare mount outside the
//  REPL command context) the surface renders an honest empty state naming the
//  missing wiring — never a fictional session list (: the
//  GatedSessionManager specimen is deleted). Holds at 80 cols.
// ============================================================================

export function SessionManagerView({
  onClose,
  onCloseAll,
  onResume,
  onNewSession,
  initialScope,
}: {
  // Pop one level (esc / ←) — back to the gallery menu.
  onClose: () => void
  // Fully dismiss the /sessions panel. Called after a switch so the swapped
  // transcript shows unobstructed. Defaults to onClose when not threaded in.
  onCloseAll?: () => void
  // The REPL's in-place session swap (context.resume). Present when /sessions
  // threaded it in. Absent ⇒ the honest no-wiring empty state.
  onResume?: (
    sessionId: UUID,
    log: LogOption,
    entrypoint: ResumeEntrypoint,
  ) => Promise<void>
  // Open a fresh session in-place (closes the panel + submits /clear). Absent
  // ⇒ the honest no-wiring empty state.
  onNewSession?: () => void
  /**
   * 'project' (default — /sessions, the ⊞ SESSIONS card): THIS project's
   * un-cleared sessions, the quick switcher. 'all' (argless /resume): the
   * FULL history — every project, /clear'ed sessions included. Both modes
   * flip live with the `a` key; the full list is cursor-navigable through a
   * sliding window, never capped.
   */
  initialScope?: SessionScope
}): React.ReactNode {
  if (onResume && onNewSession) {
    return (
      <LiveSessionManager
        onClose={onClose}
        onCloseAll={onCloseAll ?? onClose}
        onResume={onResume}
        onNewSession={onNewSession}
        initialScope={initialScope ?? 'project'}
      />
    )
  }
  // No in-place switch wiring reached this mount (outside the REPL command
  // context). Honest empty state — never a fictional session list.
  return (
    <CommandCenter view="sessions" onClose={onClose} captureInput={false}>
      <Box marginTop={1}>
        <EmptyState
          title="Session switching needs the interactive REPL wiring"
          hint="run /sessions (project scope) or /resume (full history) from the prompt"
        />
      </Box>
    </CommandCenter>
  )
}

// The picker CORE lives in sessionPickerModel.ts (one picker
// core, two skins — the Boot face's resume entrance presents the same rows);
// the scope type re-exports from there for this surface's existing callers.
export type { SessionScope } from './sessionPickerModel.js'

/**
 * Sliding card window: which slice of the full session list renders, given
 * the cursor. Pure — the cursor can reach EVERY index (no invisible cap);
 * the window follows it, biased so a couple of upcoming rows stay visible.
 */
export function computeSessionWindow(
  sel: number,
  total: number,
  size: number,
): { start: number; end: number } {
  if (total <= size) return { start: 0, end: total }
  const clampedSel = Math.max(0, Math.min(sel, total - 1))
  const start = Math.max(0, Math.min(clampedSel - (size - 2), total - size))
  return { start, end: start + size }
}

// ============================================================================
//  LiveSessionManager — Mercury-only wired switcher (the SKIN half; the row
//  model — load, projection, scope, crew split — is sessionPickerModel's).
// ============================================================================

function LiveSessionManager({
  onClose,
  onCloseAll,
  onResume,
  onNewSession,
  initialScope,
}: {
  onClose: () => void
  onCloseAll: () => void
  onResume: (
    sessionId: UUID,
    log: LogOption,
    entrypoint: ResumeEntrypoint,
  ) => Promise<void>
  onNewSession: () => void
  initialScope: SessionScope
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const accent = useSessionAccent().accent
  const { columns } = useTerminalSize() // resize subscription + the live width budget
  const W = shellInteriorWidth(columns)
  // THE SWITCH IS ONE PHASE, and esc leaves it. SWAPPING is the REPL's
  // in-place resume committing — it cannot be undone, so esc leaves the
  // panel while the swap keeps going (the restore-keeps-going grammar the
  // rewind surface speaks). No transcript is read here: the resume hops
  // through the one door on the log's PATH and title, and the session's
  // connector paints the words from its own incremental reader — the
  // whole-file parse this panel used to await first ('reading the
  // transcript…') fed nothing downstream and was the lag on every switch.
  // The old boolean gated the whole key handler off for the duration: a
  // slow disk left the operator on a spinner whose footer still read 'esc
  // close' with a dead esc.
  const [switching, setSwitching] = useState<'swapping' | null>(null)
  const switchGenRef = useRef(0)
  // 'project' = the quick switcher (this project, un-cleared). 'all' = the
  // FULL history: every project + /clear'ed sessions. `a` flips live.
  const [scope, setScope] = useState<SessionScope>(initialScope)
  // THE ROW MODEL (sessionPickerModel — the one picker core): the
  // progressive full-history load, the resumable/substantive projection,
  // the scope partition with cleared marks, the operator/crew split, the
  // catalog door's project beat and the 30s 'seen' re-derive all live
  // there; this skin owns selection, confirms, the prune door and paint.
  const { logs, pendingMore, flat, crew, elsewhereCount, dropSessions } = useSessionPickerModel(scope)
  // The pending switch target awaiting an "are you sure?" confirm, stored by
  // STABLE IDENTITY: a live-list refresh mid-confirm can
  // never retarget the switch onto a different session — a vanished target
  // dissolves the confirm instead. Browsing (↑↓ / click) NEVER switches —
  // only a second ↵ (or clicking the already-focused card) commits, so an
  // accidental ↵ can't drop the active session. null = not confirming.
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null)
  // THE PRUNE DOOR (the operator's L11 later parcel): `d` opens the one
  // transcript-deleting door in the product, behind a typed confirmation
  // card. The card freezes its offer AT OPEN (never rebuilt under the
  // operator's answer), starts answered No, answers No on esc/n, and
  // remembers nothing — every open starts fresh at No. Only the card's
  // confirmed Yes calls the door (operatorPruneTranscripts — its one
  // caller); the receipt stage paints the typed receipt after.
  const [prune, setPrune] = useState<
    | { stage: 'card'; offer: PruneOffer; answer: 'no' | 'yes' }
    | { stage: 'deleting' }
    | { stage: 'receipt'; receipt: PruneReceipt }
    | null
  >(null)
  // Which session card the pointer is over → a raised-ash hover fill (click feedback).
  // Single-owner hover store.

  // 150ms Enter-buffer so the keystroke that opened the panel doesn't act on
  // row 0 (same guard the specimen nav uses) — a open-event seq gate (event identity, not wall-clock),
  // not the old setTimeout→setState flag whose parked commit could swallow
  // the first keypress for seconds (§STALE-PAINT idle-
  // parked-commits arm; swept).
  const pastOpenEvent = useOpenEventGate()

  // Card grid: sessions render as deck-style CARDS (parity-sessions) through a
  // SLIDING window — the cursor walks the FULL list (every index reachable, no
  // invisible cap); the window follows it, with honest ↑/↓ overflow counts.
  const WINDOW = 8
  const CREW_CAP = 4
  const crewShown = crew.slice(0, CREW_CAP)
  const crewHidden = crew.length - crewShown.length
  // The cursor space is the FULL flat list, then the crew rows — keyed by
  // STABLE IDENTITY (session id / crew tag) so the 30s refresh tick or a
  // scope flip can never teleport the cursor onto a different card
  //
  const navKeys = useMemo(
    () => [
      ...flat.map(f => `s:${getSessionIdFromLog(f.row.log) ?? `${f.project}:${f.row.label}`}`),
      ...crewShown.map(c => `c:${c.tag}:${c.label}`),
    ],
    [flat, crewShown],
  )
  const stable = useStableSelection(navKeys, k => k)
  const sel = stable.index
  const navLen = flat.length + crewShown.length
  // The derived confirm INDEX for render + commit: a vanished target resolves
  // to null and the confirm dissolves (never a silent retarget).
  const confirmingResolved = confirmingKey === null ? -1 : navKeys.indexOf(confirmingKey)
  const confirming: number | null = confirmingResolved >= 0 ? confirmingResolved : null
  const { start: winStart, end: winEnd } = computeSessionWindow(sel, flat.length, WINDOW)
  const shown = flat.slice(winStart, winEnd)
  const newerHidden = winStart
  const olderHidden = flat.length - winEnd
  // Resolve a cursor index → the target log (full flat space, then crew rows).
  const targetAt = (i: number): LogOption | null =>
    i < flat.length ? (flat[i]?.row.log ?? null) : (crewShown[i - flat.length]?.log ?? null)
  const targetLabel = (i: number): string =>
    i < flat.length
      ? (flat[i]?.row.label ?? '')
      : `${crewShown[i - flat.length]?.tag ?? ''} — ${crewShown[i - flat.length]?.label ?? ''}`
  // Move the cursor (↑↓ / click a card). Browsing NEVER switches — it moves focus
  // and cancels any pending confirm, so the active session is never touched.
  const moveTo = (i: number): void => {
    stable.select(Math.max(0, Math.min(i, Math.max(0, navLen - 1))))
    setConfirmingKey(null)
  }

  // Open the prune door: freeze the offer from the rows THIS list shows as
  // cards (the operator's sessions in the current scope — crew transcripts
  // are never offered), aged past the retention window (the sweep's own
  // number, read from its one owner). The active session and every
  // board-homed live record are excluded again inside the pure builder —
  // a live record's transcript is never in the offered set.
  const openPruneDoor = (): void => {
    const offer = buildPruneOffer(
      flat.map(f => f.row.log),
      {
        scopeLabel:
          scope === 'project'
            ? "this project's listed chats"
            : 'the full history (every project, cleared included)',
        windowDays: retentionWindowDays(),
        activeSessionId: String(getSessionId() ?? ''),
        liveSessionIds: boardHomedSessionIds(),
      },
    )
    setPrune({ stage: 'card', offer, answer: 'no' })
  }

  // The confirmed Yes — the ONE caller of the one transcript-deleting door.
  async function runPrune(offer: PruneOffer) {
    setPrune({ stage: 'deleting' })
    const receipt = await operatorPruneTranscripts(offer)
    // Drop exactly the deleted transcripts from the local list — the mirror
    // of what the door removed; failures stay listed, honestly.
    dropSessions(new Set(receipt.deletedSessionIds))
    setPrune({ stage: 'receipt', receipt })
  }

  async function switchTo(i: number) {
    const log = targetAt(i)
    if (!log) return
    const sessionId = getSessionIdFromLog(log)
    if (!sessionId) return
    const gen = ++switchGenRef.current
    // A lite log is enough: the resume reads the transcript PATH and the
    // title, and the session's connector paints the words incrementally —
    // no whole-file parse stands between the ↵ and the swap.
    setSwitching('swapping')
    try {
      await onResume(sessionId, log, 'slash_command_picker')
      // esc left the panel while the swap committed: it is already closed.
      if (gen !== switchGenRef.current) return
      // resume() swapped setMessages in-place; fully dismiss /sessions so the
      // restored transcript shows unobstructed. (If resume threw, we stay open
      // with the list.)
      onCloseAll()
    } catch {
      if (gen === switchGenRef.current) setSwitching(null)
    }
  }

  // esc during SWAPPING: leave the panel — the swap keeps going and lands
  // on its own.
  const leaveSwitch = (): void => {
    const phase = switching
    switchGenRef.current++
    setSwitching(null)
    setConfirmingKey(null)
    if (phase === 'swapping') onCloseAll()
  }

  useInput(
    (input, key) => {
      if (switching !== null) {
        // Both phases keep their one exit live; every other key waits.
        if (key.escape) leaveSwitch()
        return
      }
      // The prune door's stages own every key while open. CARD: ↑↓ move
      // between No and Yes (No is the default and the cursor's start), ↵
      // commits the highlighted answer, esc / n answer No — nothing is
      // deleted on any road but the highlighted Yes. DELETING: keys wait.
      // RECEIPT: ↵ / esc close it. Nothing here is ever remembered.
      if (prune !== null) {
        if (prune.stage === 'deleting') return
        if (prune.stage === 'receipt') {
          if (key.return || key.escape) setPrune(null)
          return
        }
        if (key.escape || input === 'n') {
          setPrune(null)
          return
        }
        if (key.upArrow || key.downArrow) {
          const offered = prune.offer.candidates.length > 0
          setPrune({
            ...prune,
            answer: offered && prune.answer === 'no' ? 'yes' : 'no',
          })
          return
        }
        if (!pastOpenEvent()) return
        if (key.return) {
          if (prune.answer === 'yes' && prune.offer.candidates.length > 0) {
            void runPrune(prune.offer)
          } else {
            setPrune(null)
          }
          return
        }
        return
      }
      // Confirm gate — the "are you sure?". esc / n cancel immediately
      // (ungated, matching the nav doctrine); ↵ commits — but only once the
      // mount buffer clears, so a launching Enter can't leak straight into a
      // switch. So an accidental ↵ mid-browse only ARMS the confirm — it can
      // never drop the active session on its own.
      if (confirming !== null) {
        if (key.escape || input === 'n') {
          setConfirmingKey(null)
          return
        }
        if (!pastOpenEvent()) return
        if (key.return) {
          void switchTo(confirming)
          return
        }
        return
      }
      // Semantic decode (navSemantics): vertical cards; ← is the ADVERTISED
      // close synonym.
      const action = decodeNavKey(input, key, { orientation: 'vertical', leftCloses: true })
      if (action === 'cancel') {
        onClose()
        return
      }
      if (action === 'movePrevious') {
        moveTo(sel - 1)
        return
      }
      if (action === 'moveNext') {
        moveTo(sel + 1)
        return
      }
      if (action === 'first') {
        moveTo(0)
        return
      }
      if (action === 'last') {
        moveTo(navLen - 1)
        return
      }
      if (!pastOpenEvent()) return
      if (key.return && navLen > 0) {
        // ARM the confirm (never switch directly) — browsing stays lossless.
        // Armed by IDENTITY: a refresh can dissolve, never retarget, it.
        setConfirmingKey(navKeys[Math.min(sel, navLen - 1)] ?? null)
        return
      }
      if (input === 'n') {
        // Fresh session in-place — close + let the REPL run its real /clear
        // path (regenerateSessionId + reset). No duplicated clear machinery.
        onNewSession()
        return
      }
      if (input === 'a') {
        // Flip project ↔ all: 'all' is the FULL history — every project,
        // /clear'ed sessions included. The cursor resets to the top.
        setScope(s => (s === 'project' ? 'all' : 'project'))
        stable.select(0)
        setConfirmingKey(null)
        return
      }
      if (input === 'd' && !key.ctrl && !key.meta) {
        // The prune door — operator-pressed, never automatic. Opens the
        // typed confirmation card; nothing happens before the card.
        openPruneDoor()
        return
      }
    },
    { isActive: true },
  )

  // this surface owns input (captureInput=false) and binds BOTH esc + ←
  // to onClose (:267), so both footer variants honestly advertise 'esc / ← close'.
  // Baking the close hint also lets CommandCenter's de-dup suppress its esc-only
  // auto-append (which would otherwise double the close hint / under-advertise ←).
  const scopeHint = scope === 'project' ? 'a all history' : 'a this project'
  // both directions (product-study r3): ↑↓ browse and the ↵ switch-confirm
  // arm on navLen (operator cards + crew rows), so the footer must gate on navLen
  // too — a crew-only board would otherwise hide browse/switch while both keys were live.
  const footer =
    confirming !== null
      ? '↵ yes, switch · esc / n cancel'
      : navLen > 0
        ? `↑↓ / click browse · ↵ switch · n new · d prune · ${scopeHint} · esc / ← close`
        : `n new · d prune · ${scopeHint} · esc / ← close`

  if (switching !== null) {
    // The footer names what esc does here (leave while the swap keeps
    // going) — never a bare 'esc close' over a spinner.
    return (
      <CommandCenter
        view="sessions"
        onClose={leaveSwitch}
        captureInput={false}
        footer="switching — the swap keeps going · esc back to the chat"
      >
        <Box marginTop={1}>
          <Spinner />
          <Text color={SECOND}> Switching session…</Text>
        </Box>
      </CommandCenter>
    )
  }

  // THE PRUNE DOOR's stages replace the list while open — the typed
  // confirmation card (default No), the deleting beat, then the typed
  // receipt. esc from any stage lands back on the list, never out of the
  // panel — closing the door is not closing /sessions.
  if (prune !== null) {
    const pruneFooter =
      prune.stage === 'card'
        ? prune.offer.candidates.length > 0
          ? '↑↓ choose · ↵ commit (No is the default) · esc / n keep everything'
          : '↵ / esc close'
        : prune.stage === 'receipt'
          ? '↵ / esc back to the list'
          : 'deleting the named set…'
    return (
      <CommandCenter
        view="sessions"
        onClose={() => setPrune(null)}
        captureInput={false}
        // The deleting beat owns no exit (the unlinks are in flight): the
        // shell appends no 'esc close' over it — the footer says what is
        // happening instead.
        closeKeys={prune.stage === 'deleting' ? 'none' : 'esc-arrow'}
        footer={pruneFooter}
      >
        {prune.stage === 'card' ? (
          <Box marginTop={1} flexDirection="column">
            <Text wrap="truncate">
              <Text bold color={AMBER}>prune transcripts</Text>
              <Text color={FAINT}> · the one deleting door — nothing is ever deleted automatically</Text>
            </Text>
            <Box marginTop={1} flexDirection="column">
              <Text wrap="truncate" color={SECOND}>
                scope: <Text color={IVORY}>{prune.offer.scopeLabel}</Text> older than{' '}
                <Text color={IVORY}>{prune.offer.windowDays} days</Text>
              </Text>
              {prune.offer.candidates.length > 0 ? (
                <>
                  <Text wrap="truncate" color={SECOND}>
                    would delete:{' '}
                    <Text color={IVORY}>
                      {prune.offer.candidates.length} transcript
                      {prune.offer.candidates.length === 1 ? '' : 's'}
                    </Text>
                    {' '}· total <Text color={IVORY}>{formatFileSize(prune.offer.totalBytes)}</Text>
                  </Text>
                  <Text wrap="truncate" color={SECOND}>
                    age range:{' '}
                    <Text color={IVORY}>
                      {prune.offer.oldestModified
                        ? formatRelativeTimeAgo(prune.offer.oldestModified, { style: 'short' })
                        : '—'}
                      {' → '}
                      {prune.offer.newestModified
                        ? formatRelativeTimeAgo(prune.offer.newestModified, { style: 'short' })
                        : '—'}
                    </Text>
                  </Text>
                </>
              ) : (
                <Text wrap="truncate" color={FAINT}>
                  nothing to prune — no listed chat is older than {prune.offer.windowDays} days
                </Text>
              )}
            </Box>
            <Box marginTop={1} flexDirection="column">
              <Text>
                <Text color={prune.answer === 'no' ? accent : FAINT}>
                  {prune.answer === 'no' ? '▸ ' : '  '}
                </Text>
                <Text bold={prune.answer === 'no'} color={prune.answer === 'no' ? IVORY : SECOND}>
                  No — keep everything
                </Text>
                <Text color={FAINT}> (default)</Text>
              </Text>
              {prune.offer.candidates.length > 0 ? (
                <Text>
                  <Text color={prune.answer === 'yes' ? accent : FAINT}>
                    {prune.answer === 'yes' ? '▸ ' : '  '}
                  </Text>
                  <Text bold={prune.answer === 'yes'} color={prune.answer === 'yes' ? CRIMSON : SECOND}>
                    Yes — delete exactly this set, for good
                  </Text>
                </Text>
              ) : null}
            </Box>
            <Box marginTop={1}>
              <Text wrap="truncate" color={FAINT}>
                deletes exactly the set named above · asked every time, never remembered
              </Text>
            </Box>
          </Box>
        ) : prune.stage === 'deleting' ? (
          <Box marginTop={1}>
            <Spinner />
            <Text color={SECOND}> Deleting the named set…</Text>
          </Box>
        ) : (
          <Box marginTop={1} flexDirection="column">
            <Text wrap="truncate">
              <Text bold color={TEAL}>pruned</Text>
              <Text color={FAINT}> · the operator's own act</Text>
            </Text>
            <Box marginTop={1} flexDirection="column">
              <Text wrap="truncate" color={SECOND}>
                deleted{' '}
                <Text color={IVORY}>
                  {prune.receipt.deleted} transcript{prune.receipt.deleted === 1 ? '' : 's'}
                </Text>
                {' '}· freed <Text color={IVORY}>{formatFileSize(prune.receipt.bytesFreed)}</Text>
                {' '}· <Text color={IVORY}>{formatRelativeTimeAgo(prune.receipt.at, { style: 'short' })}</Text>
                {' '}· by the operator
              </Text>
              {prune.receipt.failed > 0 ? (
                <Text wrap="truncate" color={AMBER}>
                  {prune.receipt.failed} could not be deleted — still listed
                </Text>
              ) : null}
            </Box>
          </Box>
        )}
      </CommandCenter>
    )
  }

  return (
    <CommandCenter
      view="sessions"
      onClose={onClose}
      captureInput={false}
      footer={footer}
    >
      {/* Active session = the live TAB — browsing this panel never closes it. */}
      <Box marginTop={1}>
        <Text wrap="truncate">
          <Text color={accent}>▣ </Text>
          <Text bold color={IVORY}>this session</Text>
          <Text color={TEAL}> ● active</Text>
          <Text color={FAINT}> · browsing never closes it · switching pauses the current, state kept</Text>
        </Text>
      </Box>

      <SectionHeader count={flat.length}>
        {`${scope === 'project' ? 'Switch to' : 'Full history — every project, cleared included'}${pendingMore > 0 ? ` · loading ${pendingMore} more…` : ''}`}
      </SectionHeader>
      {logs === null || (flat.length === 0 && pendingMore > 0) ? (
        <Box>
          <Spinner />
          <Text color={SECOND}> Loading sessions…</Text>
        </Box>
      ) : flat.length === 0 ? (
        <EmptyState
          tone="idle"
          glyph="⦿"
          title={
            scope === 'project'
              ? 'No other sessions in this project'
              : 'No other sessions anywhere'
          }
          hint={
            scope === 'project' && elsewhereCount > 0
              ? `n starts a fresh session in-place · ${elsewhereCount} in other projects — a shows them`
              : crewShown.length > 0
                ? 'n starts a fresh session in-place · ↑↓ reaches the router-crew transcripts below'
                : 'n starts a fresh session in-place · this is the only open session'
          }
        />
      ) : (
        <>
          {newerHidden > 0 ? (
            <Text color={FAINT}>  ↑ +{newerHidden} newer — ↑ scrolls</Text>
          ) : null}
          <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
            {shown.map((f, wi) => {
              const i = winStart + wi
              const on = i === sel
              const pending = confirming === i
              // Stable per-SESSION creature (critterVariant first-seen registry):
              // a card keeps ITS critter as the list reorders — the positional
              // critterAt(i) pick reshuffled every card's identity on re-sort.
              const def = critterForKey(getSessionIdFromLog(f.row.log) ?? f.row.label)
              // Stable interaction identity: React key + hover claim ride the SESSION identity
              // — a recency re-sort under a stationary pointer would otherwise move
              // the hover fill and the reconciled subtree onto a DIFFERENT
              // session. The navKeys composite (project-prefixed for id-less
              // legacy logs) keeps keys unique in the ALL-projects scope
              // where two projects' logs can share a label.
              const cardKey = navKeys[i] ?? (getSessionIdFromLog(f.row.log) ?? f.row.label)
              return (
                <InteractiveRow
                  key={cardKey}
                  id={`sessions-live:card:${cardKey}`}
                  selected={on}
                  onSelect={() => moveTo(i)}
                  onActivate={() => setConfirmingKey(navKeys[i] ?? null)}
                  flexDirection="column"
                  flexShrink={0}
                >
                {hover => (
                <Box
                  borderStyle="round"
                  borderColor={pending ? AMBER : on ? def.hue : DUNE}
                  backgroundColor={hover ? tokens.surface2 : undefined}
                  paddingX={1}
                  marginRight={1}
                  marginBottom={1}
                  width={26}
                  flexDirection="column"
                >
                  <Text>
                    <Text bold color={def.hue}>{truncateToWidth(f.project, 15)}</Text>
                    {on ? <Text color={TEAL}> ▸</Text> : null}
                  </Text>
                  <Text color={on ? IVORY : SECOND}>{truncateToWidth(f.row.label, 22)}</Text>
                  {/* seen already carries "ago" (formatRelativeTimeAgo) — the old
                      literal suffix doubled it: "2 hours ago ago" (visual audit).
                      'all' scope marks deliberately /clear'ed sessions inline. */}
                  <Text color={FAINT}>
                    {truncateToWidth(
                      f.row.cleared ? `${f.row.seen} · cleared` : f.row.seen,
                      22,
                    )}
                  </Text>
                  {pending ? <Text color={AMBER}>are you sure? ↵ yes</Text> : null}
                </Box>
                )}
                </InteractiveRow>
              )
            })}
          </Box>
        </>
      )}
      {olderHidden > 0 ? (
        <Text color={FAINT}>  ↓ +{olderHidden} older — ↓ scrolls</Text>
      ) : null}
      {/* PROJECT SCOPE: other repos' sessions never render as cards here —
          one honest count line; `a` (or argless /resume) is the full reach. */}
      {scope === 'project' && flat.length > 0 && elsewhereCount > 0 ? (
        <Text color={FAINT}>  +{elsewhereCount} in other projects — a shows all history</Text>
      ) : null}

      {/* ROUTER CREWS — daemon-seat transcripts (party/scribe children),
          distinct from the operator's sessions. Navigable (↑↓ walks past the
          cards into these rows; ↵ arms the same confirm) but visually
          subdued: reading a crew transcript is inspection, not switching
          between your own work. */}
      {crewShown.length > 0 ? (
        <>
          <SectionHeader count={crew.length}>Router crews</SectionHeader>
          {crewShown.map((c, ci) => {
            const i = flat.length + ci
            const on = i === sel
            // Stable interaction identity: identity = the crew nav key (stable), not position.
            const crewKey = navKeys[i] ?? `crew-${ci}`
            return (
              <InteractiveRow
                key={crewKey}
                id={`sessions-live:crew:${crewKey}`}
                selected={on}
                onSelect={() => moveTo(i)}
                onActivate={() => setConfirmingKey(navKeys[i] ?? null)}
              >
              {hover => (
              <Box backgroundColor={on ? tokens.selectionBand : hover ? tokens.surface2 : undefined}>
                <Text wrap="truncate-end">
                  <Text color={on ? tokens.success : tokens.textMuted}>{on ? ' ▸ ' : '   '}</Text>
                  <Text color={on ? tokens.textPrimary : tokens.textSecondary}>{padTo(c.tag, 22)}</Text>
                  <Text color={tokens.textMuted}>{truncateToWidth(c.label, 34)}</Text>
                  <Text color={tokens.textMuted}> · {c.seen}</Text>
                </Text>
              </Box>
              )}
              </InteractiveRow>
            )
          })}
          {crewHidden > 0 ? (
            <Text color={FAINT}>  +{crewHidden} more crew transcripts (newest {CREW_CAP} shown)</Text>
          ) : null}
        </>
      ) : null}

      {/* Confirm (are you sure?) OR the honest switch-not-concurrent note. */}
      {confirming !== null && targetAt(confirming) ? (
        <Box marginTop={1}>
          <Text bold color={AMBER}>are you sure? </Text>
          <Text color={SECOND}>
            {truncateToWidth(`switch to "${targetLabel(confirming)}" — this session pauses (state preserved). ↵ yes · esc cancel`, W - 16)}
          </Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={FAINT}>
            {truncateToWidth(
              '↵ arms a confirm, then swaps in-place — both sessions keep their state; switch back any time',
              W - 2,
            )}
          </Text>
        </Box>
      )}
    </CommandCenter>
  )
}
