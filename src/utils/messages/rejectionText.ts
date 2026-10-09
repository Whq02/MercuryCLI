


export * from './turnCut.js'
import { INTERRUPT_MESSAGE, INTERRUPT_MESSAGE_FOR_TOOL_USE, interruptedToolsLine, isInterruptedResultText, turnCutOf, turnCutWhy, turnCutLine, turnCutResultText, turnCutOfText, isTurnCutText } from './turnCut.js'

export const DENIAL_WORKAROUND_GUIDANCE =
  `Do not try to reach the same effect by another route. ` +
  `If the task cannot continue without this action, stop and say plainly what was not run and why the task needs it, then wait for the operator.`

export const CANCEL_MESSAGE =
  'The operator stopped this action before it ran; nothing was changed. Stop what you are doing and wait for the operator to say how to proceed.'


export const REJECT_MESSAGE =
  `The operator declined this tool call; it was not run and nothing was changed. ${DENIAL_WORKAROUND_GUIDANCE}`
export const REJECT_MESSAGE_WITH_REASON_PREFIX =
  'The operator declined this tool call; it was not run and nothing was changed. The operator said:\n'
export const SUBAGENT_REJECT_MESSAGE =
  `Permission for this tool call was declined; it was not run and nothing was changed. ${DENIAL_WORKAROUND_GUIDANCE}`
export const SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX =
  'Permission for this tool call was declined; it was not run and nothing was changed. The operator said:\n'

const DENIAL_SENTENCES_ON_DISK = [
  "The user doesn't want to proceed with this tool use.",
  "The user doesn't want to take this action right now.",
  'Permission for this tool use was denied.',
  'The agent proposed a plan that was rejected by the user.',
  'The operator declined the proposed plan',
]

export function AUTO_REJECT_MESSAGE(toolName: string): string {
  return (
    `Permission to use ${toolName} has been denied: this session cannot show the operator a consent card, so the action was not run. ` +
    `The operator can allow it with a permission rule for ${toolName}, or by running the session interactively and approving it there. ` +
    DENIAL_WORKAROUND_GUIDANCE
  )
}
export function DONT_ASK_REJECT_MESSAGE(toolName: string): string {
  return (
    `Permission to use ${toolName} has been denied because Mercury is running in don't ask mode: nothing that needs approval runs in this mode. ` +
    DENIAL_WORKAROUND_GUIDANCE
  )
}
export function UNANSWERED_ASK_REJECT_MESSAGE(toolName: string, cause: string): string {
  return (
    `Permission to use ${toolName} has been denied: the operator's client was not there to answer (${cause}), so the action was not run. ` +
    `Work that does not depend on this action can continue; the operator can re-issue it from the switchboard once they are back. ` +
    DENIAL_WORKAROUND_GUIDANCE
  )
}

export function isDenialResultText(raw: string): boolean {
  const text = unwrapToolUseError(raw)
  return (
    text.includes(INTERRUPT_MESSAGE) ||
    text.includes(INTERRUPT_MESSAGE_FOR_TOOL_USE) ||
    isInterruptedResultText(text) ||
    /^Cut off(?: by|:) /.test(text) ||
    text === CANCEL_MESSAGE ||
    text === REJECT_MESSAGE ||
    text.startsWith(REJECT_MESSAGE_WITH_REASON_PREFIX) ||
    text === SUBAGENT_REJECT_MESSAGE ||
    text.startsWith(SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX) ||
    DENIAL_SENTENCES_ON_DISK.some(sentence => text.startsWith(sentence)) ||
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

export const NO_RESPONSE_REQUESTED = 'No response requested.'

export const SYNTHETIC_TOOL_RESULT_PLACEHOLDER =
  '[Tool result missing due to internal error]'
