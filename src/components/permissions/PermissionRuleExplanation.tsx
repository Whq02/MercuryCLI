import * as React from 'react'
import { Ansi, Box, Text } from '../../ink.js'
import ThemedText from '../design-system/ThemedText.js'
import { useAppState } from '../../state/AppState.js'
import { permissionRuleValueToString } from '../../utils/permissions/permissionRuleParser.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'

export type PermissionRuleExplanationProps = {
  permissionResult: PermissionDecision
  toolType: 'tool' | 'command' | 'edit' | 'read'
}

const RULES_HINT = 'Permission rules can be changed in /permissions'
const HOOKS_HINT = 'Hooks can be changed in /hooks'

export function PermissionRuleExplanation({
  permissionResult,
  toolType,
}: PermissionRuleExplanationProps): React.ReactNode {
  const mode = useAppState(state => state.toolPermissionContext.mode)
  const reason =
    'decisionReason' in permissionResult ? permissionResult.decisionReason : undefined
  if (!reason) return null

  switch (reason.type) {
    case 'rule': {
      const ruleString = permissionRuleValueToString(reason.rule.ruleValue)
      const managed = reason.rule.source === 'policySettings'
      return (
        <Box flexDirection="column">
          <Text>
            The rule <Text bold>{ruleString}</Text> requires confirmation for this {toolType}
          </Text>
          {managed ? null : <Text dimColor>{RULES_HINT}</Text>}
        </Box>
      )
    }
    case 'hook': {
      if (mode === 'flow') {
        return (
          <Box flexDirection="column">
            <ThemedText color="warning">
              The hook {reason.hookName} required confirmation
              {reason.hookSource ? ` [${reason.hookSource}]` : ''}
            </ThemedText>
            {reason.reason ? <ThemedText color="warning">{reason.reason}</ThemedText> : null}
            <Text dimColor>{HOOKS_HINT}</Text>
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          <Box gap={1}>
            <Text>
              The hook <Text bold>{reason.hookName}</Text> required confirmation
            </Text>
            {reason.hookSource ? <Text dimColor>[{reason.hookSource}]</Text> : null}
          </Box>
          {reason.reason ? (
            <Text>
              <Ansi>{reason.reason}</Ansi>
            </Text>
          ) : null}
          <Text dimColor>{HOOKS_HINT}</Text>
        </Box>
      )
    }
    case 'workingDir':
      return (
        <Box flexDirection="column">
          <Text>
            <Ansi>{reason.reason}</Ansi>
          </Text>
          <Text dimColor>{RULES_HINT}</Text>
        </Box>
      )
    case 'safetyCheck':
    case 'other': {
      const text =
        (reason as { message?: string; reason?: string }).message ??
        (reason as { message?: string; reason?: string }).reason
      if (!text) return null
      return (
        <Text>
          <Ansi>{text}</Ansi>
        </Text>
      )
    }
    case 'classifier': {
      if (reason.classifier === 'auto-mode') {
        return (
          <Box flexDirection="column">
            <ThemedText color="warning">
              Flow&apos;s safety check blocked this {toolType} — it runs only if you allow it
            </ThemedText>
            {reason.reason ? (
              <Text>
                <Ansi>{reason.reason}</Ansi>
              </Text>
            ) : null}
          </Box>
        )
      }
      if (!reason.reason) return null
      return (
        <Text>
          <Ansi>{reason.reason}</Ansi>
        </Text>
      )
    }
    default:
      return null
  }
}
