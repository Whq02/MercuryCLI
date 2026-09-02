import * as React from 'react'
import { Box, Text } from '../../../ink.js'
import { Select } from '../../CustomSelect/select.js'
import { useTabHeaderFocus } from '../../design-system/Tabs.js'
import { getFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js'
import type { ToolPermissionContext } from '../../../Tool.js'

const ADD_VALUE = '__add-directory__'

/**
 * The additional working-directory list. The original working directory is a
 * NON-selectable row above the selector; each additional directory row asks
 * to remove it; the add row opens the add flow.
 */
export function WorkspaceTab({
  onExit,
  toolPermissionContext,
  onRequestAddDirectory,
  onRequestRemoveDirectory,
  onHeaderFocusChange,
}: {
  onExit: () => void
  toolPermissionContext: ToolPermissionContext
  onRequestAddDirectory: () => void
  onRequestRemoveDirectory: (path: string) => void
  onHeaderFocusChange?: (focused: boolean) => void
}): React.ReactNode {
  const { headerFocused, focusHeader } = useTabHeaderFocus()
  const directories = [...toolPermissionContext.additionalWorkingDirectories.keys()]

  const options = [
    ...directories.map(path => ({ label: path, value: path })),
    { label: 'Add a directory…', value: ADD_VALUE },
  ]

  return (
    <Box flexDirection="column">
      <Text>
        Mercury can read files in the workspace, and edit them when implement mode is on.
      </Text>
      <Box gap={1}>
        <Text>{getFocusedSessionConnector().workspace().originalCwd}</Text>
        <Text dimColor>(original working directory)</Text>
      </Box>
      <Select
        options={options}
        visibleOptionCount={Math.min(10, options.length)}
        isDisabled={headerFocused}
        onChange={value => {
          if (value === ADD_VALUE) onRequestAddDirectory()
          else onRequestRemoveDirectory(value)
        }}
        onCancel={onExit}
        onUpFromFirstItem={() => {
          focusHeader()
          onHeaderFocusChange?.(true)
        }}
      />
    </Box>
  )
}
