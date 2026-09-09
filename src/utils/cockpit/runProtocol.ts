
import { isSessionMarkedNonInteractive } from './runtimePosture.js'
import { getSystemPromptSectionCache } from '../../bootstrap/state.js'
import type { Tools } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { LSP_TOOL_NAME } from '../../tools/LSPTool/prompt.js'
import { DEBUG_TOOL_NAME } from '../../tools/DebugTool/prompt.js'

const LSP_GUIDANCE = 'prefer LSP for symbol discovery, references, structured rename, and offered code actions; use direct file edits for small local changes where that is clearer. After a code mutation, get current diagnostics when a language server covers the file, then run the smallest real proof that covers the changed behavior.'
const DEBUG_GUIDANCE = 'Use the Debug tool (DAP) when a runtime-state question cannot be resolved from static evidence.'
const IDE_RESULT_GUIDANCE = 'An LSP/Debug operation that reports failed or indeterminate is exactly that — never treat an unavailable IDE tool as success; fall back honestly and keep the run state current.'

export interface RunProtocolRoster {
  lspMounted: boolean
  dapMounted: boolean
  taskToolsMounted?: boolean
}

const memo = new Map<string, string>()

export function getRunProtocolSection(roster: RunProtocolRoster): string | null {
  const interactive = !isSessionMarkedNonInteractive()
  const key = `${roster.lspMounted ? 1 : 0}${roster.dapMounted ? 1 : 0}${interactive ? 1 : 0}${roster.taskToolsMounted ? 1 : 0}`
  const cached = memo.get(key)
  if (cached !== undefined) return cached

  const bullets = [
    ...(roster.taskToolsMounted ? ["- For multi-deliverable work, create/update task items as you go; they ARE the run's deliverable list. Act on the next unblocked item instead of narrating future action."] : []),
    '- Tool effects and verification evidence are ground truth. A returned string that reports a failure is a failure; a mutation counts only when it actually landed. After code changes, run the smallest real verification that covers the changed behavior — a run cannot complete with a post-mutation evidence gap.',
    '- Finish every requested in-scope deliverable before declaring completion. If only the operator can resolve something, declare ONE precise blocker by ending your message with the two lines "BLOCKED ON OPERATOR: <what you need>" then "RESUME WHEN: <what unblocks you>" — that records it, stops the loop cleanly, and the operator\'s answer resumes the run. Never loop on a blocker in prose.',
    '- On resume, a reconciled run capsule tells you what is already done, what was interrupted mid-flight, and the next concrete action. Inspect an interrupted operation\'s real state before retrying; never repeat completed work.',
    ...(interactive
      ? ['- `/run` shows the live run; `/context` shows the exact request projection.']
      : []),
  ]

  const ideSentences: string[] = []
  if (roster.lspMounted) {
    ideSentences.push(
      LSP_GUIDANCE,
    )
  }
  if (roster.dapMounted) {
    ideSentences.push(
      DEBUG_GUIDANCE,
    )
  }
  const evidenceLine =
    'Current evidence is what completes a run, not a prescribed number of tool calls.'
  const idePara =
    ideSentences.length > 0
      ? `IDE loop: ${ideSentences.join(' ')} ${IDE_RESULT_GUIDANCE} ${evidenceLine}`
      : evidenceLine

  const section = `# Autonomous runs

A substantive coding request becomes a durable run: Mercury tracks the objective, deliverables, tool effects, verification evidence, and context epoch, and the stop decision is made from that state — not from how your last sentence reads. Work with it:

${bullets.join('\n')}

${idePara}`
  memo.set(key, section)
  return section
}

export function _resetRunProtocolForTesting(): void {
  memo.clear()
}

export function getRunProtocolDelta(tools: Tools, messages: readonly Message[]): { tools: string[]; body: string } | null {
  const initial = getSystemPromptSectionCache().get('run_protocol')?.value
  if (typeof initial !== 'string') return null
  const initialTools = [
    ...(initial.includes(LSP_GUIDANCE) ? [LSP_TOOL_NAME] : []),
    ...(initial.includes(DEBUG_GUIDANCE) ? [DEBUG_TOOL_NAME] : []),
  ]
  let previous = initialTools
  for (const message of messages) {
    if (message.type === 'system' && message.subtype === 'compact_boundary') previous = initialTools
    if (message.type === 'attachment' && message.attachment.type === 'run_protocol_delta') previous = message.attachment.tools
  }
  const names = new Set(tools.map(tool => tool.name))
  const current = [LSP_TOOL_NAME, DEBUG_TOOL_NAME].filter(name => names.has(name))
  const added = current.filter(name => !previous.includes(name))
  const removed = previous.filter(name => !current.includes(name))
  if (added.length === 0 && removed.length === 0) return null
  const body = [
    ...added.map(name => name === LSP_TOOL_NAME ? LSP_GUIDANCE : DEBUG_GUIDANCE),
    ...(added.length > 0 ? [IDE_RESULT_GUIDANCE] : []),
    ...(removed.length > 0 ? [`These tools are no longer available: ${removed.join(', ')}. Their earlier tool-specific guidance no longer applies.`] : []),
  ].join(' ')
  return { tools: current, body }
}
