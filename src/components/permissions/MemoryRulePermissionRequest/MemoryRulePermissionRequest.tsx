import * as React from 'react'
import { Box } from '../../../ink.js'
import { RULE_CARD_KEEP } from '../../../tools/MemoryTools/ruleCard.js'
import { ConsentBodyText } from '../ConsentBodyText.js'
import { PermissionDialog } from '../PermissionDialog.js'
import { PermissionPrompt, type PermissionPromptOption } from '../PermissionPrompt.js'
import { usePermissionRequestLogging } from '../hooks.js'
import type { PermissionRequestProps, ToolUseConfirm } from '../PermissionRequest.js'

type RuleAnswer = 'yes' | 'no'

export function isMemoryRuleCard(toolUseConfirm: Pick<ToolUseConfirm, 'permissionResult'>): boolean {
  return toolUseConfirm.permissionResult.decisionReason?.type === 'safetyCheck'
}

export function memoryRuleCardText(toolUseConfirm: Pick<ToolUseConfirm, 'permissionResult' | 'description'>): string {
  const reason = toolUseConfirm.permissionResult.decisionReason
  return reason?.type === 'safetyCheck' ? reason.reason : toolUseConfirm.description
}

export function MemoryRulePermissionRequest({ toolUseConfirm, onDone, onReject, workerBadge }: PermissionRequestProps): React.ReactNode {
  usePermissionRequestLogging(toolUseConfirm)
  const options: PermissionPromptOption<RuleAnswer>[] = [
    { label: 'Yes', value: 'yes' },
    { label: 'No, keep the rule', value: 'no' },
  ]
  const answer = (value: RuleAnswer): void => {
    toolUseConfirm.onAllow(value === 'yes' ? toolUseConfirm.input : { ...toolUseConfirm.input, [RULE_CARD_KEEP]: true }, [])
    onDone()
  }
  const dismiss = (): void => {
    toolUseConfirm.onReject()
    onReject()
    onDone()
  }
  return (
    <PermissionDialog title="Memory rule" workerBadge={workerBadge}>
      <Box flexDirection="column">
        <ConsentBodyText text={memoryRuleCardText(toolUseConfirm)} />
        <PermissionPrompt options={options} question="Go ahead?" onSelect={answer} onCancel={dismiss} />
      </Box>
    </PermissionDialog>
  )
}
