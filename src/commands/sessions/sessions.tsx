import { useEffect, useRef, useState } from 'react'
import type { UUID } from 'crypto'
import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { LogSelector } from '../../components/LogSelector.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Spinner } from '../../components/Spinner.js'
import { SessionManagerView } from '../../components/mercury-ui/screens/SessionManagerView.js'
import { useIsInsideModal } from '../../context/modalContext.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type { ResumeEntrypoint } from '../../commands.js'
import type { LocalJSXCommandCall, LocalJSXCommandContext, LocalJSXCommandOnDone } from '../../types/command.js'
import type { SessionListing } from '../../types/logs.js'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { conversationIdHere } from '../../services/engine-connector/focusedConnector.js'
import { getWorktreePathsPortable } from '../../utils/getWorktreePathsPortable.js'
import { checkCrossProjectResume } from '../../utils/crossProjectResume.js'
import { filterResumableSessions } from '../../utils/sessionResumeFilter.js'
import { setClipboard } from '../../ink/termio/osc.js'
import { validateUuid } from '../../utils/uuid.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import {
  lastSession,
  sessionIdOfListing,
  isCustomTitleEnabled,
  isLiteListing,
  listSessionsAcrossProjects,
  fillSessionListing,
  listRepoSessions,
  searchSessionsByCustomTitle,
} from '../../utils/sessionStorage.js'

async function performResume(
  context: LocalJSXCommandContext,
  onDone: LocalJSXCommandOnDone,
  sessionId: UUID,
  log: SessionListing,
  entrypoint: ResumeEntrypoint,
): Promise<void> {
  try {
    await context.resume?.(sessionId, log, entrypoint)
    onDone(undefined, { display: 'skip' })
  } catch (thrown) {
    logError(thrown)
    onDone(`Failed to resume: ${errorMessage(thrown)}`)
  }
}

function SessionsErrorCard({
  argument,
  message,
  onDone,
}: {
  argument: string
  message: string
  onDone: LocalJSXCommandOnDone
}): React.ReactNode {
  useEffect(() => {
    const timer = setTimeout(() => onDone(undefined, { display: 'skip' }), 0)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text dimColor>
          › /sessions{argument ? ` ${argument}` : ''}
        </Text>
        <Text>{message}</Text>
      </Box>
    </MessageResponse>
  )
}

function SessionsLogPicker({
  onDone,
  context,
}: {
  onDone: LocalJSXCommandOnDone
  context: LocalJSXCommandContext
}): React.ReactNode {
  const size = useTerminalSize()
  const insideModal = useIsInsideModal()
  const [logs, setLogs] = useState<SessionListing[] | null>(null)
  const [showAllProjects, setShowAllProjects] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)
  const [resuming, setResuming] = useState(false)
  const worktreePathsRef = useRef<string[]>([])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const worktreePaths = await getWorktreePathsPortable(getOriginalCwd())
        worktreePathsRef.current = worktreePaths
        const loaded = showAllProjects
          ? await listSessionsAcrossProjects()
          : await listRepoSessions(worktreePaths)
        if (cancelled) return
        const resumable = filterResumableSessions(loaded, conversationIdHere())
        if (resumable.length === 0) {
          onDone('No conversations found to resume.')
          return
        }
        setLogs(resumable)
      } catch (thrown) {
        if (cancelled) return
        logError(thrown)
        onDone(`Failed to load conversations: ${errorMessage(thrown)}`)
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAllProjects, reloadNonce])

  const handleSelect = (log: SessionListing): void => {
    setResuming(true)
    void (async () => {
      const rawId = sessionIdOfListing(log)
      const sessionId = rawId !== undefined ? validateUuid(rawId) : null
      if (sessionId === null) {
        onDone('Failed to resume: could not determine the session id.')
        return
      }
      const full = isLiteListing(log) ? await fillSessionListing(log) : log
      const cross = checkCrossProjectResume(full, showAllProjects, worktreePathsRef.current)
      if (cross.isCrossProject && !cross.isSameRepoWorktree) {
        try {
          const sequence = await setClipboard(cross.command)
          if (sequence) process.stdout.write(sequence)
        } catch (thrown) {
          logError(thrown)
        }
        onDone(
          [
            'This conversation is from a different directory. To resume it, run:',
            `  ${cross.command}`,
            '(copied to the clipboard)',
          ].join('\n'),
          { display: 'user' },
        )
        return
      }
      await performResume(context, onDone, sessionId, full, 'slash_command_picker')
    })()
  }

  if (resuming || logs === null) {
    return (
      <Box>
        <Spinner />
        <Text> Loading conversations…</Text>
      </Box>
    )
  }
  const maxHeight = insideModal ? Math.floor(size.rows / 2) : size.rows - 2
  return (
    <LogSelector
      logs={logs}
      onSelect={handleSelect}
      maxHeight={maxHeight}
      showAllProjects={showAllProjects}
      onToggleAllProjects={() => setShowAllProjects(current => !current)}
      onLogsChanged={() => setReloadNonce(nonce => nonce + 1)}
      onCancel={() => onDone('Resume cancelled.', { display: 'system' })}
    />
  )
}

function SessionsByArgument({
  argument,
  onDone,
  context,
}: {
  argument: string
  onDone: LocalJSXCommandOnDone
  context: LocalJSXCommandContext
}): React.ReactNode {
  const [cardMessage, setCardMessage] = useState<string | null>(null)
  const ranRef = useRef(false)

  useEffect(() => {
    if (ranRef.current) return
    ranRef.current = true
    void (async () => {
      try {
        const worktreePaths = await getWorktreePathsPortable(getOriginalCwd())
        const logs = await listRepoSessions(worktreePaths)
        if (logs.length === 0) {
          setCardMessage('No conversations found to resume.')
          return
        }
        const uuid = validateUuid(argument)
        if (uuid !== null) {
          const matches = logs.filter(log => sessionIdOfListing(log) === uuid)
          if (matches.length > 0) {
            const mostRecent = [...matches].sort(
              (a, b) => (b.modified?.getTime?.() ?? 0) - (a.modified?.getTime?.() ?? 0),
            )[0]!
            const full = isLiteListing(mostRecent) ? await fillSessionListing(mostRecent) : mostRecent
            await performResume(context, onDone, uuid, full, 'slash_command_session_id')
            return
          }
          const direct = await lastSession(uuid)
          if (direct) {
            await performResume(context, onDone, uuid, direct, 'slash_command_session_id')
            return
          }
        }
        if (isCustomTitleEnabled()) {
          const matches = await searchSessionsByCustomTitle(argument, { exact: true })
          if (matches.length > 1) {
            setCardMessage(
              `${matches.length} sessions match "${argument}" — run /sessions to pick a specific one.`,
            )
            return
          }
          if (matches.length === 1) {
            const match = matches[0]!
            const rawId = sessionIdOfListing(match)
            const sessionId = rawId !== undefined ? validateUuid(rawId) : null
            if (sessionId !== null) {
              const full = isLiteListing(match) ? await fillSessionListing(match) : match
              await performResume(context, onDone, sessionId, full, 'slash_command_title')
              return
            }
          }
        }
        setCardMessage(`No session found matching "${argument}".`)
      } catch (thrown) {
        logError(thrown)
        setCardMessage(`Failed to resume: ${errorMessage(thrown)}`)
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (cardMessage !== null) {
    return <SessionsErrorCard argument={argument} message={cardMessage} onDone={onDone} />
  }
  return (
    <Box>
      <Spinner />
    </Box>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const trimmed = (args ?? '').trim()
  if (trimmed === '') {
    if (context.resume) {
      const close = (value?: unknown, options?: Parameters<LocalJSXCommandOnDone>[1]): void => {
        if (typeof value === 'string') onDone(value, options)
        else onDone(undefined, { display: 'skip', ...options })
      }
      return (
        <SessionManagerView
          onClose={close}
          onCloseAll={() => onDone(undefined, { display: 'skip' })}
          onResume={(sessionId, log, entrypoint) => context.resume!(sessionId, log, entrypoint)}
          onNewSession={() =>
            onDone(undefined, { display: 'skip', nextInput: '/clear', submitNextInput: true })
          }
        />
      )
    }
    return <SessionsLogPicker onDone={onDone} context={context} />
  }
  return <SessionsByArgument argument={trimmed} onDone={onDone} context={context} />
}
