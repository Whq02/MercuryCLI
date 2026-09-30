import type { Message } from '../../types/message.js'
import { logForDebugging } from '../../utils/debug.js'
import { callAdvisorOnceMore, liveAdvisorCall } from './advisorCall.js'
import { appendAdvisorRow, loadAdvisorContext, maybeCompactAdvisorContext } from './advisorContext.js'
import {
  ADVISOR_SYSTEM_PROMPT,
  advisorClock,
  advisorContextOptions,
  clampNoteLines,
  renderAdvisorMemory,
  renderAgentDigest,
  type AdvisorRoad,
} from './advisorNote.js'
import { advisorDispatchEffort, advisorSeatRefusal, advisorSessionSeat, readAdvisorSettings, resolveAdvisorModel } from './advisorSettings.js'

export const ADVISOR_QUESTION_MAX_CHARS = 4000

export const ADVISOR_ASK_PROMPT_TAIL = 'The agent asked you the question above between your scheduled notes. Answer it directly in at most eight lines, addressed to the agent: what you would check, what you think it is missing, or the decision you would take and why. If you cannot tell from what you were shown, say what the agent should look at to find out.'

export type AskAdvisorResult = { ok: true; reply: string; model: string } | { ok: false; reason: string }

export function composeAskPrompt(memory: string, digest: string, question: string): string {
  return [
    '<your_earlier_notes>',
    memory,
    '</your_earlier_notes>',
    '',
    '<new_rows_of_the_agents_conversation>',
    digest === '' ? '(nothing new since your last note)' : digest,
    '</new_rows_of_the_agents_conversation>',
    '',
    '<the_agents_question>',
    question.slice(0, ADVISOR_QUESTION_MAX_CHARS),
    '</the_agents_question>',
    '',
    ADVISOR_ASK_PROMPT_TAIL,
  ].join('\n')
}

export async function askAdvisor(
  agentId: string,
  question: string,
  messages: readonly Message[],
  road: AdvisorRoad = {},
): Promise<AskAdvisorResult> {
  const settings = road.settings ?? readAdvisorSettings()
  const refusal = advisorSeatRefusal(road.seat ?? advisorSessionSeat(), settings)
  if (refusal !== undefined) return { ok: false, reason: refusal }
  const trimmed = question.trim()
  if (trimmed === '') return { ok: false, reason: 'the question is empty' }
  let model = road.model
  if (model === undefined) {
    const resolved = resolveAdvisorModel()
    if (resolved.origin === 'unset') {
      logForDebugging(`advisor: no advisor model pinned — ${resolved.hint}; the ask from ${agentId} is unanswered`)
      return { ok: false, reason: `no advisor model is pinned — ${resolved.hint}` }
    }
    model = resolved.model
  }
  const context = await loadAdvisorContext(agentId, advisorContextOptions(road))
  const digest = renderAgentDigest(messages, context.cursor)
  const reply = await callAdvisorOnceMore(road.call ?? liveAdvisorCall, {
    model,
    system: ADVISOR_SYSTEM_PROMPT,
    prompt: composeAskPrompt(renderAdvisorMemory(context.rows), digest.text, trimmed),
    ...(road.model === undefined ? { effort: advisorDispatchEffort(model) } : {}),
    ...(road.signal !== undefined ? { signal: road.signal } : {}),
  })
  if (!reply.ok) return { ok: false, reason: reply.reason }
  const at = new Date(advisorClock(road)()).toISOString()
  if (digest.count > 0) {
    await appendAdvisorRow(context, { kind: 'digest', at, text: digest.text, cursor: digest.cursor })
  }
  await appendAdvisorRow(context, { kind: 'question', at, text: trimmed })
  const text = clampNoteLines(reply.text)
  await appendAdvisorRow(context, { kind: 'reply', at, text, model })
  await maybeCompactAdvisorContext(context, {
    model,
    ...(road.window !== undefined ? { window: road.window } : {}),
    ...(road.summarize !== undefined ? { summarize: road.summarize } : {}),
  })
  return { ok: true, reply: text, model }
}
