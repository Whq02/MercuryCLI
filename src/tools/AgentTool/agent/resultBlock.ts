import { foregroundNotKeptLine, type BackgroundHandoverReason } from '../../../tasks/LocalAgentTask/launchReceipts.js'
import { crewWorktreeLeftoverNoted, crewWorktreeReminderTail } from '../../../utils/crew/crewWorktreeReminder.js'
import { RESUME_AGENT_TOOL_NAME } from '../../ResumeAgentTool/constants.js'
import { PROMOTED_NARRATION_NOTE, structuredResultBlock } from '../agentToolUtils.js'
import { ONE_SHOT_BUILTIN_AGENT_TYPES } from '../constants.js'
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
  const data = output as AgentToolOutput & {
    agentId?: string
    content?: Array<{ type: 'text'; text: string }>
    totalTokens?: number
    totalToolUseCount?: number
    totalDurationMs?: number
    outcome?: { status: string; promotedNarration?: boolean }
    agentType?: string
    error?: string
    lastCalls?: string[]
    worktreePath?: string
    worktreeBranch?: string
    agentName?: string
    structured?: { data?: unknown; error?: string; source: 'dispatch' | 'agent-definition'; mode: 'permissive' | 'strict' }
  }
  const status = (data as { status?: string }).status
  const structuredBlocks: Array<{ type: 'text'; text: string }> =
    data.structured !== undefined ? [{ type: 'text' as const, text: structuredResultBlock(data.structured) }] : []

  if (status === 'async_launched') {
    const async = data as unknown as {
      agentId: string
      outputFile: string
      canReadOutputFile: boolean
      modelNote?: string
      agentName?: string
      backgroundReason?: BackgroundHandoverReason
      siblingEnd?: { taskId: string; description: string; status: 'failed' | 'stopped'; error?: string }
    }
    const lines = [
      'Crewmate launched in the background.',
      ...(async.backgroundReason ? [foregroundNotKeptLine(async.backgroundReason, async.siblingEnd)] : []),
      ...(async.modelNote ? [async.modelNote] : []),
      continuationHint(async.agentId, async.agentName),
      'The crewmate is working in the background — you will be notified automatically when it completes.',
    ]
    if (async.canReadOutputFile) {
      lines.push(
        'Do not repeat the launched crewmate\'s work: keep off the same files and subject matter — either pick up something disjoint or give the user a one-line note about the launch and stop.',
        `Output file: ${async.outputFile} (progress may be inspected with the read tool or a shell tail ONLY when the user asks).`,
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

  if (status === 'failed') {
    const partialBlocks = data.content ?? []
    const paused = typeof data.error === 'string' && data.error.startsWith('paused — ')
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
    const kept = worktreeKeptLine(data)
    const failedTrailer = [
      `Crewmate execution failed: ${data.error ?? 'unknown error'}`,
      'Output above was captured before the failure as partial work and must not be read as a conclusion; its work is kept on the crewmate\'s transcript.',
      continuationHint(String(data.agentId ?? '')),
      ...(kept !== null ? [kept] : []),
      ...(data.lastCalls !== undefined && data.lastCalls.length > 0 ? [`Last tool calls:\n${data.lastCalls.map(call => `  ${call}`).join('\n')}`] : []),
      usageBlock(data),
    ]
    const failedEnvelope = envelopeFor(data)
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

  if (status === 'completed') {
    let bodyBlocks = data.content ?? []
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
      data.outcome?.status === 'completed' &&
      data.outcome.promotedNarration
    ) {
      blocks.push({ type: 'text' as const, text: PROMOTED_NARRATION_NOTE })
    }
    blocks.push(...bodyBlocks)
    if (
      data.agentType !== undefined &&
      ONE_SHOT_BUILTIN_AGENT_TYPES.has(data.agentType) &&
      !data.worktreePath
    ) {
      return {
        type: 'tool_result' as const,
        tool_use_id: toolUseID,
        content: blocks,
      }
    }
    const trailerParts = [continuationHint(String(data.agentId ?? ''))]
    const kept = worktreeKeptLine(data)
    if (kept !== null) trailerParts.push(kept)
    trailerParts.push(usageBlock(data))
    const envelope = envelopeFor(data)
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
