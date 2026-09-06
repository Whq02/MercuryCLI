


export * from './turnCut.js'
import { INTERRUPT_MESSAGE, INTERRUPT_MESSAGE_FOR_TOOL_USE, interruptedToolsLine, turnCutOf, turnCutWhy, turnCutLine, turnCutResultText, turnCutOfText, isTurnCutText } from './turnCut.js'

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
export const PLAN_REJECTION_PREFIX =
  'The operator declined the proposed plan and chose to stay in strategy mode rather than proceed with implementation.\n\nDeclined plan:\n'

const DENIAL_SENTENCES_ON_DISK = [
  "The user doesn't want to proceed with this tool use.",
  "The user doesn't want to take this action right now.",
  'Permission for this tool use was denied.',
  'The agent proposed a plan that was rejected by the user.',
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

export function isDenialResultText(raw: string): boolean {
  const text = unwrapToolUseError(raw)
  return (
    text.includes(INTERRUPT_MESSAGE) ||
    text.includes(INTERRUPT_MESSAGE_FOR_TOOL_USE) ||
    /^Cut off(?: by|:) /.test(text) ||
    text === CANCEL_MESSAGE ||
    text === REJECT_MESSAGE ||
    text.startsWith(REJECT_MESSAGE_WITH_REASON_PREFIX) ||
    text === SUBAGENT_REJECT_MESSAGE ||
    text.startsWith(SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX) ||
    text.startsWith(PLAN_REJECTION_PREFIX) ||
    DENIAL_SENTENCES_ON_DISK.some(sentence => text.startsWith(sentence)) ||
    text.startsWith(AUTO_MODE_REJECTION_PREFIX) ||
    (text.includes(' has been denied') && text.includes(DENIAL_WORKAROUND_GUIDANCE))
  )
}

export function unwrapToolUseError(text: string): string {
  const match = /^\s*<tool_use_error>([\s\S]*?)<\/tool_use_error>\s*$/.exec(text)
  return match === null ? text : match[1]!
}

export const NO_RESPONSE_REQUESTED = 'No response requested.'

export const SYNTHETIC_TOOL_RESULT_PLACEHOLDER =
  '[Tool result missing due to internal error]'


const AUTO_MODE_REJECTION_PREFIX =
  'Permission for this action has been denied. Reason: '

export function isClassifierDenial(content: string): boolean {
  return content.startsWith(AUTO_MODE_REJECTION_PREFIX)
}

export function buildYoloRejectionMessage(reason: string): string {
  return (
    `${AUTO_MODE_REJECTION_PREFIX}${reason}. ` +
    `Flow's safety check blocked this action, and this session cannot show the operator a consent card, so it was not run. ` +
    `The operator can allow it with a permission rule for the action, or by running the session interactively and approving it there. ` +
    `Work that does not depend on this action can continue. ` +
    DENIAL_WORKAROUND_GUIDANCE
  )
}

export function buildFlowBlockDeclinedMessage(reason: string): string {
  return (
    `${AUTO_MODE_REJECTION_PREFIX}${reason}. ` +
    `The operator was asked about this same action earlier in this turn and declined it, so it was not asked again and was not run. ` +
    `Follow what the operator said. ` +
    DENIAL_WORKAROUND_GUIDANCE
  )
}

export function buildClassifierUnavailableMessage(
  toolName: string,
  classifierModel?: string,
): string {
  const modelDetail = classifierModel ? ` (last tried ${classifierModel})` : ''
  return (
    `The flow safety check is temporarily unavailable${modelDetail}, so ${toolName} was not run: flow runs nothing its check has not cleared, and this session cannot show the operator a consent card. ` +
    `The check may recover shortly, and the same action can be tried again then; work that does not need the check can continue. ` +
    `The built-in read-only tools (file reads, code search, glob listings) never need the check; MCP tools always do.`
  )
}

export function buildClassifierUnreadableMessage(
  toolName: string,
  classifierModel: string,
  detail?: string,
): string {
  const what = detail ? ` (${detail})` : ''
  return (
    `The flow safety check could not read its own verdict, so ${toolName} was not run: ${classifierModel} answered in a shape Mercury could not parse${what}, and this session cannot show the operator a consent card. ` +
    `This is not a judgement on the action — the check may read its next verdict, the same action can be tried again, and work that does not need the check can continue. ` +
    `The built-in read-only tools (file reads, code search, glob listings) never need the check; MCP tools always do.`
  )
}
