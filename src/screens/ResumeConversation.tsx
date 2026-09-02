// The session picker: loads candidate session logs, lets the operator choose
// one, restores its state, and swaps itself for the REPL in place. Under a
// launcher hold the interactive phases live inside the alternate-screen
// host (latched once at mount); print-and-exit states stay unwrapped so
// their text lands in scrollback.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStateStore } from '../state/AppState.js'
import { LogSelector } from '../components/LogSelector.js'
import { SpinnerGlyph } from '../components/Spinner/SpinnerGlyph.js'
import { useMercuryTokens } from '../components/mercury-ui/useMercuryTokens.js'
import { SurfaceRouter } from '../components/SurfaceRouter.js'
import { initializeSurfaceRoute, ROOT_REPL_ROUTE } from '../context/surfaceRoute.js'
import { Box, Text, useInput } from '../ink.js'
import { AlternateScreen } from '../ink/components/AlternateScreen.js'
import { TerminalSizeContext } from '../ink/components/TerminalSizeContext.js'
import { useAnimationFrame } from '../ink/hooks/use-animation-frame.js'
import { launcherAltHoldPending } from '../ink/launcherAltHold.js'
import { setClipboard } from '../ink/termio/osc.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import type { Tool } from '../Tool.js'
import type { Command } from '../commands.js'
import type { LogOption } from '../types/logs.js'
import { checkCrossProjectResume } from '../utils/crossProjectResume.js'
import { logError } from '../utils/log.js'
import { isFullscreenEnvEnabled, isMouseTrackingEnabled } from '../utils/fullscreen.js'
import { estateGroundBg } from '../utils/mercuryTokens.js'
import {
  enrichLogs,
  getSessionIdFromLog,
  loadAllProjectsMessageLogsProgressive,
  loadSameRepoMessageLogsProgressive,
  type SessionLogResult,
} from '../utils/sessionStorage/logs.js'
import { isCustomTitleEnabled } from '../utils/sessionStorage/paths.js'
import { REPL, type Props as REPLProps } from './REPL.js'

const LOAD_MORE_BATCH = 20

type Props = {
  commands: Command[]
  worktreePaths: string[]
  initialTools: Tool[]
  debug?: boolean
  initialSearchQuery?: string
  disableSlashCommands?: boolean
  forkSession?: boolean
  filterByPr?: boolean | number | string
}

/** Parse the PR filter: `true` (any PR), a number (exact), or a string as a
 *  positive integer or a GitHub pull URL. */
function matchesPrFilter(log: LogOption, filter: Props['filterByPr']): boolean {
  if (filter === undefined) return true
  const prNumber = (log as { prNumber?: number }).prNumber
  if (filter === true) return prNumber !== undefined
  if (typeof filter === 'number') return prNumber === filter
  if (typeof filter !== 'string') return false
  const asInt = /^\d+$/.test(filter) ? Number(filter) : undefined
  if (asInt !== undefined && asInt > 0) return prNumber === asInt
  const fromUrl = /\/pull\/(\d+)/.exec(filter)
  if (fromUrl) return prNumber === Number(fromUrl[1])
  return false
}

function SpinnerLine({ text }: { text: string }): React.ReactNode {
  const [ref, time] = useAnimationFrame(120)
  return (
    <Box ref={ref} gap={1}>
      <SpinnerGlyph frame={Math.floor(time / 120)} time={time} messageColor="systemSpinner" />
      <Text>{text}</Text>
    </Box>
  )
}

/** A wait with a NAMED way out: the bare spinner branches
 *  bound no key on a root whose ctrl+c is deliberately disarmed — SL-1
 *  closed the thrown-freeze, but an honest wait that HANGS (an NFS stall,
 *  an admit that never settles) still stranded the operator with only the
 *  window's close box. esc and ctrl+c both run onCancel; the hint names
 *  what that means on each branch. Wraps its own KeybindingSetup exactly
 *  like NoConversations — this root guarantees no provider. */
function ResumeWaitInner({ text, hint, onCancel }: { text: string; hint: string; onCancel: () => void }): React.ReactNode {
  useKeybinding('app:interrupt', onCancel)
  useInput((_input, key) => {
    if (key.escape) onCancel()
  })
  return (
    <Box flexDirection="column">
      <SpinnerLine text={text} />
      <Box paddingLeft={2}>
        <Text dimColor>{hint}</Text>
      </Box>
    </Box>
  )
}
function ResumeWait(props: { text: string; hint: string; onCancel: () => void }): React.ReactNode {
  return (
    <KeybindingSetup>
      <ResumeWaitInner {...props} />
    </KeybindingSetup>
  )
}

/** The picker owns its viewport: a flat ground behind it, spanning the FULL
 *  viewport height (a grow-based wrapper left a default-background stripe on
 *  the last row) — painted only under the alternate-screen host. The colour
 *  is the ESTATE canvas (estateGroundBg — the same ground FullscreenLayout
 *  paints under the REPL), so choosing a session swaps surfaces without the
 *  whole viewport flipping colour; where the estate gate says no canvas
 *  (light/ansi/no-truecolor), both phases keep the terminal ground and the
 *  swap is equally flat. */
function GroundFill({ children }: { children: React.ReactNode }): React.ReactNode {
  const tokens = useMercuryTokens()
  const size = React.useContext(TerminalSizeContext)
  return (
    <Box
      flexDirection="column"
      height={size?.rows ?? 24}
      width="100%"
      backgroundColor={estateGroundBg(tokens)}
    >
      {children}
    </Box>
  )
}

function NoConversations(): React.ReactNode {
  useKeybinding('app:interrupt', () => {
    process.exit(1)
  })
  return (
    <Box paddingX={1}>
      <Text>No conversations to resume. Press ctrl+c to exit and start fresh.</Text>
    </Box>
  )
}

export function ResumeConversation({
  commands,
  worktreePaths,
  initialTools,
  debug,
  initialSearchQuery,
  disableSlashCommands = false,
  forkSession,
  filterByPr,
}: Props): React.ReactNode {
  const store = useAppStateStore()
  const [logs, setLogs] = useState<LogOption[]>([])
  const [allStatLogs, setAllStatLogs] = useState<LogOption[]>([])
  const [nextIndex, setNextIndex] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [isResuming, setIsResuming] = useState(false)
  const [showAllProjects, setShowAllProjects] = useState(false)
  const [resumeRefusal, setResumeRefusal] = useState<string | null>(null)
  const [resumeData, setResumeData] = useState<Omit<REPLProps, 'commands' | 'debug' | 'initialTools'> | null>(
    null,
  )
  const logCountRef = useRef(0)
  // Latched ONCE: the wrapper's identity must never change mid-life, since
  // the hold is consumed by the wrapper's own first mount. A fullscreen-env
  // boot without the launcher hold (direct `mercury --resume`) takes the
  // SAME held-screen path: the picker phases live inside the alternate
  // screen on the estate ground, and picking a session swaps surfaces in
  // place instead of an inline picker flipping into the fullscreen estate.
  const [useAltScreenHost] = useState(
    () => launcherAltHoldPending() || isFullscreenEnvEnabled(),
  )

  const applyResult = useCallback((result: SessionLogResult) => {
    setLogs(result.logs)
    logCountRef.current = result.logs.length
    setAllStatLogs(result.allStatLogs)
    setNextIndex(result.nextIndex)
  }, [])

  const load = useCallback(
    async (allProjects: boolean) => {
      setIsLoading(true)
      try {
        const result = allProjects
          ? await loadAllProjectsMessageLogsProgressive()
          : await loadSameRepoMessageLogsProgressive(worktreePaths)
        applyResult(result)
      } catch (error) {
        logError(error)
      } finally {
        setIsLoading(false)
      }
    },
    [worktreePaths, applyResult],
  )

  useEffect(() => {
    void load(showAllProjects)
  }, [load, showAllProjects])

  // loadMore is SINGLE-FLIGHT. The near-bottom
  // trigger fires per render, and two overlapping calls enriched the SAME
  // nextIndex slice before the first's state landed — the batch appended
  // twice and the grouping then counted the duplicates as forks (the
  // phantom "(+N)" rows). The ref, not state: the guard must be visible to
  // the very next call in the same commit window.
  const loadMoreInFlightRef = useRef(false)
  const loadMore = useCallback(async () => {
    if (loadMoreInFlightRef.current) return
    loadMoreInFlightRef.current = true
    try {
      let start = nextIndex
      while (start < allStatLogs.length) {
        const batch = await enrichLogs(allStatLogs, start, LOAD_MORE_BATCH)
        start = batch.nextIndex
        setNextIndex(batch.nextIndex)
        if (batch.logs.length > 0) {
          setLogs(prev => {
            const base = logCountRef.current
            const appended = batch.logs.map((log, i) => ({ ...log, value: base + i }))
            logCountRef.current = base + appended.length
            return [...prev, ...appended]
          })
          return
        }
        // A batch yielded nothing but more remain: keep going.
      }
    } finally {
      loadMoreInFlightRef.current = false
    }
  }, [allStatLogs, nextIndex])

  const filteredLogs = useMemo(
    () => logs.filter(log => !log.isSidechain && matchesPrFilter(log, filterByPr)),
    [logs, filterByPr],
  )

  // The cancel generation: a cancelled wait bumps it, and
  // every await inside onSelect re-checks — a late-arriving success must
  // never mount the REPL over an operator who already left the wait.
  const resumeGenRef = useRef(0)
  const cancelResumeWait = useCallback(() => {
    resumeGenRef.current++
    setIsResuming(false)
    setResumeRefusal('resume cancelled — the session file is untouched; pick again, or esc to quit')
  }, [])
  const onSelect = useCallback(
    async (log: LogOption) => {
      setIsResuming(true)
      setResumeRefusal(null)
      const gen = ++resumeGenRef.current
      const cross = checkCrossProjectResume(log, showAllProjects, worktreePaths)
      if (cross.isCrossProject && !cross.isSameRepoWorktree) {
        // THE STAY-ON-PICKER SHAPE (lead-ruled): an ↵ that
        // exited the whole CLI in 100ms with no visible handoff was the
        // stranding class — the operator picked a row and the program
        // vanished. The command still lands on the clipboard; the
        // picker stays, the note names the move. The frontier follow-up (an
        // IN-PROCESS project hop — possible since the ground-move fix) is
        // the operator's ruling, not taken
        // here.
        let copied = false
        try {
          const sequence = await setClipboard(cross.command)
          if (sequence) process.stdout.write(sequence)
          copied = true
        } catch (error) {
          logError(error)
        }
        if (gen !== resumeGenRef.current) return
        setIsResuming(false)
        setResumeRefusal(
          `that conversation lives in another folder — to resume it run: ${cross.command}${copied ? ' (copied to the clipboard)' : ''} · the picker stays open`,
        )
        return
      }
      // NO WHOLE-TRANSCRIPT PARSE BEFORE THE HOP (ruled): the one resume
      // door takes the log's PATH and TITLE, and the session's connector
      // paints the words from its own incremental reader — the managed
      // session's runner loads its conversation itself (its hooks, its plan
      // copy), so the parse this picker used to await here fed nothing but
      // the felt lag of every pick.
      const sessionId = getSessionIdFromLog(log)
      if (!sessionId) {
        setIsResuming(false)
        setResumeRefusal('could not resume — the session file carries no session id · the file was left untouched')
        return
      }
      if (forkSession) {
        // A managed resume continues the session as itself; forking a
        // resumed session under a new id is a named follow-up.
        setIsResuming(false)
        setResumeRefusal('--fork-session is not available here — pick the session without the flag; it resumes as itself')
        return
      }

      // The pick is an explicit REPL journey: the route starts at the root.
      initializeSurfaceRoute(ROOT_REPL_ROUTE);
      // ONE resume path: the session comes back as a MANAGED session — its
      // transcript paints on the REPL's first frame from its file, the
      // daemon admits the same durable session behind the paint.
      const { focusResumedSession } = await import('../services/switchboard/hopIntoSession.js')
      const outcome = await focusResumedSession(String(sessionId), log.fullPath, {
        title: log.customTitle ?? log.agentName,
        // The screen's resolved posture rides the resume.
        permissionMode: store.getState().toolPermissionContext.mode,
      })
      // A cancel that landed mid-admit: the managed session may stand (the
      // admit cannot be unwound from here — it is a durable session, not a
      // leak), but the REPL must NOT mount over the picker the operator
      // returned to.
      if (gen !== resumeGenRef.current) return
      if (!outcome.ok) {
        setIsResuming(false)
        setResumeRefusal(`could not resume — ${outcome.reason}`)
        return
      }
      setResumeData({ disableSlashCommands } as Omit<REPLProps, 'commands' | 'debug' | 'initialTools'>)
    },
    [showAllProjects, worktreePaths, forkSession, disableSlashCommands],
  )

  const onCancel = useCallback(() => {
    process.exit(1)
  }, [])

  const size = React.useContext(TerminalSizeContext)

  const host = (node: React.ReactNode): React.ReactNode =>
    useAltScreenHost ? (
      <AlternateScreen mouseTracking={isMouseTrackingEnabled()}>
        <GroundFill>{node}</GroundFill>
      </AlternateScreen>
    ) : (
      node
    )

  // Render precedence — the order is behaviour.
  if (resumeData) {
    const inner = (<SurfaceRouter><REPL commands={commands} debug={debug} initialTools={initialTools} {...resumeData} /></SurfaceRouter>);
    return useAltScreenHost ? (
      <AlternateScreen mouseTracking={isMouseTrackingEnabled()}>{inner}</AlternateScreen>
    ) : (
      inner
    )
  }
  if (isLoading)
    return host(
      <ResumeWait text="Loading conversations…" hint="esc or ctrl+c quits" onCancel={() => process.exit(1)} />,
    )
  if (isResuming)
    return host(
      <ResumeWait
        text="Resuming conversation…"
        hint="esc or ctrl+c cancels — back to the picker"
        onCancel={cancelResumeWait}
      />,
    )
  if (filteredLogs.length === 0) {
    return (
      <KeybindingSetup>
        <NoConversations />
      </KeybindingSetup>
    )
  }
  return host(
    <>
      {resumeRefusal !== null ? (
        <Box paddingX={1}>
          <Text color="error" wrap="wrap">
            ✕ {resumeRefusal}
          </Text>
        </Box>
      ) : null}
      <LogSelector
        logs={filteredLogs}
      onSelect={log => {
        // Every failure lands as a refusal line on the picker (SL-1): a
        // rethrow became an unhandled rejection under a spinner that binds
        // no key, with ctrl+c disarmed — the only way out was the window's
        // close box. An NTFS EPERM/EBUSY from an indexer holding the
        // transcript is an ordinary failure here.
        void onSelect(log).catch(error => {
          logError(error)
          setIsResuming(false)
          setResumeRefusal(
            `could not resume — ${error instanceof Error ? error.message : String(error)} · the picker stays open; the file was left untouched`,
          )
        })
      }}
      onCancel={onCancel}
      onLoadMore={nextIndex < allStatLogs.length ? loadMore : undefined}
      showAllProjects={showAllProjects}
      onToggleAllProjects={() => setShowAllProjects(v => !v)}
      initialSearchQuery={initialSearchQuery}
      onLogsChanged={isCustomTitleEnabled() ? () => void load(showAllProjects) : undefined}
      onLogRenamed={(sessionId, title) => {
        // D7 (SL-3): one row's title changed — patch it in place; the
        // picker's selection, scroll and search all stand.
        const patch = (rows: LogOption[]): LogOption[] =>
          rows.map(l => (String(l.sessionId) === sessionId ? { ...l, customTitle: title } : l))
        setLogs(patch)
        setAllStatLogs(patch)
      }}
      maxHeight={size?.rows ?? 24}
      />
    </>,
  )
}
