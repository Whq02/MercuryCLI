import React from 'react'
import { relative } from 'path'
import { Box, Text } from '../ink.js'
import { getCwd } from '../utils/cwd.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { HighlightedCode } from './HighlightedCode.js'
import { MessageResponse } from './MessageResponse.js'
import { notBuilt } from '../pi/holes.js'

export function NotebookEditToolUseRejectedMessage(arg0: {
  notebook_path: string
  cell_id?: string
  new_source: string
  cell_type?: 'code' | 'markdown'
  edit_mode?: string
  verbose: boolean
}): React.ReactNode {
  return notBuilt('src/components/NotebookEditToolUseRejectedMessage.tsx:10')
}

export default NotebookEditToolUseRejectedMessage
