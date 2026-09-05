
import * as React from 'react'
import { useMemo, useState } from 'react'
import { Box, Text } from '../../../ink.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { ApolloReviewCard } from '../../../tools/ApolloReviewTool/UI.js'
import type { Input } from '../../../tools/ApolloReviewTool/ApolloReviewTool.js'
import { boundLines, consentBodyBudget, consentContentWidth } from '../consentBodyBudget.js'
import { PermissionDialog } from '../PermissionDialog.js'
import {
  PermissionPrompt,
  type PermissionPromptOption,
} from '../PermissionPrompt.js'
import { usePermissionRequestLogging } from '../hooks.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'

type ApolloOptionValue = 'build' | 'build-ask-first' | 'more-questions'

const REVIEW_CHROME_ROWS = 6
const REVIEW_INDENT_COLUMNS = 4

export function ApolloReviewPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const input = toolUseConfirm.input as unknown as Input

  usePermissionRequestLogging(
    toolUseConfirm,
    useMemo(() => ({ completion_type: 'tool_use_single', language_name: 'none' }), []),
  )

  const { columns, rows } = useTerminalSize()
  const [expanded, setExpanded] = useState(false)
  useKeybinding('confirm:toggleFullPreview', () => setExpanded(prev => !prev), {
    context: 'Confirmation',
  })
  const summary = input.summary ?? ''
  const blockers = input.blockers ?? []
  const specFiles = input.specFiles ?? []
  const runNote = input.runNote
  const bounded = useMemo(() => {
    const parts = [summary, ...specFiles, ...(runNote ? [runNote] : [])]
    const projection = boundLines(
      parts,
      Math.max(1, consentContentWidth(columns) - REVIEW_INDENT_COLUMNS),
      expanded ? null : Math.max(1, consentBodyBudget(rows) - REVIEW_CHROME_ROWS),
    )
    const shownSpec = projection.lines.slice(1, 1 + specFiles.length)
    const shownNote = runNote ? projection.lines[1 + specFiles.length] : undefined
    return {
      summary: projection.lines[0] ?? '',
      specFiles: shownSpec,
      runNote: shownNote,
      hiddenLines: projection.hiddenLines,
    }
  }, [summary, specFiles, runNote, columns, rows, expanded])

  const options = useMemo<PermissionPromptOption<ApolloOptionValue>[]>(
    () => [
      { label: 'Yes — begin the build', value: 'build', feedbackConfig: { type: 'accept' } },
      { label: 'Yes — but ask me before each edit', value: 'build-ask-first' },
      {
        label: 'No — ask me more questions',
        value: 'more-questions',
        feedbackConfig: {
          type: 'reject',
          placeholder: 'what should Mercury still ask about?',
        },
      },
    ],
    [],
  )

  function handleSelect(value: ApolloOptionValue, feedback?: string): void {
    const typed = feedback?.trim()
    if (value === 'more-questions') {
      toolUseConfirm.onAllow(
        {
          ...(toolUseConfirm.input as Record<string, unknown>),
          decision: 'more-questions',
          ...(typed ? { refineNote: typed } : {}),
        },
        [],
      )
      onDone()
      return
    }
    toolUseConfirm.onAllow(
      { ...(toolUseConfirm.input as Record<string, unknown>), decision: value },
      [],
      typed,
    )
    onDone()
  }

  function handleCancel(): void {
    toolUseConfirm.onReject()
    onReject()
    onDone()
  }

  return (
    <PermissionDialog title="Apollo pre-flight review" workerBadge={workerBadge}>
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <ApolloReviewCard
            summary={bounded.summary}
            blockers={blockers}
            specFiles={bounded.specFiles}
            runNote={bounded.runNote}
          />
          {bounded.hiddenLines > 0 ? (
            <Text dimColor>
              … +{bounded.hiddenLines} more line{bounded.hiddenLines === 1 ? '' : 's'} · ctrl+f expands
            </Text>
          ) : null}
          {expanded ? <Text dimColor>ctrl+f collapses the preview</Text> : null}
        </Box>
        <PermissionPrompt
          question="Begin the prototype build?"
          options={options}
          onSelect={handleSelect}
          onCancel={handleCancel}
        />
      </Box>
    </PermissionDialog>
  )
}
