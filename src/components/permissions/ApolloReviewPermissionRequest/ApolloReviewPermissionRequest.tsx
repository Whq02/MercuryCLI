// The Apollo closing-review consent card.
// Shown only for a CLEAN review (the tool's ask path fires only with an
// empty blocker list): the SAME ApolloReviewCard the transcript receipt
// renders — summary, "no blockers", spec files, run note — plus the one
// decision, three answers (the plan-approval precedent):
//   · "Yes — begin the build": the ruled build posture (the tool moves the
//     mode; flow when the auto gate allows, implement otherwise);
//   · "Yes — but ask me before each edit": the mode still moves (default);
//     the build runs with per-edit consent. The two yes tiers differ in
//     permission breadth only — never in whether the mode moves;
//   · "No — ask me more questions": the review is held with the session
//     and drafts preserved; the model resumes the interview.
// Each answer rides the tool input (`decision`) so the tool result and the
// transcript receipt state the outcome the user actually chose. esc stays
// the plain hold (a rejection, nothing moves). A mode-loosening consent is
// never rule-allowlistable, so there is no "don't ask again" option.

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
      // The held review is an OUTCOME, not a rejection: it rides the tool
      // input so the wire speaks the discuss grammar (session and drafts
      // preserved, the interview resumes) instead of a generic reject.
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

  /** esc: the plain hold — a rejection; nothing moves, the model waits. */
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
