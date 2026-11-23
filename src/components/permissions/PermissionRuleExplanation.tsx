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

  const decisionReason = permissionResult.decisionReason
  if (!decisionReason) return null

  switch (decisionReason.type) {
    case 'rule': {
      const rule = decisionReason.rule
      const formatted = permissionRuleValueToString(rule.ruleValue)
      const sourceWords = ruleSourceWords(rule.source)
      const reason = reasonForRule({ ruleReasons }, rule)
      return (
        <Box flexDirection="column">
          <Text wrap="truncate-middle">
            The rule <Text bold>{formatted}</Text> {sourceWords} asks first.
          </Text>
          {reason ? <Text wrap="truncate-middle">{reason}</Text> : null}
          {rule.source !== 'policySettings' ? (
            <Text dimColor wrap="truncate-middle">
              {RULES_HINT}
            </Text>
          ) : null}
        </Box>
      )
    }

    case 'hook': {
      if (mode === 'flow') {
        return (
          <Box flexDirection="column">
            <ThemedText color="warning" wrap="truncate-middle">
              The hook {decisionReason.hookName} required confirmation
              {decisionReason.hookSource ? ` [${decisionReason.hookSource}]` : ''}
            </ThemedText>
            {decisionReason.reason ? (
              <ThemedText color="warning" wrap="truncate-middle">
                {decisionReason.reason}
              </ThemedText>
            ) : null}
            <Text dimColor wrap="truncate-middle">
              {HOOKS_HINT}
            </Text>
          </Box>
        )
      }
      return (
        <Box flexDirection="column">
          <Box gap={1}>
            <Text wrap="truncate-middle">
              The hook <Text bold>{decisionReason.hookName}</Text> required confirmation
            </Text>
            {decisionReason.hookSource ? (
              <Text dimColor wrap="truncate-middle">
                [{decisionReason.hookSource}]
              </Text>
            ) : null}
          </Box>
          {decisionReason.reason ? (
            <Text wrap="truncate-middle">
              <Ansi>{decisionReason.reason}</Ansi>
            </Text>
          ) : null}
          <Text dimColor wrap="truncate-middle">
            {HOOKS_HINT}
          </Text>
        </Box>
      )
    }

    case 'workingDir':
      return (
        <Box flexDirection="column">
          <Text wrap="truncate-middle">
            <Ansi>{decisionReason.reason}</Ansi>
          </Text>
          <Text dimColor wrap="truncate-middle">
            {RULES_HINT}
          </Text>
        </Box>
      )

    case 'safetyCheck':
    case 'guard':
    case 'other': {
      const record: { message?: string | null; reason?: string } = decisionReason
      const text = record.message ?? record.reason
      if (!text) return null
      const fitted = fitFlowSentence(text, consentContentWidth(columns))
      const wrap =
        decisionReason.type === 'safetyCheck' && decisionReason.operatorOnly
          ? 'wrap'
          : 'truncate-middle'
      return (
        <Text wrap={wrap}>
          <Ansi>{fitted}</Ansi>
        </Text>
      )
    }

    default:
      return null
  }
}
