import * as React from 'react'
import { useMemo, useState } from 'react'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { Box, NoSelect, Text } from '../../../ink.js'
import { intersperse } from '../../../utils/array.js'
import { getPatchForDisplay } from '../../../utils/diff.js'
import { HighlightedCode } from '../../HighlightedCode.js'
import { StructuredDiff } from '../../StructuredDiff.js'
import {
  boundHunks,
  boundLines,
  consentBodyBudget,
  consentContentWidth,
  diffPaintWidth,
  filePaintWidth,
} from '../consentBodyBudget.js'
import type { StructuredPatchHunk } from 'diff'
type Props = {
  file_path: string
  content: string
  oldContent: string
  fileExists: boolean
}

const FRAME_COLUMNS = 2

export function FileWriteToolDiff({
  file_path,
  content,
  oldContent,
  fileExists,
}: Props): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const [expanded, setExpanded] = useState(false)

  useKeybinding('confirm:toggleFullPreview', () => setExpanded(prev => !prev), {
    context: 'Confirmation',
  })

  const budget = expanded ? null : consentBodyBudget(rows)
  const previewWidth = Math.max(1, consentContentWidth(columns) - FRAME_COLUMNS)

  const patch: StructuredPatchHunk[] | null = useMemo(
    () =>
      fileExists
        ? getPatchForDisplay({
            filePath: file_path,
            fileContents: oldContent,
            edits: [
              {
                old_string: oldContent,
                new_string: content,
                replace_all: false,
              },
            ],
          })
        : null,
    [fileExists, file_path, oldContent, content],
  )

  let body: React.ReactNode
  let hiddenLines = 0

  if (patch !== null) {
    const paintWidth = diffPaintWidth(previewWidth, patch)
    const bounded = boundHunks(patch, paintWidth, budget)
    hiddenLines = bounded.hiddenLines
    const firstLine = content.split('\n')[0] ?? null
    body = intersperse<React.ReactNode>(
      bounded.hunks.map(hunk => (
        <StructuredDiff
          key={hunk.newStart}
          patch={hunk}
          dim={false}
          filePath={file_path}
          firstLine={firstLine}
          fileContent={oldContent}
          width={previewWidth}
        />
      )),
      index => (
        <NoSelect key={`ellipsis-${index}`} fromLeftEdge>
          <Text dimColor>...</Text>
        </NoSelect>
      ),
    )
  } else {
    const displayText = content || '(No content)'
    const lines = displayText.split('\n')
    if (lines.length > 1 && lines[lines.length - 1] === '') {
      lines.pop()
    }
    const paintWidth = filePaintWidth(previewWidth, lines.length)
    const bounded = boundLines(lines, paintWidth, budget)
    hiddenLines = bounded.hiddenLines
    body = (
      <HighlightedCode
        code={bounded.lines.join('\n')}
        filePath={file_path}
      />
    )
  }

  return (
    <Box flexDirection="column">
      <Box
        borderColor="subtle"
        borderStyle="dashed"
        flexDirection="column"
        borderLeft={false}
        borderRight={false}
        paddingX={1}
      >
        {body}
        {hiddenLines > 0 && (
          <NoSelect fromLeftEdge>
            <Text dimColor>
              … +{hiddenLines} more {hiddenLines === 1 ? 'line' : 'lines'} · ctrl+f expands
            </Text>
          </NoSelect>
        )}
        {expanded && (
          <NoSelect fromLeftEdge>
            <Text dimColor>ctrl+f collapses the preview</Text>
          </NoSelect>
        )}
      </Box>
    </Box>
  )
}
