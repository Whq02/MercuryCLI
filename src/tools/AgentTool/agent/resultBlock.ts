import { foregroundNotKeptLine } from '../../../tasks/LocalAgentTask/launchReceipts.js'
import { crewWorktreeLeftoverNoted, crewWorktreeReminderTail } from '../../../services/crew/crewWorktreeReminder.js'
import { RESUME_AGENT_TOOL_NAME } from '../../../constants/tools/resumeAgent.js'
import { PROMOTED_NARRATION_NOTE, structuredResultBlock } from '../agentToolUtils.js'
import { ONE_SHOT_BUILTIN_AGENT_TYPES } from '../../../constants/tools/agent.js'
import { envelopeFor } from '../../../services/agentResults/ingest.js'
import { formatEnvelopeBlock } from '../../../services/agentResults/normalize.js'
import type { AgentToolOutput } from './schema.js'

function usageBlock(data: {
  totalTokens?: number
  totalToolUseCount?: number
  totalDurationMs?: number
}): string {
  const rows = [
    ...(data.totalTokens !== undefined ? [`total_tokens: ${data.totalTokens}`] : []),
    ...(data.totalToolUseCount !== undefined ? [`tool_uses: ${data.totalToolUseCount}`] : []),
    ...(data.totalDurationMs !== undefined ? [`duration_ms: ${data.totalDurationMs}`] : []),
  ]
  return rows.length > 0 ? `<usage>${rows.join('\n')}</usage>` : '<usage>unreported</usage>'
}

function continuationHint(agentId: string, name?: string): string {
  return `agentId: ${agentId} (internal — do not mention it to the user). To continue this crewmate, use ${RESUME_AGENT_TOOL_NAME} addressed to that id${name ? ` or to its name "${name}"` : ''}.`
}

function worktreeKeptLine(data: { worktreePath?: string; worktreeBranch?: string }): string | null {
  if (!data.worktreePath) return null
  const leftover = crewWorktreeLeftoverNoted(data.worktreePath)
  const at = [data.worktreeBranch ? `branch ${data.worktreeBranch}` : '', leftover?.head ? `@ ${leftover.head}` : ''].filter(Boolean).join(' ')
  return `Worktree kept: ${data.worktreePath}${at ? ` (${at})` : ''}${leftover !== null ? ` — ${crewWorktreeReminderTail(leftover, Date.now())}` : ''}`
}

export function agentToolResultBlock(
  output: AgentToolOutput,
  toolUseID: string,
) {
  const status: string = output.status

  if (output.status === 'async_launched') {
    const lines = [
      'Crewmate launched in the background.',
      ...(output.backgroundReason ? [foregroundNotKeptLine(output.backgroundReason, output.siblingEnd)] : []),
      ...(output.modelNote ? [output.modelNote] : []),
      continuationHint(output.agentId, output.agentName),
      'The crewmate is working in the background — you will be notified automatically when it completes.',
    ]
    if (output.canReadOutputFile) {
      lines.push(
        'Do not repeat the launched crewmate\'s work: keep off the same files and subject matter — either pick up something disjoint or give the user a one-line note about the launch and stop.',
        `Output file: ${output.outputFile} (progress may be inspected with the read tool or a shell tail ONLY when the user asks).`,
      )
    } else {
      lines.push(
        'Give the user a one-line note about the launch and stop — emit nothing further; the results will arrive in a later message.',
      )
    }
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: [{ type: 'text' as const, text: lines.join('\n') }],
    }
  }

  const structuredBlocks: Array<{ type: 'text'; text: string }> =
    output.structured !== undefined ? [{ type: 'text' as const, text: structuredResultBlock(output.structured) }] : []

  if (output.status === 'failed') {
    const partialBlocks = output.content ?? []
    const paused = typeof output.error === 'string' && output.error.startsWith('paused — ')
    const blocks: Array<{ type: 'text'; text: string }> = [
      ...structuredBlocks,
      ...(partialBlocks.length > 0
        ? partialBlocks
        : [
            {
              type: 'text' as const,
              text: paused ? 'The crewmate paused before returning any output.' : 'The crewmate failed before returning any output.',
            },
          ]),
    ]
    const kept = worktreeKeptLine(output)
    const failedTrailer = [
      `Crewmate execution failed: ${output.error ?? 'unknown error'}`,
      'Output above was captured before the failure as partial work and must not be read as a conclusion; its work is kept on the crewmate\'s transcript.',
      continuationHint(String(output.agentId ?? '')),
      ...(kept !== null ? [kept] : []),
      ...(output.lastCalls !== undefined && output.lastCalls.length > 0 ? [`Last tool calls:\n${output.lastCalls.map(call => `  ${call}`).join('\n')}`] : []),
      usageBlock(output),
    ]
    const failedEnvelope = envelopeFor(output)
    if (failedEnvelope) failedTrailer.push(formatEnvelopeBlock(failedEnvelope))
    blocks.push({
      type: 'text' as const,
      text: failedTrailer.join('\n'),
    })
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      is_error: true,
      content: blocks,
    }
  }

  if (output.status === 'completed') {
    let bodyBlocks = output.content ?? []
    if (bodyBlocks.length === 0) {
      bodyBlocks = [
        {
          type: 'text' as const,
          text: 'The crewmate finished without producing any output.',
        },
      ]
    }
    const blocks: Array<{ type: 'text'; text: string }> = [...structuredBlocks]
    if (
      output.outcome?.status === 'completed' &&
      output.outcome.promotedNarration
    ) {
      blocks.push({ type: 'text' as const, text: PROMOTED_NARRATION_NOTE })
    }
    blocks.push(...bodyBlocks)
    if (
      output.agentType !== undefined &&
      ONE_SHOT_BUILTIN_AGENT_TYPES.has(output.agentType) &&
      !output.worktreePath
    ) {
      return {
        type: 'tool_result' as const,
        tool_use_id: toolUseID,
        content: blocks,
      }
    }
    const trailerParts = [continuationHint(String(output.agentId ?? ''))]
    const kept = worktreeKeptLine(output)
    if (kept !== null) trailerParts.push(kept)
    trailerParts.push(usageBlock(output))
    const envelope = envelopeFor(output)
    if (envelope) trailerParts.push(formatEnvelopeBlock(envelope))
    blocks.push({ type: 'text' as const, text: trailerParts.join('\n') })
    return {
      type: 'tool_result' as const,
      tool_use_id: toolUseID,
      content: blocks,
    }
  }

  throw new Error(`Unexpected crewmate tool result status: ${String(status)}`)
}
