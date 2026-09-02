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
  boundHunksToRows,
  boundedPreviewPlan,
  consentDiffBudget,
} from '../boundedDiffPreview.js'
import type { StructuredPatchHunk } from 'diff'
type Props = {
  file_path: string
  content: string
  fileExists: boolean
  oldContent: string
}

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
  const budget = consentDiffBudget(rows)

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
  const bodyWidth = Math.max(1, columns - 4)

  const bounded = useMemo(() => {
    if (hunks) {
      const total = hunks.reduce((n, h) => n + h.lines.length, 0)
      const plan = boundedPreviewPlan(total, budget, expanded)
      if (plan.hidden === 0) return { hunks, body: null, hidden: 0 }
      return { hunks: boundHunksToRows(hunks, plan.shown), body: null, hidden: plan.hidden }
    }
    const lines = (content || '(No content)').split('\n')
    const plan = boundedPreviewPlan(lines.length, budget, expanded)
    return {
      hunks: null,
      body: lines.slice(0, plan.shown).join('\n'),
      hidden: plan.hidden,
    }
  }, [hunks, content, budget, expanded])

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
