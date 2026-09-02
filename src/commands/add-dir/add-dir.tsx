import * as React from 'react'
import { useEffect } from 'react'
import chalk from 'chalk'
import figures from 'figures'
import { Box, Text } from '../../ink.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { AddWorkspaceDirectory } from '../../components/permissions/rules/AddWorkspaceDirectory.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import type { PermissionUpdate } from '../../types/permissions.js'
import {
  applyPermissionUpdate,
  persistPermissionUpdate,
} from '../../utils/permissions/PermissionUpdate.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { errorMessage } from '../../utils/errors.js'
import { addDirHelpMessage, validateDirectoryForWorkspace } from './validation.js'

const MANAGE_HINT = chalk.dim(' Manage working directories with /permissions.')

/**
 * Add a directory to the session's workspace, session-only or persisted to
 * local settings. Shared by the bare-command form path and the pre-validated
 * argument path.
 */
async function addDirectory(
  absolutePath: string,
  remember: boolean,
  context: LocalJSXCommandContext,
  onDone: LocalJSXCommandOnDone,
): Promise<void> {
  const update: PermissionUpdate = {
    type: 'addDirectories',
    directories: [absolutePath],
    destination: remember ? 'localSettings' : 'session',
  }

  // Apply against the LATEST app state — the updater's previous value, never
  // a state captured when the command mounted. The widened workspace reaches
  // the instruction roots through the ONE state-change choke point
  // (state/onChangeAppState.ts → the engine's syncInstructionRootsWithWorkspace):
  // the directory's MERCURY.md, rules and nested guides compose from the
  // next turn on.
  context.setAppState(prev => ({
    ...prev,
    toolPermissionContext: applyPermissionUpdate(prev.toolPermissionContext, update),
  }))

  // Unconditional, and immediately: session-only directories reach the
  // sandbox only through the bootstrap list, and even persisted ones must be
  // reachable by a shell command in the very next turn, before the settings
  // subscription fires.
  SandboxManager.refreshConfig()

  if (!remember) {
    onDone(
      `Added ${chalk.bold(absolutePath)} as a working directory for this session.${MANAGE_HINT}`,
    )
    return
  }
  try {
    // The persist verdict is the truth of the write: a refused settings
    // write (a file mid-edit, a refused publish) is reported as such, not
    // as "saved".
    const { error } = persistPermissionUpdate(update)
    if (error !== null) throw error
    onDone(
      `Added ${chalk.bold(absolutePath)} as a working directory and saved it to local settings.${MANAGE_HINT}`,
    )
  } catch (error) {
    onDone(
      `Added ${chalk.bold(absolutePath)} as a working directory, but saving it to local settings failed: ${errorMessage(error)}.${MANAGE_HINT}`,
    )
  }
}

/**
 * The invalid-argument feedback block: a dimmed echo of the command as
 * typed, then the help message. It schedules its own completion on a
 * zero-delay timer so it prints into scrollback and immediately hands
 * control back instead of staying mounted.
 */
function AddDirFeedback({
  echo,
  message,
  onTimeout,
}: {
  echo: string
  message: string
  onTimeout: () => void
}): React.ReactNode {
  useEffect(() => {
    const timer = setTimeout(onTimeout, 0)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text dimColor>
          {figures.pointer} {echo}
        </Text>
        <Text>{message}</Text>
      </Box>
    </MessageResponse>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const trimmed = args.trim()
  const permissionContext = context.getAppState().toolPermissionContext

  if (!trimmed) {
    return (
      <AddWorkspaceDirectory
        onAddDirectory={(path, remember) => {
          void addDirectory(path, remember === true, context, onDone)
        }}
        onCancel={() => onDone('Did not add a working directory.')}
        permissionContext={permissionContext}
      />
    )
  }

  const result = await validateDirectoryForWorkspace(trimmed, permissionContext)
  if (result.resultType !== 'success') {
    const message = addDirHelpMessage(result)
    return (
      <AddDirFeedback
        echo={`/add-dir ${trimmed}`}
        message={message}
        onTimeout={() => onDone(message)}
      />
    )
  }

  return (
    <AddWorkspaceDirectory
      directoryPath={result.absolutePath}
      onAddDirectory={(path, remember) => {
        void addDirectory(path, remember === true, context, onDone)
      }}
      onCancel={() => onDone(`Did not add ${result.absolutePath} as a working directory.`)}
      permissionContext={permissionContext}
    />
  )
}
