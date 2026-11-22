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
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

type PermissionRuleExplanationProps = Unbuilt

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

export function PermissionRuleExplanation(arg0: PermissionRuleExplanationProps): React.ReactNode {
  return notBuilt('src/components/permissions/PermissionRuleExplanation.tsx:52')
}
