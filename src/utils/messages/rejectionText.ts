export * from './turnCut.js'
import { INTERRUPT_MESSAGE, INTERRUPT_MESSAGE_FOR_TOOL_USE, isInterruptedResultText } from './turnCut.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'

export const DENIAL_WORKAROUND_GUIDANCE: Unbuilt =
  unbuilt('src/utils/messages/rejectionText.ts:7')

export const CANCEL_MESSAGE: Unbuilt =
  unbuilt('src/utils/messages/rejectionText.ts:11')


export const REJECT_MESSAGE: Unbuilt =
  unbuilt('src/utils/messages/rejectionText.ts:15')
export const REJECT_MESSAGE_WITH_REASON_PREFIX: Unbuilt =
  unbuilt('src/utils/messages/rejectionText.ts:17')
export const SUBAGENT_REJECT_MESSAGE: Unbuilt =
  unbuilt('src/utils/messages/rejectionText.ts:19')
export const SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX: Unbuilt =
  unbuilt('src/utils/messages/rejectionText.ts:21')

const DENIAL_SENTENCES_ON_DISK = [
  "The user doesn't want to proceed with this tool use.",
  "The user doesn't want to take this action right now.",
  'Permission for this tool use was denied.',
  'The agent proposed a plan that was rejected by the user.',
  'The operator declined the proposed plan',
]

export function AUTO_REJECT_MESSAGE(toolName: string): string {
  return notBuilt('src/utils/messages/rejectionText.ts:32')
}
export function DONT_ASK_REJECT_MESSAGE(toolName: string): string {
  return notBuilt('src/utils/messages/rejectionText.ts:39')
}
export function UNANSWERED_ASK_REJECT_MESSAGE(toolName: string, cause: string): string {
  return (
    `Permission to use ${toolName} has been denied: the operator's client was not there to answer (${cause}), so the action was not run. ` +
    `Work that does not depend on this action can continue; the operator can re-issue it from the switchboard once they are back. ` +
    DENIAL_WORKAROUND_GUIDANCE
  )
}

function standsAsInterrupt(text: string): boolean {
  const lines = text.split('\n').map(line => line.trim())
  return [INTERRUPT_MESSAGE, INTERRUPT_MESSAGE_FOR_TOOL_USE].some(marker => text.startsWith(marker) || lines.includes(marker))
}

function isUserInterruptText(text: string): boolean {
  return standsAsInterrupt(text) || isInterruptedResultText(text) || text === CANCEL_MESSAGE
}

export function isUserInterruptResultText(raw: string): boolean {
  return isUserInterruptText(unwrapToolUseError(raw))
}

export function isDenialResultText(raw: string): boolean {
  const text = unwrapToolUseError(raw)
  return (
    isUserInterruptText(text) ||
    /^Cut off(?: by|:) /.test(text) ||
    text === REJECT_MESSAGE ||
    text.startsWith(REJECT_MESSAGE_WITH_REASON_PREFIX) ||
    text === SUBAGENT_REJECT_MESSAGE ||
    text.startsWith(SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX) ||
    DENIAL_SENTENCES_ON_DISK.some(sentence => text.startsWith(sentence)) ||
    /^Ward '[^']+' blocked this /.test(text) ||
    (text.includes(' has been denied') && text.includes(DENIAL_WORKAROUND_GUIDANCE))
  )
}

export function unwrapToolUseError(text: string): string {
  const match = /^\s*<tool_use_error>([\s\S]*?)<\/tool_use_error>\s*$/.exec(text)
  return match === null ? text : match[1]!
}

export function denialLineOf(raw: string): string {
  const text = unwrapToolUseError(raw).trim()
  const said = [REJECT_MESSAGE_WITH_REASON_PREFIX, SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX].find(prefix => text.startsWith(prefix))
  if (said !== undefined) {
    const reason = text.slice(said.length).trim().split('\n')[0]?.trim() ?? ''
    return reason === '' ? said.trim() : `${said.trim()} ${reason}`
  }
  const end = text.search(/\.(?:\s|$)/)
  return end === -1 ? text : text.slice(0, end + 1)
}

export const NO_RESPONSE_REQUESTED: Unbuilt = unbuilt('src/utils/messages/rejectionText.ts:97')

export const SYNTHETIC_TOOL_RESULT_PLACEHOLDER: Unbuilt =
  unbuilt('src/utils/messages/rejectionText.ts:99')

export const ENDED_RUN_TOOL_RESULT =
  'The previous run ended before this call returned a result; whether the call started or finished is not known.'


