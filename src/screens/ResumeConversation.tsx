
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
import { loadConversationForResume } from '../utils/conversationRecovery.js'
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
      }
    } finally {
      loadMoreInFlightRef.current = false
    }
  }, [allStatLogs, nextIndex])

  const filteredLogs = useMemo(
    () => logs.filter(log => !log.isSidechain && matchesPrFilter(log, filterByPr)),
    [logs, filterByPr],
  )

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
      const loaded = await loadConversationForResume(log, undefined)
      if (gen !== resumeGenRef.current) return
      if (!loaded) {
        setIsResuming(false)
        setResumeRefusal(
          `could not resume — the session file could not be loaded: ${
            log.fullPath ?? log.sessionId ?? 'unknown path'
          } · the file was left untouched`,
        )
        return
      }

      if (loaded.messages.filter(m => (m as { isMeta?: boolean }).isMeta !== true).length === 0) {
        setIsResuming(false)
        setResumeRefusal(
          `could not resume — the session file's records are unreadable (damaged transcript): ${
            log.fullPath ?? log.sessionId ?? 'unknown path'
          } · the file was left untouched`,
        )
        return
      }
      const sessionId = loaded.sessionId ?? getSessionIdFromLog(log)
      if (!sessionId) {
        setIsResuming(false)
        setResumeRefusal('could not resume — the session file carries no session id · the file was left untouched')
        return
      }
      if (forkSession) {
        setIsResuming(false)
        setResumeRefusal('--fork-session is not available here — pick the session without the flag; it resumes as itself')
        return
      }

      initializeSurfaceRoute(ROOT_REPL_ROUTE);
      const { focusResumedSession } = await import('../services/switchboard/hopIntoSession.js')
      const outcome = await focusResumedSession(String(sessionId), log.fullPath, {
        title: loaded.customTitle ?? loaded.agentName,
        permissionMode: store.getState().toolPermissionContext.mode,
      })
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
