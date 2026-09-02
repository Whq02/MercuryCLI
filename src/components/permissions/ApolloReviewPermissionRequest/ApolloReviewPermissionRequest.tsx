
import * as React from 'react'
import { useMemo } from 'react'
import { Box } from '../../../ink.js'
import { ApolloReviewCard } from '../../../tools/ApolloReviewTool/UI.js'
import type { Input } from '../../../tools/ApolloReviewTool/ApolloReviewTool.js'
import { PermissionDialog } from '../PermissionDialog.js'
import {
  PermissionPrompt,
  type PermissionPromptOption,
} from '../PermissionPrompt.js'
import { usePermissionRequestLogging } from '../hooks.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'

type ApolloOptionValue = 'build' | 'build-ask-first' | 'more-questions'

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
        <ApolloReviewCard
          summary={input.summary ?? ''}
          blockers={input.blockers ?? []}
          specFiles={input.specFiles ?? []}
          runNote={input.runNote}
        />
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
