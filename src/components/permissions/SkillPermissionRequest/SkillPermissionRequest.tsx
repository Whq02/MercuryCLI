import * as React from 'react'
import { useMemo } from 'react'
import { Box, Text } from '../../../ink.js'
import { getFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js'
import { SKILL_TOOL_NAME } from '../../../constants/tools/skill.js'
import { SkillTool } from '../../../tools/SkillTool/SkillTool.js'
import { logError } from '../../../utils/log.js'
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

export function SkillPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  usePermissionRequestLogging(toolUseConfirm)

  const parsed = SkillTool.inputSchema.safeParse(toolUseConfirm.input)
  let skill = ''
  if (parsed.success) {
    const raw = (parsed.data as { skill: string }).skill
    skill = raw.trim().replace(/^\//, '')
  } else {
    logError(parsed.error)
  }

  const matchedDescription =
    toolUseConfirm.permissionResult.behavior === 'ask'
      ? toolUseConfirm.permissionResult.metadata?.command?.description
      : undefined

  const spaceIndex = skill.indexOf(' ')
  const prefix = spaceIndex > 0 ? skill.slice(0, spaceIndex) : null
  const originalCwd = getFocusedSessionConnector().workspace().originalCwd

  const options = useMemo((): PermissionPromptOption<SkillOptionValue>[] => {
    const items: PermissionPromptOption<SkillOptionValue>[] = [
      {
        value: 'yes',
        label: 'Yes',
        feedbackConfig: { type: 'accept' },
      },
    ]
    if (skill !== '' && shouldShowAlwaysAllowOptions()) {
      items.push({
        value: 'yes-exact',
        label: (
          <Text>
            Yes, and don&apos;t ask again for <Text bold>{skill}</Text> in{' '}
            <Text bold>{originalCwd}</Text>
          </Text>
        ),
      })
      if (prefix !== null) {
        items.push({
          value: 'yes-prefix',
          label: (
            <Text>
              Yes, and don&apos;t ask again for skills starting with <Text bold>{prefix}</Text> in{' '}
              <Text bold>{originalCwd}</Text>
            </Text>
          ),
        })
      }
    }
    items.push({
      value: 'no',
      label: 'No, and tell Mercury what to do differently (esc)',
      feedbackConfig: { type: 'reject' },
    })
    return items
  }, [skill, prefix, originalCwd])

  const handleSelect = (value: SkillOptionValue, feedback?: string): void => {
    toolUseConfirm.onUserInteraction()
    switch (value) {
      case 'yes':
        toolUseConfirm.onAllow(toolUseConfirm.input, [], feedback)
        onDone()
        return
      case 'yes-exact':
        toolUseConfirm.onAllow(toolUseConfirm.input, [
          {
            type: 'addRules',
            rules: [{ toolName: SKILL_TOOL_NAME, ruleContent: skill }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ])
        onDone()
        return
      case 'yes-prefix':
        toolUseConfirm.onAllow(
          toolUseConfirm.input,
          prefix !== null
            ? [
                {
                  type: 'addRules',
                  rules: [{ toolName: SKILL_TOOL_NAME, ruleContent: `${prefix}*` }],
                  behavior: 'allow',
                  destination: 'localSettings',
                },
              ]
            : [],
        )
        onDone()
        return
      case 'no':
        toolUseConfirm.onReject(feedback)
        onReject()
        onDone()
        return
    }
  }

  const handleCancel = (): void => {
    toolUseConfirm.onReject()
    onReject()
    onDone()
  }

  return (
    <PermissionDialog
      title={`Use skill "${skill}"?`}
      crewmate={toolUseConfirm.crewmate}
      workerBadge={workerBadge}
    >
      <Box flexDirection="column">
        <Text>Mercury may use instructions, code, or files from this skill.</Text>
        {matchedDescription ? <Text dimColor>{matchedDescription}</Text> : null}
        <PermissionRuleExplanation permissionResult={toolUseConfirm.permissionResult} />
        <PermissionPrompt
          options={options}
          onSelect={handleSelect}
          onCancel={handleCancel}
        />
      </Box>
    </PermissionDialog>
  )
}
