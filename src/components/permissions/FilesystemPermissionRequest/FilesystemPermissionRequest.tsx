import * as React from 'react'
import { Text } from '../../../ink.js'
import { getGlobalConfig } from '../../../utils/config.js'
import { getSystemThemeName } from '../../../utils/systemTheme.js'
import { FallbackPermissionRequest } from '../FallbackPermissionRequest.js'
import { FilePermissionDialog } from '../FilePermissionDialog/FilePermissionDialog.js'
import type { ToolInput } from '../FilePermissionDialog/permissionOptions.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'

/** The concrete theme name for tool-use rendering ('auto' resolved). */
function resolveThemeName() {
  const configured = getGlobalConfig().theme
  return configured === 'auto' ? getSystemThemeName() : configured
}

function parseIdentity(input: unknown): ToolInput {
  return input as ToolInput
}

/**
 * Card for the read-ish filesystem tools (glob / grep / read). The tool's
 * read-only verdict is consulted BEFORE the path accessor; a tool with no
 * accessor, a throwing accessor, or no usable path falls back to the generic
 * card entirely — rendered WITHOUT the sticky-footer registrar.
 */
export function FilesystemPermissionRequest(props: PermissionRequestProps): React.ReactNode {
  const { toolUseConfirm, toolUseContext, onDone, onReject, verbose, workerBadge } = props
  const tool = toolUseConfirm.tool

  const readOnly = tool.isReadOnly(toolUseConfirm.input as never)

  let path: string | null = null
  let accessorUsable = false
  if (typeof tool.getPath === 'function') {
    try {
      const resolved = tool.getPath(toolUseConfirm.input as never)
      if (typeof resolved === 'string' && resolved !== '') {
        path = resolved
        accessorUsable = true
      }
    } catch {
      accessorUsable = false
    }
  }
  if (!accessorUsable) {
    return (
      <FallbackPermissionRequest
        toolUseConfirm={toolUseConfirm}
        toolUseContext={toolUseContext}
        onDone={onDone}
        onReject={onReject}
        verbose={verbose}
        workerBadge={workerBadge}
      />
    )
  }

  return (
    <FilePermissionDialog<ToolInput>
      toolUseConfirm={toolUseConfirm}
      toolUseContext={toolUseContext}
      onDone={onDone}
      onReject={onReject}
      title={readOnly ? 'Read file' : 'Edit file'}
      content={
        <Text>
          {tool.userFacingName(toolUseConfirm.input as never)}(
          {tool.renderToolUseMessage(toolUseConfirm.input as never, {
            theme: resolveThemeName(),
            verbose,
          })})
        </Text>
      }
      operationType={readOnly ? 'read' : 'write'}
      path={path}
      parseInput={parseIdentity}
      workerBadge={workerBadge}
    />
  )
}
