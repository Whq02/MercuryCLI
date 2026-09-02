// A rejected notebook edit: the dimmed rejection line naming the operation,
// path and cell, then (unless deleting) the new source as highlighted code
// with an extension matching the cell type.

import React from 'react'
import { relative } from 'path'
import { Box, Text } from '../ink.js'
import { getCwd } from '../utils/cwd.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { HighlightedCode } from './HighlightedCode.js'
import { MessageResponse } from './MessageResponse.js'

export function NotebookEditToolUseRejectedMessage({
  notebook_path,
  cell_id,
  new_source,
  cell_type,
  edit_mode,
  verbose,
}: {
  notebook_path: string
  cell_id?: string
  new_source: string
  cell_type?: 'code' | 'markdown'
  edit_mode?: string
  verbose: boolean
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const displayPath = verbose ? notebook_path : relative(getCwd(), notebook_path)
  const operation =
    edit_mode === 'delete' ? 'delete' : `${edit_mode ?? 'replace'} cell in`
  return (
    <Box flexDirection="column">
      <MessageResponse height={1}>
        <Text dimColor wrap="wrap">
          Operator rejected {operation} <Text bold>{displayPath}</Text> (cell{' '}
          {cell_id ?? '?'})
        </Text>
      </MessageResponse>
      {edit_mode !== 'delete' ? (
        <MessageResponse>
          <HighlightedCode
            code={new_source}
            filePath={cell_type === 'markdown' ? 'cell.md' : 'cell.py'}
            width={columns - 12}
          />
        </MessageResponse>
      ) : null}
    </Box>
  )
}

export default NotebookEditToolUseRejectedMessage
