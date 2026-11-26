import { useRef, useState } from 'react'
import type { UUID } from 'crypto'
import * as React from 'react'
import { Box, Text } from '../../screen/themedRenderer.js'
import { SessionBrowser } from '../../screen/session-chooser/SessionBrowser.js'
import { MessageResponse } from '../../tools/kit/MessageResponse.js'
import { Spinner } from '../../screen/spinner/Spinner.js'
import { SessionManagerView } from '../../screen/widgets/faces/SessionManagerView.js'
import { useIsInsideModal } from '../../screen/overlays/modalContext.js'
import { useTerminalSize } from '../../screen/fullscreen-layout/useTerminalSize.js'
import { useLoad, useTimer } from '../../screen/effects/effects.js'
import type { ResumeEntrypoint } from '../catalogue/commands.js'
import type { LocalJSXCommandCall, LocalJSXCommandContext, LocalJSXCommandOnDone } from '../catalogue/command.js'
import { compareSessionListings, type SessionListing } from '../../sessions/transcripts/transcriptEntries.js'
import { getOriginalCwd } from '../../boot/process-state/processState.js'
import { conversationIdHere } from '../../engine/connector/focusedConnector.js'
import { getWorktreePathsPortable } from '../../platform/git/worktree/worktreePathsPortable.js'
import { checkCrossProjectResume } from '../../screen/session-chooser/crossProjectResume.js'
import { filterResumableSessions } from '../../sessions/transcripts/listedSessions.js'
import { setClipboard } from '../../screen/renderer/termio/osc.js'
import { validateUuid } from '../../platform/primitives/uuid.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { logError } from '../../platform/logs/errorLog.js'
import {
  lastSession,
  sessionIdOfListing,
  isCustomTitleEnabled,
  isLiteListing,
  listSessionsAcrossProjects,
  fillSessionListing,
  listRepoSessions,
  searchSessionsByCustomTitle,
} from '../../sessions/transcripts/sessionStorage.js'
import { startTimeout, stopTimeout } from '../../platform/async/timers.js'

export async function crossProjectResumeNotice(
  command: string,
  copy: typeof setClipboard = setClipboard,
): Promise<string> {
  let copied = false
  try {
    const sequence = await copy(command)
    if (sequence) process.stdout.write(sequence)
    copied = true
  } catch (thrown) {
    logError(thrown)
  }
  return [
    'This conversation is from a different directory. To resume it, run:',
    `  ${command}`,
    ...(copied ? ['(copied to the clipboard)'] : []),
  ].join('\n')
}

async function performResume(
  context: LocalJSXCommandContext,
  onDone: LocalJSXCommandOnDone,
  sessionId: UUID,
  log: SessionListing,
  entrypoint: ResumeEntrypoint,
): Promise<void> {
  try {
    if (context.resume) await context.resume(sessionId, log, entrypoint)
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
  useTimer(() => {
    const timer = startTimeout(() => {
      onDone(undefined, { display: 'skip' })
    }, 0)
    return () => {
      stopTimeout(timer)
    }
  }, [])

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text dimColor>{argument === '' ? '› /sessions' : `› /sessions ${argument}`}</Text>
        <Text>{message}</Text>
      </Box>
    </MessageResponse>
  )
}

function SessionsListingPicker({
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

  useLoad(signal => {
    void (async () => {
      try {
        const worktreePaths = await getWorktreePathsPortable(getOriginalCwd())
        worktreePathsRef.current = worktreePaths
        const loaded = showAllProjects
          ? await listSessionsAcrossProjects()
          : await listRepoSessions(worktreePaths)
        if (signal.aborted) return
        const resumable = filterResumableSessions(loaded, conversationIdHere())
        if (resumable.length === 0) {
          onDone('No conversations found to resume.')
          return
        }
        setLogs(resumable)
      } catch (thrown) {
        if (signal.aborted) return
        logError(thrown)
        onDone(`Failed to load conversations: ${errorMessage(thrown)}`)
      }
    })()
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
        onDone(await crossProjectResumeNotice(cross.command), { display: 'user' })
        return
      }
      await performResume(context, onDone, sessionId, full, 'slash_command_picker')
    })().catch(thrown => {
      logError(thrown)
      onDone(`Failed to resume: ${errorMessage(thrown)}`)
    })
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
    <SessionBrowser
      logs={logs}
      onSelect={handleSelect}
      maxHeight={maxHeight}
      showAllProjects={showAllProjects}
      onToggleAllProjects={() => setShowAllProjects(current => !current)}
      onListingsChanged={() => setReloadNonce(nonce => nonce + 1)}
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

  useLoad(() => {
    if (ranRef.current) return
    ranRef.current = true
    void (async () => {
      try {
        const worktreePaths = await getWorktreePathsPortable(getOriginalCwd())
        const logs = await listRepoSessions(worktreePaths)
        const uuid = validateUuid(argument)
        if (uuid !== null) {
          const matches = logs.filter(log => sessionIdOfListing(log) === uuid)
          if (matches.length > 0) {
            const mostRecent = [...matches].sort(compareSessionListings)[0]!
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
        setCardMessage(logs.length === 0 ? 'No conversations found to resume.' : `No session found matching "${argument}".`)
      } catch (thrown) {
        logError(thrown)
        setCardMessage(`Failed to resume: ${errorMessage(thrown)}`)
      }
    })()
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
    return <SessionsListingPicker onDone={onDone} context={context} />
  }
  return <SessionsByArgument argument={trimmed} onDone={onDone} context={context} />
}
