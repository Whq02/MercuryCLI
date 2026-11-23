import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useLoad } from '../hooks/effects.js'
import { useAppStateStore } from '../state/AppState.js'
import { LogSelector } from '../components/LogSelector.js'
import { SpinnerGlyph } from '../components/Spinner/SpinnerGlyph.js'
import { useMercuryTokens } from '../components/mercury-ui/useMercuryTokens.js'
import { SurfaceRouter } from '../components/SurfaceRouter.js'
import { initializeSurfaceRoute, ROOT_CHAT_ROUTE } from '../context/surfaceRoute.js'
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
import type { SessionListing } from '../types/logs.js'
import { checkCrossProjectResume } from '../utils/crossProjectResume.js'
import { logError } from '../utils/log.js'
import { isFullscreenEnvEnabled, isMouseTrackingEnabled } from '../utils/fullscreen.js'
import { estateGroundBg } from '../utils/mercuryTokens.js'
import { getOriginalCwd } from '../bootstrap/state.js'
import {
  enrichSessionListings,
  formatSessionReadFailures,
  mergeSessionReadFailures,
  sessionIdOfListing,
  listSessionsAcrossProjectsProgressive,
  listRepoSessionsProgressive,
  type SessionPage,
  type SessionReadFailures,
} from '../utils/sessionStorage/logs.js'
import { isCustomTitleEnabled } from '../utils/sessionStorage/paths.js'
import { Chat, type Props as ChatProps } from './Chat.js'

const LOAD_MORE_BATCH = 20

type Props = {
  commands: Command[]
  worktreePaths: string[]
  worktreeReadError?: string
  initialTools: Tool[]
  debug?: boolean
  disabled?: boolean
  disableSlashCommands?: boolean
  initialSearchQuery?: string
  forkSession?: boolean
  filterByPr?: boolean | number | string
}

function matchesPrFilter(log: SessionListing, filter: Props['filterByPr']): boolean {
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

function NoConversations({ readNotice }: { readNotice: string | null }): React.ReactNode {
  useKeybinding('app:interrupt', () => {
    process.exit(1)
  })
  return (
    <Box paddingX={1} flexDirection="column">
      {readNotice !== null ? (
        <Text color="warning" wrap="wrap">
          {readNotice}
        </Text>
      ) : null}
      <Text>No conversations to resume. Press ctrl+c to exit and start fresh.</Text>
    </Box>
  )
}

function LoadConversationsFailed({ error }: { error: string }): React.ReactNode {
  useKeybinding('app:interrupt', () => {
    process.exit(1)
  })
  return (
    <Box paddingX={1}>
      <Text color="error" wrap="wrap">
        Could not load conversations ({error}) — press ctrl+c to exit and start fresh.
      </Text>
    </Box>
  )
}

export function ResumeConversation({
  commands,
  worktreePaths,
  worktreeReadError,
  initialTools,
  debug,
  disabled,
  disableSlashCommands,
  initialSearchQuery,
  forkSession,
  filterByPr,
}: Props): React.ReactNode {
  const appStateStore = useAppStateStore()
  const [useAltScreenHost] = useState(
    () => launcherAltHoldPending() || isFullscreenEnvEnabled(),
  )
  const [showAllProjects, setShowAllProjects] = useState(false)
  const [logs, setLogs] = useState<SessionListing[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [readFailures, setReadFailures] = useState<SessionReadFailures | undefined>(undefined)
  const [resuming, setResuming] = useState(false)
  const [resumed, setResumed] = useState(false)
  const [resumeNotice, setResumeNotice] = useState<string | null>(null)

  const allStatLogsRef = useRef<SessionListing[]>([])
  const nextIndexRef = useRef(0)
  const loadingMoreRef = useRef(false)
  const loadGenRef = useRef(0)
  const resumeGenRef = useRef(0)

  const filterLogs = useCallback(
    (items: SessionListing[]): SessionListing[] =>
      items.filter(log => !log.isSidechain && matchesPrFilter(log, filterByPr)),
    [filterByPr],
  )

  useLoad(() => {
    const gen = ++loadGenRef.current
    loadingMoreRef.current = false
    setIsLoadingMore(false)
    setLoadError(null)
    setLogs(null)
    setReadFailures(undefined)
    setHasMore(false)
    allStatLogsRef.current = []
    nextIndexRef.current = 0
    void (async () => {
      try {
        const page: SessionPage = showAllProjects
          ? await listSessionsAcrossProjectsProgressive()
          : await listRepoSessionsProgressive(worktreePaths)
        if (loadGenRef.current !== gen) return
        allStatLogsRef.current = page.allStatLogs
        nextIndexRef.current = page.nextIndex
        setHasMore(page.nextIndex < page.allStatLogs.length)
        setReadFailures(page.readFailures)
        setLogs(filterLogs(page.logs))
      } catch (thrown) {
        if (loadGenRef.current !== gen) return
        logError(thrown)
        setLoadError(thrown instanceof Error ? thrown.message : String(thrown))
      }
    })()
    return () => {
      loadGenRef.current += 1
    }
  }, [showAllProjects, worktreePaths, filterLogs])

  const worktreeFailure = useMemo<SessionReadFailures | undefined>(
    () =>
      worktreeReadError
        ? { count: 1, firstPath: getOriginalCwd(), firstError: worktreeReadError }
        : undefined,
    [worktreeReadError],
  )

  const readNotice = useMemo(
    () => formatSessionReadFailures(mergeSessionReadFailures(worktreeFailure, readFailures)),
    [worktreeFailure, readFailures],
  )

  const handleLoadMore = useCallback(
    (count: number = LOAD_MORE_BATCH) => {
      if (loadingMoreRef.current) return
      const allStatLogs = allStatLogsRef.current
      const startIndex = nextIndexRef.current
      if (startIndex >= allStatLogs.length) return
      const batchSize = count > 0 ? count : LOAD_MORE_BATCH
      loadingMoreRef.current = true
      setIsLoadingMore(true)
      const gen = loadGenRef.current
      void (async () => {
        try {
          const batch = await enrichSessionListings(allStatLogs, startIndex, batchSize)
          if (loadGenRef.current !== gen) return
          nextIndexRef.current = batch.nextIndex
          setHasMore(batch.nextIndex < allStatLogs.length)
          if (batch.readFailures) {
            setReadFailures(prev => mergeSessionReadFailures(prev, batch.readFailures))
          }
          const nextLogs = filterLogs(batch.logs)
          if (nextLogs.length > 0) {
            setLogs(prev => (prev ? [...prev, ...nextLogs] : nextLogs))
          }
        } catch (thrown) {
          if (loadGenRef.current !== gen) return
          logError(thrown)
        } finally {
          if (loadGenRef.current === gen) {
            loadingMoreRef.current = false
            setIsLoadingMore(false)
          }
        }
      })()
    },
    [filterLogs],
  )

  const handleCancelExit = useCallback(() => {
    process.exit(1)
  }, [])

  const handleCancelResume = useCallback(() => {
    resumeGenRef.current += 1
    setResuming(false)
    setResumeNotice('resume cancelled — the session file is untouched; pick again, or esc to quit')
  }, [])

  const handleToggleAllProjects = useCallback(() => {
    setResumeNotice(null)
    setShowAllProjects(prev => !prev)
  }, [])

  const handleLogRenamed = useCallback((sessionId: string, customTitle: string) => {
    setLogs(prev =>
      prev
        ? prev.map(log =>
            sessionIdOfListing(log) === sessionId ? { ...log, customTitle } : log,
          )
        : prev,
    )
    allStatLogsRef.current = allStatLogsRef.current.map(log =>
      sessionIdOfListing(log) === sessionId ? { ...log, customTitle } : log,
    )
  }, [])

  const handleSelect = useCallback(
    (log: SessionListing) => {
      setResumeNotice(null)
      const cross = checkCrossProjectResume(log, showAllProjects, worktreePaths)
      if (cross.isCrossProject && !cross.isSameRepoWorktree) {
        void (async () => {
          let copied = false
          try {
            const sequence = await setClipboard(cross.command)
            if (sequence) process.stdout.write(sequence)
            copied = true
          } catch (thrown) {
            logError(thrown)
          }
          setResumeNotice(
            `that conversation lives in another folder — to resume it run: ${cross.command}${copied ? ' (copied to the clipboard)' : ''} · the picker stays open`,
          )
        })()
        return
      }
      const sessionId = sessionIdOfListing(log)
      if (!sessionId) {
        setResumeNotice(
          'could not resume — the session file carries no session id · the file was left untouched',
        )
        return
      }
      if (forkSession) {
        setResumeNotice(
          '--fork is not available here — pick the session without the flag; it resumes as itself',
        )
        return
      }
      const gen = ++resumeGenRef.current
      setResuming(true)
      void (async () => {
        try {
          initializeSurfaceRoute(ROOT_CHAT_ROUTE)
          const { focusResumedSession } = await import('../services/switchboard/hopIntoSession.js')
          const title = log.customTitle ?? log.agentName
          const outcome = await focusResumedSession(String(sessionId), log.fullPath, {
            ...(title ? { title } : {}),
            permissionMode: appStateStore.getState().toolPermissionContext.mode,
          })
          if (resumeGenRef.current !== gen) return
          if (outcome.ok) {
            setResuming(false)
            setResumed(true)
          } else {
            setResuming(false)
            setResumeNotice(`could not resume — ${outcome.reason}`)
          }
        } catch (thrown) {
          if (resumeGenRef.current !== gen) return
          logError(thrown)
          setResuming(false)
          setResumeNotice(
            `could not resume — ${thrown instanceof Error ? thrown.message : String(thrown)}`,
          )
        }
      })()
    },
    [appStateStore, forkSession, showAllProjects, worktreePaths],
  )

  const chatProps: ChatProps = {
    commands,
    initialTools,
    debug,
    disabled,
    disableSlashCommands,
  }

  let body: React.ReactNode
  if (resumed) {
    body = (
      <SurfaceRouter>
        <Chat {...chatProps} />
      </SurfaceRouter>
    )
  } else if (resuming) {
    body = (
      <ResumeWait
        text="Resuming conversation…"
        hint="esc or ctrl+c to cancel"
        onCancel={handleCancelResume}
      />
    )
  } else if (loadError !== null) {
    body = <LoadConversationsFailed error={loadError} />
  } else if (logs === null) {
    body = (
      <ResumeWait
        text="Loading conversations…"
        hint="esc or ctrl+c to cancel"
        onCancel={handleCancelExit}
      />
    )
  } else if (logs.length === 0) {
    body = <NoConversations readNotice={readNotice} />
  } else {
    body = (
      <Box flexDirection="column">
        {readNotice !== null ? (
          <Box paddingX={1}>
            <Text color="warning" wrap="wrap">
              {readNotice}
            </Text>
          </Box>
        ) : null}
        {resumeNotice !== null ? (
          <Box paddingX={1}>
            <Text color="warning" wrap="wrap">
              {resumeNotice}
            </Text>
          </Box>
        ) : null}
        <LogSelector
          logs={logs}
          onSelect={handleSelect}
          onCancel={handleCancelExit}
          initialSearchQuery={initialSearchQuery}
          showAllProjects={showAllProjects}
          onToggleAllProjects={handleToggleAllProjects}
          onLogRenamed={isCustomTitleEnabled() ? handleLogRenamed : undefined}
          onLoadMore={handleLoadMore}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          worktreePaths={worktreePaths}
        />
      </Box>
    )
  }

  if (!useAltScreenHost) return body
  return (
    <AlternateScreen mouseTracking={isMouseTrackingEnabled()}>
      {resumed ? body : <GroundFill>{body}</GroundFill>}
    </AlternateScreen>
  )
}
