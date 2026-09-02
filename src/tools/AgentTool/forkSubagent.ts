// The fork-subagent experiment. Gate-off in this build
// (kept per the scope-out roster's explicit S10 keep row): the schema shape
// is gate-dependent, so the wiring survives even while the gate is false.
//
// The boilerplate marker element and the directive prefix are contract data
// shared with the recursion guard and the slash-command surface
// (FORK_BOILERPLATE_TAG / FORK_DIRECTIVE_PREFIX).

import { randomUUID } from 'node:crypto'
import {
  FORK_BOILERPLATE_TAG,
  FORK_DIRECTIVE_PREFIX,
} from '../../constants/xml.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  createUserMessage,
  SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
} from '../../utils/messages.js'
import type { AgentDefinition } from './loadAgentsDir.js'

/** The fork experiment gate — false in this build. */
export function isForkSubagentEnabled(): boolean {
  return false
}

/** The synthetic fork type (contract data — analytics and the query-source
 *  form `agent:builtin:fork` carry it). */
export const FORK_SUBAGENT_TYPE = 'fork'

/** The synthetic fork definition. Its system-prompt producer returns empty:
 *  the fork path always supplies the parent's rendered bytes instead. */
export const FORK_AGENT: AgentDefinition = {
  agentType: FORK_SUBAGENT_TYPE,
  whenToUse:
    'Implicit context-inheriting fork of the calling agent. Not selectable through subagent_type — omitting the type with the fork experiment on is what forks.',
  tools: ['*'],
  maxTurns: 200,
  model: 'inherit',
  permissionMode: 'bubble',
  source: 'built-in',
  baseDir: 'built-in',
  getSystemPrompt: () => '',
}

/**
 * Fork recursion guard fallback: scan the conversation for the fork
 * boilerplate marker (the primary detection is the child's recorded query
 * source, which survives compaction — step 9).
 */
export function isInForkChild(messages: readonly Message[]): boolean {
  const marker = `<${FORK_BOILERPLATE_TAG}>`
  for (const message of messages) {
    if (message.type !== 'user') continue
    const content = message.message.content
    if (typeof content === 'string') {
      if (content.includes(marker)) return true
      continue
    }
    for (const block of content) {
      if (block.type === 'text' && block.text.includes(marker)) return true
    }
  }
  return false
}

/**
 * The fork child's opening text block: the boilerplate marker element
 * holding the standing rules and report shape, a blank line, then the
 * directive prefix immediately followed by the caller's directive.
 */
export function buildChildMessage(directive: string): string {
  return `<${FORK_BOILERPLATE_TAG}>
You are a forked worker, not the main agent. Whatever the inherited prompt says about preferring to fork applies to your parent — you execute directly and spawn nothing.

Do not converse, ask questions, suggest next steps, or editorialise. Use the tools directly and emit no text between tool calls — work silently and report exactly once at the end.

Commit the files you modify and give the commit hash in your report.

Stay strictly inside your assigned scope. Anything you notice outside it gets at most one sentence — other workers cover those areas.

Keep the report brief — a few hundred words unless your directive says otherwise — and factual. Open with your scope line, no preamble. Report structured facts as plain-text labelled fields, not markdown headings:
Scope: <what you were assigned>
Result: <what happened>
Key files: <the files that matter>
Files changed: <only when you changed any>
Issues: <only when there are any>
</${FORK_BOILERPLATE_TAG}>

${FORK_DIRECTIVE_PREFIX}${directive}`
}

/** Re-mint a message identifier so the child's transcript does not collide
 *  with the parent's. */
function remintAssistantMessage(message: AssistantMessage): AssistantMessage {
  return {
    ...message,
    uuid: randomUUID() as AssistantMessage['uuid'],
    message: {
      ...message.message,
      id: `msg_fork_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    },
  }
}

/**
 * The fork child's prompt messages, built to maximise prompt-cache sharing:
 * a clone of the parent's full assistant message (every content block
 * preserved, fresh identifier), then one user message with an identical
 * placeholder tool-result for EVERY tool-use block — one fixed constant
 * across every fork child, which is what makes sibling prefixes match —
 * followed by the per-child directive text block.
 */
export function buildForkedMessages(
  directive: string,
  assistantMessage: AssistantMessage,
): Message[] {
  const toolUseBlocks = assistantMessage.message.content.filter(
    (block): block is Extract<typeof block, { type: 'tool_use' }> =>
      block.type === 'tool_use',
  )
  if (toolUseBlocks.length === 0) {
    logForDebugging(
      'forkSubagent: parent assistant message has no tool-use blocks — falling back to a directive-only user message',
      { level: 'error' },
    )
    return [createUserMessage({ content: buildChildMessage(directive) })]
  }
  const cloned = remintAssistantMessage(assistantMessage)
  const userMessage = createUserMessage({
    content: [
      ...toolUseBlocks.map(block => ({
        type: 'tool_result' as const,
        tool_use_id: block.id,
        content: SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
      })),
      { type: 'text' as const, text: buildChildMessage(directive) },
    ],
  })
  return [cloned, userMessage]
}

/** The extra user message for a fork running in a worktree. */
export function buildWorktreeNotice(
  parentCwd: string,
  worktreeCwd: string,
): string {
  return `You inherited context from a parent working in a different directory (${parentCwd}). You are operating in an isolated worktree of the same repository at ${worktreeCwd}. Translate paths from the inherited context to the worktree root. Files may be stale — re-read a file before editing it. Your changes do not affect the parent.`
}
