import * as React from 'react'
import { Ansi, Box, Text } from '../../ink.js'
import { stringWidth } from '../../ink/stringWidth.js'
import ThemedText from '../design-system/ThemedText.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useAppState } from '../../state/AppState.js'
import { flowAskSentence } from '../../utils/permissions/flowLaw.js'
import { permissionRuleValueToString } from '../../utils/permissions/permissionRuleParser.js'
import type { PermissionDecision } from '../../utils/permissions/PermissionResult.js'
import { reasonForRule, ruleSourceWords } from '../../utils/permissions/ruleReason.js'
import { truncatePathMiddle, truncateStartToWidth, truncateToWidth } from '../../utils/truncate.js'
import { consentContentWidth } from './consentBodyBudget.js'

type PermissionRuleExplanationProps = {
  permissionResult: PermissionDecision
}

const RULES_HINT = 'Rules live in /permissions'
const HOOKS_HINT = 'Hooks can be changed in /hooks'

function fitFlowSentence(text: string, width: number): string {
  let over = stringWidth(text) - width
  if (over <= 0) return text
  const [lead, joiner] = flowAskSentence({ item: 4, subject: '\0', why: '\0' }).split('\0')
  const join = joiner ? text.lastIndexOf(joiner) : -1
  if (!lead || !text.startsWith(lead) || join < lead.length) return text
  const isPath = (word: string): boolean => /[\\/]/.test(word)
  let command = text.slice(lead.length, join)
  let why = text.slice(join).split(/(,?\s+)/)
  if (!why.some(isPath)) return text
  const cutCommand = (floor: number): void => {
    const cut = truncateToWidth(command, Math.max(floor, stringWidth(command) - over))
    over -= stringWidth(command) - stringWidth(cut)
    command = cut
  }
  const cutPath = (keepName: boolean): void => {
    why = why.map(word => {
      if (over <= 0 || !isPath(word)) return word
      const name = stringWidth(word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')))) + 1
      const short = keepName ? truncatePathMiddle(word, Math.max(name, stringWidth(word) - over)) : truncateStartToWidth(word, Math.max(1, stringWidth(word) - over))
      over -= stringWidth(word) - stringWidth(short)
      return short
    })
  }
  cutCommand(stringWidth(command.split(/\s/)[0] ?? '') + 1)
  cutPath(true)
  cutCommand(1)
  cutPath(false)
  return `${lead}${command}${why.join('')}`
}

export function PermissionRuleExplanation({
  permissionResult,
}: PermissionRuleExplanationProps): React.ReactNode {
  const mode = useAppState(state => state.toolPermissionContext.mode)
  const ruleReasons = useAppState(state => state.toolPermissionContext.ruleReasons)
  const { columns } = useTerminalSize()
  const reason =
    'decisionReason' in permissionResult ? permissionResult.decisionReason : undefined
  if (!reason) return null

  switch (reason.type) {
    case 'rule': {
      const ruleString = permissionRuleValueToString(reason.rule.ruleValue)
      const words = reasonForRule({ ruleReasons }, reason.rule)
      const managed = reason.rule.source === 'policySettings'
      return (
        <Box flexDirection="column">
          <Text wrap="truncate-middle">
            The rule <Text bold>{ruleString}</Text> {ruleSourceWords(reason.rule.source)} asks first.
          </Text>
          {words ? <Text wrap="truncate-middle">{words}</Text> : null}
          {managed ? null : <Text dimColor wrap="truncate-middle">{RULES_HINT}</Text>}
        </Box>
      )
    }
    case 'hook': {
      if (mode === 'flow') {
        return (
          <Box flexDirection="column">
            <ThemedText color="warning" wrap="truncate-middle">
              The hook {reason.hookName} required confirmation
              {reason.hookSource ? ` [${reason.hookSource}]` : ''}
            </ThemedText>
            {reason.reason ? <ThemedText color="warning" wrap="truncate-middle">{reason.reason}</ThemedText> : null}
            <Text dimColor wrap="truncate-middle">{HOOKS_HINT}</Text>
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          <Box gap={1}>
            <Text wrap="truncate-middle">
              The hook <Text bold>{reason.hookName}</Text> required confirmation
            </Text>
            {reason.hookSource ? <Text dimColor wrap="truncate-middle">[{reason.hookSource}]</Text> : null}
          </Box>
          {reason.reason ? (
            <Text wrap="truncate-middle">
              <Ansi>{reason.reason}</Ansi>
            </Text>
          ) : null}
          <Text dimColor wrap="truncate-middle">{HOOKS_HINT}</Text>
        </Box>
      )
    }
    case 'workingDir':
      return (
        <Box flexDirection="column">
          <Text wrap="truncate-middle">
            <Ansi>{reason.reason}</Ansi>
          </Text>
          <Text dimColor wrap="truncate-middle">{RULES_HINT}</Text>
        </Box>
      )
    case 'safetyCheck':
    case 'guard':
    case 'other': {
      const text =
        (reason as { message?: string; reason?: string }).message ??
        (reason as { message?: string; reason?: string }).reason
      if (!text) return null
      return (
        <Text wrap={reason.type === 'safetyCheck' && reason.operatorOnly ? 'wrap' : 'truncate-middle'}>
          <Ansi>{fitFlowSentence(text, consentContentWidth(columns))}</Ansi>
        </Text>
      )
    }
    default:
      return null
  }
}
