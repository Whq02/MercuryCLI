import * as React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { AMBER, CRIMSON, FAINT, IVORY, SECOND, TEAL } from '../../components/mercuryPalette.js'
import { CommandCenter, SectionHeader } from '../../components/mercury-ui/components.js'
import { padTo, truncateToWidth } from '../../components/mercury-ui/glyphs.js'
import { CursorCell } from '../../components/mercury-ui/LiveGlyphs.js'
import { useSessionAccent } from '../../components/mercury-ui/sessionAccent.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text, useInput } from '../../ink.js'
import { processMainOwner } from '../../services/run/resolveOwner.js'
import {
  flushRun,
  getRunSnapshot,
  noteRunEvent,
  reconcileOnResume,
  subscribeRuns,
  syncDeliverablesFromTasks,
  syncVerification,
} from '../../services/run/runCoordinator.js'
import type { RunSnapshot } from '../../services/run/runKernel.js'
import {
  getBootRecovery,
  subscribeBootRecovery,
} from '../../substrate/recoveryOrchestrator.js'
import { missionEnabled } from '../../services/mission/contracts.js'
import { buildMissionRow, gatherMissionView, type MissionRow } from '../../services/mission/projection.js'
import { getCwd } from '../../utils/cwd.js'
import { buildBootRecoveryRow, buildRunRows, type RunRow } from './runInspectorModel.js'

// ============================================================================
//  /run — the live run inspector. Reads the SAME
//  RunSnapshot the stop evaluator uses (one truth): objective + lifecycle,
//  deliverables, next action/blocker, typed effects + changed paths,
//  verification evidence, context epoch, IDE feedback, and the bounded event
//  timeline. ↑↓ moves the cursor, ↵ expands a row's evidence, g reconciles
//  through the REAL coordinator (task + verification sync + atomic flush —
//  never a display-only refresh), p pauses / o resumes when valid, c cancels
//  behind a confirm card. esc closes. Subscription-driven — no polling
//  timers; unmount unsubscribes (the lifecycle proof pins zero leaks).
// ============================================================================

const TONE: Record<RunRow['tone'], string> = {
  ok: TEAL,
  warn: AMBER,
  fail: CRIMSON,
  neutral: SECOND,
  accent: IVORY,
}

const SECTION_W = 13

function MercuryRunInspector({ onClose }: { onClose: () => void }): React.ReactNode {
  const accent = useSessionAccent().accent
  const { columns } = useTerminalSize()
  const owner = React.useMemo(() => processMainOwner(), [])
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(() => getRunSnapshot(owner))
  const [sel, setSel] = useState(0)
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const [confirmCancel, setConfirmCancel] = useState(false)
  const confirmRef = React.useRef(false)
  confirmRef.current = confirmCancel
  const mountedAt = React.useRef(Date.now())
  const pastEnterBuffer = () => Date.now() - mountedAt.current > 150

  useEffect(() => {
    const unsubscribe = subscribeRuns(changed => {
      if (changed === owner) setSnapshot(getRunSnapshot(owner))
    })
    return unsubscribe
  }, [owner])

  // Boot-recovery status — the same typed state
  // the Team Center and doctor read; quiet boots contribute no row.
  const recovery = React.useSyncExternalStore(subscribeBootRecovery, getBootRecovery, getBootRecovery)

  // The mission composition — probe-shaped (async gather through the
  // event loop, never a render-path sync read); idle missions contribute no
  // row (no permanent furniture).
  const [missionRow, setMissionRow] = useState<MissionRow | null>(null)
  useEffect(() => {
    if (!missionEnabled()) return
    let alive = true
    void gatherMissionView().then(view => {
      if (alive) setMissionRow(buildMissionRow(view))
    })
    return () => {
      alive = false
    }
  }, [snapshot])

  const rows = React.useMemo(() => {
    const base = snapshot ? buildRunRows(snapshot, Date.now()) : []
    const recoveryRow = buildBootRecoveryRow(recovery)
    const withRecovery = recoveryRow ? [...base, recoveryRow] : base
    return missionRow ? [...withRecovery, missionRow as RunRow] : withRecovery
  }, [snapshot, recovery, missionRow])
  const rowsRef = React.useRef<RunRow[]>([])
  rowsRef.current = rows
  const selRef = React.useRef(0)

  const reconcile = useCallback(() => {
    void (async () => {
      if (getRunSnapshot(owner) === null) {
        // Nothing in the kernel — the sidecar may still hold the durable run
        //
        // reconcileOnResume validates, loads, and re-syncs in one step; a
        // terminal receipt loads without reactivation.
        await reconcileOnResume(owner, getCwd())
      } else {
        await syncDeliverablesFromTasks(owner)
        syncVerification(owner, getCwd())
        await flushRun(owner)
      }
      setSnapshot(getRunSnapshot(owner))
    })()
  }, [owner])

  useInput((input, key) => {
    if (confirmRef.current) {
      if (input === 'y') {
        noteRunEvent(owner, { type: 'cancelled', at: Date.now(), reason: 'operator cancel via /run' })
        setConfirmCancel(false)
      } else if (key.escape || input === 'n') {
        setConfirmCancel(false)
      }
      return
    }
    if (key.escape) {
      onClose()
      return
    }
    if (key.upArrow) {
      selRef.current = Math.max(0, selRef.current - 1)
      setSel(selRef.current)
      return
    }
    if (key.downArrow) {
      selRef.current = Math.min(Math.max(0, rowsRef.current.length - 1), selRef.current + 1)
      setSel(selRef.current)
      return
    }
    if (!pastEnterBuffer()) return
    if (key.return) {
      setOpenIdx(o => (o === selRef.current ? null : selRef.current))
      return
    }
    if (input === 'g') {
      reconcile()
      return
    }
    const snap = getRunSnapshot(owner)
    if (!snap) return
    if (input === 'p' && snap.lifecycle === 'active') {
      noteRunEvent(owner, { type: 'paused', at: Date.now(), reason: 'operator pause via /run' })
      return
    }
    if (input === 'o' && (snap.lifecycle === 'paused' || snap.lifecycle === 'blocked')) {
      noteRunEvent(owner, { type: 'resumed', at: Date.now(), reason: 'operator resume via /run' })
      return
    }
    if (
      input === 'c' &&
      !key.ctrl && !key.meta &&
      snap.lifecycle !== 'completed' &&
      snap.lifecycle !== 'cancelled' &&
      snap.lifecycle !== 'failed'
    ) {
      setConfirmCancel(true)
    }
  })

  const innerW = Math.max(40, columns - 4)
  const snap = snapshot
  // the row verbs render only when there are
  // rows a cursor can act on — the no-snapshot view lists plain lines with no
  // selection, so ↑↓/↵ would be dead affordances there.
  const controls: string[] =
    snap && rows.length > 0 ? ['↑↓ select', '↵ evidence', 'g reconcile'] : ['g reconcile']
  if (snap?.lifecycle === 'active') controls.push('p pause')
  if (snap?.lifecycle === 'paused' || snap?.lifecycle === 'blocked') controls.push('o resume')
  if (snap && !['completed', 'cancelled', 'failed'].includes(snap.lifecycle)) controls.push('c cancel')
  controls.push('esc close')

  return (
    <CommandCenter view="run" subtitle="live run inspector" onClose={onClose} captureInput={false} footer={controls.join(' · ')}>
      <Box marginTop={1} flexDirection="column">
        {!snap ? (
          <Box flexDirection="column">
            <Text color={FAINT}>
              no run this conversation yet — a substantive coding request creates one (task items,
              file mutations); pure Q&amp;A stays lightweight on purpose.
            </Text>
            {rows.map((row, i) => (
              <Text key={`${row.section}-${i}`} wrap="truncate-end">
                <Text color={FAINT}>{padTo(row.section, SECTION_W)}</Text>
                <Text color={TONE[row.tone]}>
                  {truncateToWidth(row.line, Math.max(10, innerW - SECTION_W - 4))}
                </Text>
              </Text>
            ))}
          </Box>
        ) : (
          <>
            <Text wrap="truncate-end">
              <Text color={accent} bold>
                {truncateToWidth(snap.objective, innerW - 2)}
              </Text>
            </Text>
            {confirmCancel ? (
              <Box borderStyle="round" borderColor={CRIMSON} paddingX={1} flexDirection="column">
                <Text color={CRIMSON} bold>
                  cancel this run?
                </Text>
                <Text color={FAINT}>
                  the run record becomes a cancelled receipt (the transcript and files stay) — y
                  confirms · n/esc keeps it
                </Text>
              </Box>
            ) : null}
            {rows.map((row, i) => (
              <Box key={`${row.section}-${i}`} flexDirection="column">
                <Text wrap="truncate-end">
                  <CursorCell focused={i === sel} color={accent} />
                  <Text color={FAINT}>{padTo(row.section, SECTION_W)}</Text>
                  <Text color={TONE[row.tone]}>
                    {truncateToWidth(row.line, Math.max(10, innerW - SECTION_W - 4))}
                  </Text>
                </Text>
                {openIdx === i && row.detail.length > 0 ? (
                  <Box flexDirection="column" marginLeft={4} marginBottom={1}>
                    {row.detail.slice(0, 16).map((d, j) => (
                      <Text key={j} color={SECOND} wrap="truncate-end">
                        {truncateToWidth(d, innerW - 6)}
                      </Text>
                    ))}
                    {row.detail.length > 16 ? (
                      <Text color={FAINT}>… +{row.detail.length - 16} more</Text>
                    ) : null}
                  </Box>
                ) : null}
              </Box>
            ))}
            <Box marginTop={1}>
              <SectionHeader>ONE TRUTH</SectionHeader>
            </Box>
            <Text color={FAINT} wrap="truncate-end">
              this is the exact snapshot the stop evaluator reads — g re-syncs tasks + evidence
              through the coordinator and flushes the sidecar atomically
            </Text>
          </>
        )}
      </Box>
    </CommandCenter>
  )
}

export const call = async (onDone: () => void): Promise<React.ReactNode> => {
  return <MercuryRunInspector onClose={onDone} />
}

export { MercuryRunInspector }
