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

  context.setAppState(prev => ({
    ...prev,
    toolPermissionContext: applyPermissionUpdate(prev.toolPermissionContext, update),
  }))

  SandboxManager.refreshConfig()

  if (!remember) {
    onDone(
      `Added ${chalk.bold(absolutePath)} as a working directory for this session.${MANAGE_HINT}`,
    )
    return
  }
  try {
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
