// A rejected write/update: one dimmed line naming the operation and the
// path, then (write-with-content) a bounded highlighted preview, or (patch)
// the dimmed diff — nothing more in condensed non-verbose style.

import React from 'react'
import { relative } from 'path'
import { Box, Text } from '../ink.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import type { StructuredPatchHunk } from '../utils/diff.js'
import { getCwd } from '../utils/cwd.js'
import { HighlightedCode } from './HighlightedCode.js'
import { MessageResponse } from './MessageResponse.js'
import { StructuredDiffList } from './StructuredDiffList.js'

const PREVIEW_LINES = 10

export function FileEditToolUseRejectedMessage({
  file_path,
  operation,
  patch,
  firstLine,
  fileContent,
  content,
  style,
  verbose,
}: {
  file_path: string
  operation: 'write' | 'update'
  patch?: StructuredPatchHunk[]
  firstLine: string | null
  fileContent?: string
  content?: string
  style?: 'condensed'
  verbose: boolean
}): React.ReactNode {
  const { columns } = useTerminalSize()
  const displayPath = verbose ? file_path : relative(getCwd(), file_path)
  const line = (
    <MessageResponse height={1}>
      <Text dimColor wrap="wrap">
        Operator rejected {operation} to <Text bold>{displayPath}</Text>
      </Text>
    </MessageResponse>
  )

  if (style === 'condensed' && !verbose) return line

  if (operation === 'write' && content !== undefined) {
    if (content === '') {
      return (
        <Box flexDirection="column">
          {line}
          <MessageResponse height={1}>
            <Text dimColor>(no content)</Text>
          </MessageResponse>
        </Box>
      )
    }
    const lines = content.split('\n')
    const shown = verbose ? lines : lines.slice(0, PREVIEW_LINES)
    const truncated = lines.length - shown.length
    return (
      <Box flexDirection="column">
        {line}
        <MessageResponse>
          <Box flexDirection="column">
            <HighlightedCode
              code={shown.join('\n')}
              filePath={file_path}
              width={columns - 12}
            />
            {truncated > 0 ? <Text dimColor>+{truncated} lines</Text> : null}
          </Box>
        </MessageResponse>
      </Box>
    )
  }

  if (patch && patch.length > 0) {
    return (
      <Box flexDirection="column">
        {line}
        <MessageResponse>
          <StructuredDiffList
            hunks={patch}
            dim
            width={columns - 12}
            filePath={file_path}
            firstLine={firstLine}
            fileContent={fileContent}
          />
        </MessageResponse>
      </Box>
    )
  }

  return line
}

export default FileEditToolUseRejectedMessage
