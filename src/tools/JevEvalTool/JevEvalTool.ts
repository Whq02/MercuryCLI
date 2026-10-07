import { buildTool, type ToolDef } from '../../Tool.js'
import { jevSystemOne } from '../../services/jev/jevClient.js'
import type { JevRoad, JevStatus, JevWireFailureKind } from '../../services/jev/jevContract.js'
import { jevKeyPresence, resolveJevApiKey } from '../../services/jev/jevKey.js'
import { noteJevAttempt, noteJevWireFailure, settleJevCall, takeJevNotice } from '../../services/jev/jevLedger.js'
import { readJevSettings } from '../../services/jev/jevSetting.js'
import { type JevAgentIdentity, jevStatus } from '../../services/jev/jevStatus.js'
import { getAgentContext } from '../../utils/agentContext.js'
import { checkReadPermissionForTool } from '../../utils/permissions/filesystem.js'
import { JEV_EVAL_MAX_RESULT_CHARS, JEV_EVAL_TOOL_NAME } from './constants.js'
import { jevEvalFileOf } from './jevEvalEvidence.js'
import { assembleJevEvalRequest } from './jevEvalRequest.js'
import {
  jevEvalAbortedText,
  jevEvalBadRequestText,
  jevEvalFailureEvidence,
  jevEvalFailureText,
  jevEvalRefusedText,
  type JevEvalRow,
  jevEvalTableText,
  jevEvalUnansweredCount,
  jevEvalUnavailableText,
} from './jevEvalResult.js'
import { type JevEvalInput, type JevEvalInputSchema, type JevEvalKind, jevEvalInputSchema } from './jevEvalSchema.js'
import { JEV_EVAL_DESCRIPTION, JEV_EVAL_PROMPT, JEV_EVAL_SEARCH_HINT } from './prompt.js'

export interface JevEvalOutput {
  status: string
  text: string
}

export function jevAgentIdentity(): JevAgentIdentity | undefined {
  const context = getAgentContext()
  return context === undefined ? undefined : { id: context.agentId, subagent: true }
}

export function jevEvalEnabled(): boolean {
  const settings = readJevSettings()
  if (!settings.enabled) return false
  if (!jevKeyPresence().present) return false
  return settings.subagents || jevAgentIdentity() === undefined
}

function unavailable(status: JevStatus, road: JevRoad = readJevSettings().road): JevEvalOutput {
  return { status: status.kind, text: jevEvalUnavailableText(status, takeJevNotice(status.kind, road)) }
}

export async function jevEvalCall(input: JevEvalInput, signal?: AbortSignal): Promise<JevEvalOutput> {
  const agent = jevAgentIdentity()
  const settings = readJevSettings()
  const road = settings.road
  const before = jevStatus(agent, Date.now(), settings)
  if (before.kind !== 'ready') return unavailable(before, road)
  const assembled = assembleJevEvalRequest(input, road)
  if (!assembled.ok) return { status: 'refused', text: jevEvalRefusedText(assembled.reason) }
  const key = resolveJevApiKey(process.env, road)
  if (key === undefined) return unavailable(jevStatus(agent, Date.now(), settings), road)
  const rows: JevEvalRow[] = []
  const flights: Promise<void>[] = []
  for (const entry of assembled.items) {
    const at = Date.now()
    const admission = jevStatus(agent, at, settings)
    const row: JevEvalRow = { label: entry.item.label, outcome: { kind: 'pending' } }
    rows.push(row)
    if (admission.kind !== 'ready') {
      row.outcome = { kind: 'not-sent', status: admission }
      continue
    }
    noteJevAttempt(at, agent?.id, road)
    flights.push(
      jevSystemOne(entry.request, key.key, { signal, road }).then(
        outcome => {
          row.outcome = outcome.ok ? { kind: 'answered', response: outcome.response, requestId: outcome.requestId, chargeUsd: 0 } : { kind: 'failed', failure: outcome.failure }
        },
        (error: unknown) => {
          row.outcome = { kind: 'failed', failure: { kind: 'provider-down', detail: `no answer — ${error instanceof Error ? error.message : String(error)}` } }
        },
      ),
    )
  }
  await Promise.all(flights)
  const now = Date.now()
  for (const row of rows) {
    if (row.outcome.kind !== 'answered') continue
    row.outcome.chargeUsd = settleJevCall(row.outcome.response.usage, row.outcome.response.model, now, road, row.outcome.requestId)
  }
  const noted = new Set<JevWireFailureKind>()
  for (const row of rows) {
    if (row.outcome.kind !== 'failed') continue
    const failure = row.outcome.failure
    if (failure.kind !== 'parse-failed' && failure.kind !== 'aborted' && noted.has(failure.kind)) continue
    noted.add(failure.kind)
    noteJevWireFailure(failure, now, Math.random, road)
  }
  const answered = rows.filter(row => row.outcome.kind === 'answered').length
  const after = jevStatus(agent, now, settings)
  if (answered === 0) {
    const first = rows.find(row => row.outcome.kind === 'failed')
    const failure = first?.outcome.kind === 'failed' ? first.outcome.failure : undefined
    if (failure === undefined) return unavailable(after, road)
    const count = jevEvalUnansweredCount(rows.length)
    if (failure.kind === 'bad-request') return { status: 'bad-request', text: `${jevEvalBadRequestText(failure)}${count}` }
    if (failure.kind === 'aborted') return { status: 'aborted', text: jevEvalAbortedText(road, flights.length, rows.length) }
    if (after.kind === 'ready') return { status: failure.kind, text: `${jevEvalFailureText(failure)}${count}` }
    const unavailableResult = unavailable(after, road)
    const [headline, ...notices] = unavailableResult.text.split('\n')
    return { ...unavailableResult, text: [`${headline} | ${jevEvalFailureEvidence(failure)}${count}`, ...notices].join('\n') }
  }
  const kinds: Record<string, JevEvalKind> = Object.fromEntries(input.questions.map(question => [question.id, question.kind]))
  const table = jevEvalTableText({ rows, order: assembled.order, kinds, sources: assembled.sources })
  return { status: 'ok', text: after.kind === 'ready' ? table : `${table}\n${unavailable(after, road).text}` }
}

export function jevEvalFilePaths(input: Pick<JevEvalInput, 'evidence'>): string[] {
  return (input.evidence ?? []).flatMap(item => {
    const file = jevEvalFileOf(item)
    return file === undefined ? [] : [file.path]
  })
}

export const JevEvalTool = buildTool({
  name: JEV_EVAL_TOOL_NAME,
  searchHint: JEV_EVAL_SEARCH_HINT,
  shouldDefer: true,
  maxResultSizeChars: JEV_EVAL_MAX_RESULT_CHARS,
  capability: {
    intents: [
      'rank hypotheses against the evidence with a second opinion',
      'get a probability on a yes/no judgement',
      'make a qualitative call after the numbers are measured',
      'check a proposal against recorded rulings',
    ],
    units: ['web-access'],
    class: 'observation',
    cancellation: 'cooperative',
    latency: 'interactive',
    conditions: ['JEV on: official key in /jev or OpenRouter key in /logins; crewmates on by default, off by choice in /jev'],
    proof: 'scripts/jev/run-all.sh',
  },
  get inputSchema(): JevEvalInputSchema {
    return jevEvalInputSchema()
  },
  isEnabled() {
    return jevEvalEnabled()
  },
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  isOpenWorld() {
    return true
  },
  interruptBehavior() {
    return 'cancel' as const
  },
  async checkPermissions(input, context) {
    const permissionContext = context.getAppState().toolPermissionContext
    for (const path of jevEvalFilePaths(input)) {
      const decision = checkReadPermissionForTool({ name: JEV_EVAL_TOOL_NAME, getPath: () => path }, input, permissionContext)
      if (decision.behavior !== 'allow') return decision
    }
    return { behavior: 'allow', updatedInput: input }
  },
  async description() {
    return JEV_EVAL_DESCRIPTION
  },
  async prompt() {
    return JEV_EVAL_PROMPT
  },
  userFacingName() {
    return JEV_EVAL_TOOL_NAME
  },
  getActivityDescription(input) {
    return typeof input?.goal === 'string' && input.goal !== '' ? `JevEval: ${input.goal}` : 'JevEval'
  },
  renderToolUseMessage(input) {
    return typeof input?.goal === 'string' ? input.goal : ''
  },
  renderToolResultMessage(output: JevEvalOutput | undefined) {
    return typeof output?.text === 'string' ? output.text : ''
  },
  mapToolResultToToolResultBlockParam(output: JevEvalOutput, toolUseID: string) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result' as const,
      content: output.text,
    }
  },
  async call(input, context) {
    return { data: await jevEvalCall(input, context.abortController.signal) }
  },
} satisfies ToolDef<JevEvalInputSchema, JevEvalOutput>)
