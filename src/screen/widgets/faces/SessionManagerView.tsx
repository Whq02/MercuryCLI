import type { UUID } from 'crypto'
import * as React from 'react'
import { useMemo, useRef, useState } from 'react'
import { getSessionId } from '../../../boot/process-state/processState.js'
import type { ResumeEntrypoint } from '../../../commands/catalogue/commands.js'
import { Box, Text, useInput } from '../../themedRenderer.js'
import { usePopupListPaging } from '../../select/popup-list.js'
import type { SessionListing } from '../../../sessions/transcripts/transcriptEntries.js'
import { useTerminalSize } from '../../fullscreen-layout/useTerminalSize.js'
import { retentionWindowDays } from '../../../sessions/transcripts/retentionSweep.js'
import {
  buildPruneOffer,
  operatorPruneTranscripts,
  type PruneOffer,
  type PruneReceipt,
} from '../../../daemon/switchboard/transcriptPruneDoor.js'
import { boardHomedSessionIds, readSessionWorkers } from '../../../daemon/concourse-workers/concourseWorkers.js'
import { getFocusedSessionConnector } from '../../../engine/connector/focusedConnector.js'
import { sanitizeLabel } from '../../concourse-model/concourseSnapshot.js'
import { sessionIdOfListing } from '../../../sessions/transcripts/sessionStorage.js'
import { SECOND } from '../../theme/mercuryPalette.js'
import { useSessionPickerModel, type SessionScope } from './sessionPickerModel.js'
import { useMercuryTokens } from '../useMercuryTokens.js'
import { CommandCenter, EmptyState } from '../components.js'
import { useSessionAccent } from '../sessionAccent.js'
import { Spinner } from '../../spinner/Spinner.js'
import { useOpenEventGate } from '../useOpenEventGate.js'
import { useStableSelection } from '../useStableSelection.js'
import { decodeNavKey } from '../navSemantics.js'
import { prunePaneOf, sessionListView, type OwnSessionStateWords } from './session-manager/views.js'
import { logError } from '../../../platform/logs/errorLog.js'

function shellInteriorWidth(columns: number): number {
  return Math.max(40, columns - 4)
}


export function ownSessionStateWords(rec: { parkedAt?: number; parkReason?: string; endedAt?: number } | undefined): OwnSessionStateWords {
  if (rec !== undefined && rec.endedAt === undefined && rec.parkedAt !== undefined) {
    return {
      glyph: '◌',
      state: rec.parkReason !== undefined && rec.parkReason.trim() !== '' ? sanitizeLabel(rec.parkReason) : 'parked',
      tail: ' · the next prompt resumes it · browsing never closes it',
      parked: true,
    }
  }
  return { glyph: '●', state: 'active', tail: ' · browsing never closes it · switching pauses the current, state kept', parked: false }
}

export function ownSessionRecord(sessionId: string): { parkedAt?: number; parkReason?: string; endedAt?: number } | undefined {
  try {
    return Object.values(readSessionWorkers()).find(rec => rec.sessionId === sessionId && rec.endedAt === undefined)
  } catch (error) {
    logError(new Error(`ownSessionRecord failed: ${error instanceof Error ? error.message : String(error)}`))
    return undefined
  }
}

export async function runSessionSwitch(
  onResume: (sessionId: UUID, log: SessionListing, entrypoint: ResumeEntrypoint) => Promise<void>,
  sessionId: UUID,
  log: SessionListing,
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    await onResume(sessionId, log, 'slash_command_picker')
    return { ok: true }
  } catch (error) {
    return { ok: false, message: `Could not switch to that session (${error instanceof Error ? error.message : String(error)})` }
  }
}

export function SessionManagerView({
  onClose,
  onCloseAll,
  onResume,
  onNewSession,
  initialScope,
}: {
  onClose: () => void
  onCloseAll?: () => void
  onResume?: (
    sessionId: UUID,
    log: SessionListing,
    entrypoint: ResumeEntrypoint,
  ) => Promise<void>
  onNewSession?: () => void
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
  return (
    <CommandCenter view="sessions" onClose={onClose} closeKeys="esc">
      <Box marginTop={1}>
        <EmptyState
          title="Session switching needs the interactive chat wiring"
          hint="run /sessions from the prompt"
        />
      </Box>
    </CommandCenter>
  )
}

export type { SessionScope } from './sessionPickerModel.js'

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
    log: SessionListing,
    entrypoint: ResumeEntrypoint,
  ) => Promise<void>
  onNewSession: () => void
  initialScope: SessionScope
}): React.ReactNode {
  const tokens = useMercuryTokens()
  const accent = useSessionAccent().accent
  const ownState = useMemo(() => ownSessionStateWords(ownSessionRecord(getFocusedSessionConnector().sessionId())), [])
  const { columns } = useTerminalSize()
  const W = shellInteriorWidth(columns)
  const [switching, setSwitching] = useState<'swapping' | { failed: string } | null>(null)
  const switchGenRef = useRef(0)
  const [scope, setScope] = useState<SessionScope>(initialScope)
  const { logs, pendingMore, readNotice, flat, elsewhereCount, dropSessions } = useSessionPickerModel(scope)
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null)
  const [prune, setPrune] = useState<
    | { stage: 'card'; offer: PruneOffer; answer: 'no' | 'yes' }
    | { stage: 'deleting' }
    | { stage: 'receipt'; receipt: PruneReceipt }
    | null
  >(null)

  const pastOpenEvent = useOpenEventGate()

  const WINDOW = 8
  const navKeys = useMemo(
    () => [
      ...flat.map(f => `s:${sessionIdOfListing(f.row.log) ?? `${f.project}:${f.row.label}`}`),
    ],
    [flat],
  )
  const stable = useStableSelection(navKeys, k => k)
  const sel = stable.index
  const navLen = flat.length
  const confirmingResolved = confirmingKey === null ? -1 : navKeys.indexOf(confirmingKey)
  const confirming: number | null = confirmingResolved >= 0 ? confirmingResolved : null
  const { start: winStart, end: winEnd } = computeSessionWindow(sel, flat.length, WINDOW)
  const shown = flat.slice(winStart, winEnd)
  const newerHidden = winStart
  const olderHidden = flat.length - winEnd
  const targetAt = (i: number): SessionListing | null => flat[i]?.row.log ?? null
  const targetLabel = (i: number): string => flat[i]?.row.label ?? ''
  const moveTo = (i: number): void => {
    stable.select(Math.max(0, Math.min(i, Math.max(0, navLen - 1))))
    setConfirmingKey(null)
  }

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

  async function runPrune(offer: PruneOffer) {
    setPrune({ stage: 'deleting' })
    const receipt = await operatorPruneTranscripts(offer)
    dropSessions(new Set(receipt.deletedSessionIds))
    setPrune({ stage: 'receipt', receipt })
  }

  async function switchTo(i: number) {
    const log = targetAt(i)
    if (!log) return
    const sessionId = sessionIdOfListing(log)
    if (!sessionId) return
    const gen = ++switchGenRef.current
    setSwitching('swapping')
    const result = await runSessionSwitch(onResume, sessionId, log)
    if (gen !== switchGenRef.current) return
    if (result.ok) onCloseAll()
    else setSwitching({ failed: result.message })
  }

  const leaveSwitch = (): void => {
    const phase = switching
    switchGenRef.current++
    setSwitching(null)
    setConfirmingKey(null)
    if (phase === 'swapping') onCloseAll()
  }

  usePopupListPaging(sel, navLen, WINDOW, moveTo, switching === null && prune === null && confirming === null)
  useInput(
    (input, key) => {
      if (switching !== null) {
        if (key.escape || (switching !== 'swapping' && key.leftArrow)) leaveSwitch()
        return
      }
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
      const action = decodeNavKey(input, key, { orientation: { grid: { columns: 1 } } })
      if (action === 'cancel') {
        onClose()
        return
      }
      if (action === 'moveLeft') {
        if (sel > 0) moveTo(sel - 1)
        else onClose()
        return
      }
      if (action === 'moveRight') {
        moveTo(sel + 1)
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
        setConfirmingKey(navKeys[Math.min(sel, navLen - 1)] ?? null)
        return
      }
      if (input === 'n') {
        onNewSession()
        return
      }
      if (input === 'a') {
        setScope(s => (s === 'project' ? 'all' : 'project'))
        stable.select(0)
        setConfirmingKey(null)
        return
      }
      if (input === 'd' && !key.ctrl && !key.meta) {
        openPruneDoor()
        return
      }
    },
    { isActive: true },
  )

  const scopeHint = scope === 'project' ? 'a all history' : 'a this project'
  const footer =
    confirming !== null
      ? '↵ yes, switch · esc / n cancel'
      : navLen > 0
        ? `↑↓ / click browse · pgup/pgdn page · ↵ switch · n new · d prune · ${scopeHint} · esc / ← close`
        : `n new · d prune · ${scopeHint} · esc / ← close`

  if (switching !== null) {
    if (switching !== 'swapping') {
      return (
        <CommandCenter view="sessions" onClose={leaveSwitch} captureInput={false} footer="esc / ← back">
          <Box marginTop={1}>
            <EmptyState title={switching.failed} hint="esc / ← back" tone="gated" />
          </Box>
        </CommandCenter>
      )
    }
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

  if (prune !== null) {
    return prunePaneOf({ prune, setPrune, accent })
  }

  return sessionListView({ onClose, footer, accent, ownState, flat, scope, pendingMore, logs, elsewhereCount, newerHidden, shown, winStart, sel, confirming, navKeys, moveTo, setConfirmingKey, tokens, olderHidden, targetAt, targetLabel, W, readNotice })
}
