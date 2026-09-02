import * as React from 'react'
import { useMemo } from 'react'
import { Box, Text } from '../../../ink.js'
import { getFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js'
import { SKILL_TOOL_NAME } from '../../../tools/SkillTool/constants.js'
import { SkillTool } from '../../../tools/SkillTool/SkillTool.js'
import { env } from '../../../utils/env.js'
import { logError } from '../../../utils/log.js'
import { logUnaryEvent } from '../../../utils/unaryLogging.js'
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js'
import { PermissionDialog } from '../PermissionDialog.js'
import {
  PermissionPrompt,
  type PermissionPromptOption,
} from '../PermissionPrompt.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import { usePermissionRequestLogging } from '../hooks.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'

type SkillOptionValue = 'yes' | 'yes-exact' | 'yes-prefix' | 'no'

/** Lenient parse: a failure is logged and yields an empty skill name. */
function parseSkillCommand(input: unknown): string {
  const result = SkillTool.inputSchema.safeParse(input)
  if (result.success) return (result.data as { command?: string }).command ?? ''
  logError(result.error)
  return ''
}

export function SkillPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const skill = useMemo(
    () => parseSkillCommand(toolUseConfirm.input),
    [toolUseConfirm.input],
  )

  usePermissionRequestLogging(
    toolUseConfirm,
    useMemo(() => ({ completion_type: 'tool_use_single', language_name: 'none' }), []),
  )

  // Matched-command metadata is read only from an `ask` decision; the block
  // below renders unconditionally and is simply empty without it.
  const result = toolUseConfirm.permissionResult
  const matchedDescription =
    result.behavior === 'ask' ? result.metadata?.command?.description ?? '' : ''

  const spaceIndex = skill.indexOf(' ')
  const prefix = spaceIndex > 0 ? skill.slice(0, spaceIndex) : skill

  const options = useMemo<PermissionPromptOption<SkillOptionValue>[]>(() => {
    const list: PermissionPromptOption<SkillOptionValue>[] = [
      { label: 'Yes', value: 'yes', feedbackConfig: { type: 'accept' } },
    ]
    if (shouldShowAlwaysAllowOptions()) {
      list.push({
        label: (
          <Text>
            Yes, and don&apos;t ask again for <Text bold>{skill}</Text> in{' '}
            <Text bold>{getFocusedSessionConnector().workspace().originalCwd}</Text>
          </Text>
        ),
        value: 'yes-exact',
      })
      if (spaceIndex > 0) {
        list.push({
          label: (
            <Text>
              Yes, and don&apos;t ask again for <Text bold>{prefix}:*</Text> commands in{' '}
              <Text bold>{getFocusedSessionConnector().workspace().originalCwd}</Text>
            </Text>
          ),
          value: 'yes-prefix',
        })
      }
    }
    list.push({
      label: 'No, and tell Mercury what to do differently (esc)',
      value: 'no',
      feedbackConfig: { type: 'reject' },
    })
    return list
  }, [skill, prefix, spaceIndex])

  // Direct decision emitter: language none, the raw process platform, and no
  // had-feedback field at all.
  function logDecision(event: 'accept' | 'reject'): void {
    void logUnaryEvent({
      event,
      completion_type: 'tool_use_single',
      metadata: {
        language_name: 'none',
        message_id: toolUseConfirm.assistantMessage.message.id,
        platform: env.platform,
      },
    })
  }

  function persistRule(ruleContent: string): void {
    toolUseConfirm.onAllow(toolUseConfirm.input, [
      {
        type: 'addRules',
        rules: [{ toolName: SKILL_TOOL_NAME, ruleContent }],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ])
  }

  function handleSelect(value: SkillOptionValue, feedback?: string): void {
    switch (value) {
      case 'yes':
        logDecision('accept')
        toolUseConfirm.onAllow(toolUseConfirm.input, [], feedback)
        onDone()
        break
      case 'yes-exact':
        logDecision('accept')
        persistRule(skill)
        onDone()
        break
      case 'yes-prefix':
        logDecision('accept')
        persistRule(`${prefix}:*`)
        onDone()
        break
      case 'no':
        logDecision('reject')
        toolUseConfirm.onReject(feedback)
        onReject()
        onDone()
        break
    }
  }

  return (
    <PermissionDialog title={`Use skill "${skill}"?`} workerBadge={workerBadge}>
      <Box flexDirection="column">
        <Text>Mercury may use instructions, code, or files from this skill.</Text>
        <Text dimColor>{matchedDescription}</Text>
        <PermissionRuleExplanation
          permissionResult={toolUseConfirm.permissionResult}
          toolType="tool"
        />
        <PermissionPrompt
          options={options}
          onSelect={handleSelect}
          onCancel={() => handleSelect('no')}
        />
      </Box>
    </PermissionDialog>
  )
}
