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
  fileExists: boolean
  oldContent: string
}

const FRAME_COLUMNS = 2

export function FileWriteToolDiff({
  file_path,
  content,
  fileExists,
  oldContent,
}: Props): React.ReactNode {
  const { columns, rows } = useTerminalSize()
  const [expanded, setExpanded] = useState(false)
  useKeybinding('confirm:toggleFullPreview', () => setExpanded(prev => !prev), {
    context: 'Confirmation',
  })
  const budget = expanded ? null : consentBodyBudget(rows)

  const hunks = useMemo(() => {
    if (!fileExists) {
      return null
    }
    return getPatchForDisplay({
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
  }, [fileExists, file_path, oldContent, content])

  const firstLine = content.split('\n')[0] ?? null
  const paddingX = 1
  const bodyWidth = Math.max(1, consentContentWidth(columns) - FRAME_COLUMNS)

  const bounded = useMemo(() => {
    if (hunks) {
      const plan = boundHunks(hunks, diffPaintWidth(bodyWidth, hunks), budget)
      return { hunks: plan.hunks, body: null, hidden: plan.hiddenLines }
    }
    const lines = (content || '(No content)').split('\n')
    const plan = boundLines(lines, filePaintWidth(bodyWidth, lines.length), budget)
    return { hunks: null, body: plan.lines.join('\n'), hidden: plan.hiddenLines }
  }, [hunks, content, bodyWidth, budget])

  return (
    <Box flexDirection="column">
      <Box
        borderColor="subtle"
        borderStyle="dashed"
        flexDirection="column"
        borderLeft={false}
        borderRight={false}
        paddingX={paddingX}
      >
        {bounded.hunks ? (
          intersperse(
            bounded.hunks.map((_: StructuredPatchHunk) => (
              <StructuredDiff
                key={_.newStart}
                patch={_}
                dim={false}
                filePath={file_path}
                firstLine={firstLine}
                fileContent={oldContent}
                width={bodyWidth}
              />
            )),
            (i: number) => (
              <NoSelect fromLeftEdge key={`ellipsis-${i}`}>
                <Text dimColor>...</Text>
              </NoSelect>
            ),
          )
        ) : (
          <HighlightedCode
            code={bounded.body ?? '(No content)'}
            filePath={file_path}
          />
        )}
        {bounded.hidden > 0 ? (
          <NoSelect fromLeftEdge>
            <Text dimColor>
              … +{bounded.hidden} more line{bounded.hidden === 1 ? '' : 's'} · ctrl+f expands
            </Text>
          </NoSelect>
        ) : null}
        {expanded ? (
          <NoSelect fromLeftEdge>
            <Text dimColor>ctrl+f collapses the preview</Text>
          </NoSelect>
        ) : null}
      </Box>
    </Box>
  )
}
