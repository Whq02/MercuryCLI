import * as React from 'react'
import { useMemo, useState } from 'react'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { Box, NoSelect, Text } from '../../../ink.js'
import { intersperse } from '../../../utils/array.js'
import { getPatchForDisplay } from '../../../utils/diff.js'
import { HighlightedCode } from '../../HighlightedCode.js'
import { StructuredDiff } from '../../StructuredDiff.js'
// The row budget, plan and hunk walk live in ../boundedDiffPreview.ts — the
// ONE home of the bounded-preview law, shared with the Edit/sed consent
// cards (prove-consent-preview-bounded pins it there).
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
  // THE BOUNDED-PREVIEW LAW (operator live-drive, block G): a create/
  // overwrite consent card must never paint the whole file body — an
  // over-viewport card cannot scroll in the inline region and eats the
  // screen. The preview shows the head within a viewport-derived budget
  // plus an honest "… +N more" tail; ctrl+o expands to the full body on
  // the operator's explicit ask (and collapses back).
  const [expanded, setExpanded] = useState(false)
  // A Confirmation-context chord that Global does NOT bind (the ctrl+e
  // explanation-toggle precedent): resolution is per-hook, so a globally
  // bound chord (ctrl+o) fired the transcript toggle behind the card.
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

  // The bounded projection of whichever branch renders. Hunks bound at LINE
  // granularity (a full-file overwrite is one monster hunk — hunk-level
  // slicing alone would not bound it); the create branch bounds the body's
  // line list directly.
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
