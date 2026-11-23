import * as React from 'react'
import { Text } from '../../../screen/themedRenderer.js'
import { resolveThemeName } from '../resolveThemeName.js'
import { ConsentBodyText } from '../ConsentBodyText.js'
import { FallbackPermissionRequest } from '../FallbackPermissionRequest.js'
import { FilePermissionDialog } from '../file-dialog/FilePermissionDialog.js'
import type { ToolInput } from '../file-dialog/permissionOptions.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'

function parseIdentity(input: unknown): ToolInput {
  return input as ToolInput
}

export function FilesystemPermissionRequest(props: PermissionRequestProps): React.ReactNode {
  const { toolUseConfirm, toolUseContext, onDone, onReject, verbose, workerBadge } = props
  const tool = toolUseConfirm.tool

  const readOnly = tool.isReadOnly(toolUseConfirm.input)

  let path: string | null = null
  let accessorUsable = false
  if (typeof tool.getPath === 'function') {
    try {
      const resolved = tool.getPath(toolUseConfirm.input)
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

  const name = tool.userFacingName(toolUseConfirm.input)
  const useMessage = tool.renderToolUseMessage(toolUseConfirm.input, {
    theme: resolveThemeName(),
    verbose,
  })

  return (
    <FilePermissionDialog<ToolInput>
      toolUseConfirm={toolUseConfirm}
      onDone={onDone}
      onReject={onReject}
      title={readOnly ? 'Read file' : 'Edit file'}
      content={
        typeof useMessage === 'string' ? (
          <ConsentBodyText text={`${name}(${useMessage})`} />
        ) : (
          <Text>
            {name}({useMessage})
          </Text>
        )
      }
      operationType={readOnly ? 'read' : 'write'}
      path={path}
      parseInput={parseIdentity}
      workerBadge={workerBadge}
    />
  )
}
