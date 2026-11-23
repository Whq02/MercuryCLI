import React from 'react'
import { relative } from 'path'
import { Box, Text } from '../../screen/themedRenderer.js'
import { getCwd } from '../../platform/files/cwd.js'
import { useTerminalSize } from '../../screen/fullscreen-layout/useTerminalSize.js'
import { HighlightedCode } from '../../screen/highlighted-code/HighlightedCode.js'
import { MessageResponse } from '../kit/MessageResponse.js'

const BODY_INSET = 12

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
      {edit_mode === 'delete' ? null : (
        <MessageResponse>
          <HighlightedCode
            code={new_source}
            filePath={cell_type === 'markdown' ? 'cell.md' : 'cell.py'}
            width={columns - BODY_INSET}
          />
        </MessageResponse>
      )}
    </Box>
  )
}

export default NotebookEditToolUseRejectedMessage
