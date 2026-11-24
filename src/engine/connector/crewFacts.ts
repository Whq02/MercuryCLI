import type { WorkRowV1 } from './types.js'
import { splitWaitSentence } from '../../crew/capacity/seatWords.js'
import { workRowRuns, type WorkCountsV1 } from './workCounts.js'
import { formatDuration, formatTokens } from '../../platform/text/format.js'
import { formatSessionCost } from '../../models/roads/spendSpelling.js'
import { crewmateWaitWords, type CrewmateWaitV1 } from '../tasks/local-agent/crewmateWait.js'
import { decodeCrewmatePause, pauseStatusWords, type CrewmatePauseV1 } from '../tasks/local-agent/crewmatePause.js'
import { operatorPauseWaitParts, pauseGateChipWords } from '../loop/pauseGate.js'
import { parkedAskRowWords, type ParkedAskFacts } from '../../permissions/rules/askWords.js'
import { CREW_VIEW_DOOR } from '../../screen/cockpit/crewmateWords.js'

export type CrewmateKind = 'agent' | 'named'

export type CrewmateState = 'running' | 'idle' | 'paused' | 'landed' | 'stopped' | 'interrupted' | 'failed'

export const CREW_INTERRUPTED_BY_OPERATOR_WORDS = 'interrupted by the operator on its screen'

export interface CrewmateTokens {
  total: number
  context: number | null
  input: number | null
  output: number | null
  cached?: number | null
}

export interface CrewmateFacts {
  id: string
  name: string
  kind: CrewmateKind
  status: string
  state: CrewmateState
  running: boolean
  model: string | null
  tokens: CrewmateTokens | null
  costUSD: number | null
  unpricedTurns: number
  toolUses: number | null
  activity: string | null
  wait: string | null
  toolUseId: string | null
  startedAt: number
  endedAt: number | null
  agentType: string | null
  crew: string | null
  effort: string | null
  transcriptAgentId: string | null
  description: string | null
  error: string | null
  stopReason: string | null
  phase: CrewmateWaitV1 | null
  paused: CrewmatePauseV1 | null
  pendingAsks: number
  unreadNotices: number
  sessionId: string | null
  cwd: string | null
  worktree: string | null
}

export function isCrewRow(row: WorkRowV1): boolean {
  return row.kind === 'agent'
}

const positive = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null

function tokensOf(row: WorkRowV1): CrewmateTokens | null {
  const input = typeof row.inputTokens === 'number' && Number.isFinite(row.inputTokens) ? row.inputTokens : null
  const output = typeof row.outputTokens === 'number' && Number.isFinite(row.outputTokens) ? row.outputTokens : null
  const context = positive(row.contextTokens)
  const cached = typeof row.cacheReadTokens === 'number' && Number.isFinite(row.cacheReadTokens) && row.cacheReadTokens >= 0 ? row.cacheReadTokens : null
  if (input !== null && output !== null && (input + output > 0 || context !== null)) {
    return { total: input + output, context, input, output, cached }
  }
  const total = positive(row.totalTokens)
  return total === null ? null : { total, context, input: null, output: null, cached }
}

export function crewStateOf(row: Pick<WorkRowV1, 'status' | 'paused' | 'stopReason' | 'idle'>): CrewmateState {
  if (workRowRuns(row as WorkRowV1)) return row.idle === true ? 'idle' : 'running'
  if (decodeCrewmatePause(row.paused) !== null) return 'paused'
  switch (row.status) {
    case 'failed':
      return 'failed'
    case 'interrupted':
      return 'interrupted'
    case 'killed':
    case 'stopped':
    case 'cancelled':
      return row.stopReason === CREW_INTERRUPTED_BY_OPERATOR_WORDS ? 'interrupted' : 'stopped'
    default:
      return 'landed'
  }
}

export function crewSettled(facts: Pick<CrewmateFacts, 'running' | 'state'>): boolean {
  return !facts.running && facts.state !== 'paused'
}

export function crewmateFactsOf(row: WorkRowV1, sessionId: string | null): CrewmateFacts | null {
  if (!isCrewRow(row)) return null
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === 'agent' ? 'agent' : 'named',
    status: row.status,
    state: crewStateOf(row),
    running: workRowRuns(row),
    model: typeof row.model === 'string' && row.model !== '' ? row.model : null,
    tokens: tokensOf(row),
    costUSD: positive(row.costUSD),
    unpricedTurns: positive(row.unpricedTurns) ?? 0,
    toolUses: typeof row.toolUses === 'number' && Number.isFinite(row.toolUses) && row.toolUses >= 0 ? row.toolUses : null,
    activity: typeof row.activity === 'string' && row.activity !== '' ? row.activity : null,
    wait: typeof row.wait === 'string' && row.wait !== '' ? row.wait : null,
    toolUseId: typeof row.toolUseId === 'string' && row.toolUseId !== '' ? row.toolUseId : null,
    startedAt: row.startTime,
    endedAt: typeof row.endTime === 'number' && Number.isFinite(row.endTime) ? row.endTime : null,
    agentType: row.agentType ?? null,
    crew: row.crew ?? null,
    effort: typeof row.effort === 'string' && row.effort !== '' ? row.effort : null,
    transcriptAgentId: typeof row.transcriptAgentId === 'string' && row.transcriptAgentId !== '' ? row.transcriptAgentId : null,
    description: row.description ?? null,
    error: row.error ?? null,
    stopReason: typeof row.stopReason === 'string' && row.stopReason !== '' ? row.stopReason : null,
    phase: row.phase ?? null,
    paused: decodeCrewmatePause(row.paused),
    pendingAsks: row.pendingAsks ?? 0,
    unreadNotices: typeof row.unreadNotices === 'number' && Number.isFinite(row.unreadNotices) && row.unreadNotices > 0 ? Math.floor(row.unreadNotices) : 0,
    sessionId,
    cwd: typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : null,
    worktree: typeof row.worktree === 'string' && row.worktree !== '' ? row.worktree : null,
  }
}

export function workRowOfCrewFacts(facts: CrewmateFacts): WorkRowV1 {
  const t = facts.tokens
  return {
    id: facts.id,
    kind: 'agent',
    name: facts.name,
    status: facts.status,
    startTime: facts.startedAt,
    ...(facts.endedAt !== null ? { endTime: facts.endedAt } : {}),
    ...(facts.description !== null ? { description: facts.description } : {}),
    ...(facts.model !== null ? { model: facts.model } : {}),
    ...(facts.error !== null ? { error: facts.error } : {}),
    ...(t !== null ? { totalTokens: t.total } : {}),
    ...(t !== null && t.input !== null ? { inputTokens: t.input } : {}),
    ...(t !== null && t.output !== null ? { outputTokens: t.output } : {}),
    ...(t !== null && t.cached !== null && t.cached !== undefined ? { cacheReadTokens: t.cached } : {}),
    ...(t !== null && t.context !== null ? { contextTokens: t.context } : {}),
    ...(facts.costUSD !== null ? { costUSD: facts.costUSD } : {}),
    ...(facts.unpricedTurns > 0 ? { unpricedTurns: facts.unpricedTurns } : {}),
    ...(facts.toolUses !== null ? { toolUses: facts.toolUses } : {}),
    ...(facts.activity !== null ? { activity: facts.activity } : {}),
    ...(facts.wait !== null ? { wait: facts.wait } : {}),
    ...(facts.toolUseId !== null ? { toolUseId: facts.toolUseId } : {}),
    pendingAsks: facts.pendingAsks,
    ...(facts.agentType !== null ? { agentType: facts.agentType } : {}),
    ...(facts.crew !== null ? { crew: facts.crew } : {}),
    ...(facts.effort !== null ? { effort: facts.effort } : {}),
    ...(facts.transcriptAgentId !== null ? { transcriptAgentId: facts.transcriptAgentId } : {}),
    ...(facts.state === 'idle' ? { idle: true } : {}),
    ...(facts.stopReason !== null ? { stopReason: facts.stopReason } : {}),
    ...(facts.phase !== null ? { phase: facts.phase } : {}),
    ...(facts.paused !== null ? { paused: facts.paused } : {}),
    ...(facts.unreadNotices > 0 ? { unreadNotices: facts.unreadNotices } : {}),
    ...(facts.cwd !== null ? { cwd: facts.cwd } : {}),
    ...(facts.worktree !== null ? { worktree: facts.worktree } : {}),
  }
}

export function crewmatesOf(rows: readonly WorkRowV1[], sessionId: string | null): CrewmateFacts[] {
  const out: CrewmateFacts[] = []
  for (const row of rows) {
    const facts = crewmateFactsOf(row, sessionId)
    if (facts !== null) out.push(facts)
  }
  out.sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1
    return b.startedAt - a.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  })
  return out
}

export function crewRunning(agents: readonly CrewmateFacts[]): CrewmateFacts[] {
  return agents.filter(a => a.running)
}

export function crewmateByToolUse(agents: readonly CrewmateFacts[], toolUseId: string): CrewmateFacts | null {
  return agents.find(a => a.toolUseId === toolUseId) ?? null
}

export function crewTokenSum(agents: readonly CrewmateFacts[]): number {
  let sum = 0
  for (const a of agents) sum += a.tokens?.total ?? 0
  return sum
}

export function crewSpendOf(agents: readonly CrewmateFacts[]): { costUSD: number; unpricedTurns: number } {
  let costUSD = 0
  let unpricedTurns = 0
  for (const a of agents) {
    costUSD += a.costUSD ?? 0
    unpricedTurns += a.unpricedTurns
  }
  return { costUSD, unpricedTurns }
}


export const CREW_EMPTY_LINE = 'no crewmates running'
export const CREW_EMPTY_DOOR = 'ask the chat to delegate work'
export const CREW_MODEL_UNKNOWN = '—'

export function crewModelLabel(facts: CrewmateFacts): string {
  return facts.model ?? CREW_MODEL_UNKNOWN
}

export function crewStateLabel(facts: CrewmateFacts): string {
  return facts.running && facts.wait !== null ? 'waiting' : facts.state
}

export function crewWaitLine(facts: CrewmateFacts): string | null {
  return facts.running ? facts.wait : null
}

export function crewWaitHolders(facts: CrewmateFacts): string | null {
  const line = crewWaitLine(facts)
  if (line === null) return null
  const { holders } = splitWaitSentence(line)
  return holders === '' ? null : `held by ${holders}`
}

export function crewPhaseWords(facts: CrewmateFacts, nowMs: number): string | null {
  if (!facts.running || facts.state === 'idle') return null
  return facts.wait ?? crewmateWaitWords(facts.phase, nowMs) ?? facts.activity
}

export const CREW_ASK_WAIT_WORDS = 'waiting for your answer'

export function crewStatusWords(facts: CrewmateFacts, nowMs: number): string {
  if (facts.running && facts.pendingAsks > 0) return CREW_ASK_WAIT_WORDS
  const parkedByOperator = crewOperatorPauseParts(facts)
  if (parkedByOperator !== null) return parkedByOperator.gate
  if (facts.running && facts.wait !== null) return splitWaitSentence(facts.wait).gate
  if (!facts.running && facts.paused !== null) return pauseStatusWords(facts.paused, nowMs)
  return crewStateLabel(facts)
}

export function crewParkedAsks<T extends ParkedAskFacts>(facts: Pick<CrewmateFacts, 'id' | 'running'>, asks: readonly T[]): T[] {
  if (!facts.running) return []
  return asks.filter(ask => ask.agentId === facts.id)
}

export function crewAskWaitDetail(facts: Pick<CrewmateFacts, 'id' | 'running' | 'pendingAsks'>, asks: readonly ParkedAskFacts[], nowMs: number): string | null {
  if (!facts.running || facts.pendingAsks <= 0) return null
  const parked = crewParkedAsks(facts, asks)
  if (parked.length === 0) return null
  return parked.map(ask => parkedAskRowWords(ask, nowMs)).join(' · ')
}

export function crewOperatorPauseParts(facts: Pick<CrewmateFacts, 'running' | 'wait'>): { gate: string; detail: string; door: string } | null {
  if (!facts.running) return null
  return operatorPauseWaitParts(facts.wait)
}

export function crewOperatorPaused(agents: readonly CrewmateFacts[]): CrewmateFacts[] {
  return agents.filter(a => crewOperatorPauseParts(a) !== null)
}

export function crewPauseChipWords(agents: readonly CrewmateFacts[], gate: { paused: boolean; parked: number }): string | null {
  const parkedRows = crewOperatorPaused(agents).length
  return pauseGateChipWords({ paused: gate.paused || parkedRows > 0, parked: Math.max(gate.parked, parkedRows) })
}

export function crewPaused(agents: readonly CrewmateFacts[]): CrewmateFacts[] {
  return agents.filter(a => a.state === 'paused')
}

export function crewUnreadLabel(facts: CrewmateFacts): string | null {
  if (!(facts.unreadNotices > 0)) return null
  return `${facts.unreadNotices} unread`
}

export function crewToolUsesLabel(facts: CrewmateFacts): string | null {
  if (facts.toolUses === null) return null
  return `${facts.toolUses} tool use${facts.toolUses === 1 ? '' : 's'}`
}

export function crewWaitingWords(running: number): string | null {
  if (!(running > 0)) return null
  return `waiting on ${running} crewmate${running === 1 ? '' : 's'}`
}

export function crewStillRunningLine(
  running: number | Pick<WorkCountsV1, 'agents'>,
): string | null {
  const agents = typeof running === 'number' ? running : running.agents
  const parts: string[] = []
  if (agents > 0) parts.push(`${agents} crewmate${agents === 1 ? '' : 's'} still running — open the crew view (${CREW_VIEW_DOOR}) and press x twice on its row to stop one`)
  return parts.length === 0 ? null : parts.join(' · ')
}

export type InterruptPressFacts = { interrupting: boolean } | null

export function interruptReceiptLine(
  running: number | Pick<WorkCountsV1, 'agents'>,
  press: InterruptPressFacts,
): string | null {
  if (press?.interrupting === true) return null
  return crewStillRunningLine(running)
}

export function crewTokensLabel(facts: CrewmateFacts): string | null {
  const t = facts.tokens
  if (t === null) return null
  return t.context !== null ? `${formatTokens(t.context)} context` : `${formatTokens(t.total)} spent`
}

export function crewSpendLabel(facts: CrewmateFacts): string | null {
  return facts.tokens === null ? null : `${formatTokens(facts.tokens.total)} spent`
}

export function crewTokensBreakdown(facts: CrewmateFacts): string | null {
  const t = facts.tokens
  if (t === null || t.input === null || t.output === null) return null
  return `${formatTokens(t.input)} in · ${formatTokens(t.output)} out${(t.cached ?? 0) > 0 ? ` · ${formatTokens(t.cached!)} cached` : ''}`
}

export function crewTokensSummary(facts: CrewmateFacts): string {
  const label = crewTokensLabel(facts)
  if (label === null) return 'usage not reported'
  const breakdown = crewTokensBreakdown(facts)
  return breakdown === null ? label : `${label} · ${breakdown}`
}

export function crewCostLabel(facts: CrewmateFacts): string | null {
  const cost = facts.costUSD ?? 0
  if (cost <= 0 && facts.unpricedTurns <= 0) return null
  return formatSessionCost(cost, facts.unpricedTurns)
}

export function crewElapsedLabel(facts: CrewmateFacts, nowMs: number): string {
  return formatDuration(Math.max(0, (facts.endedAt ?? nowMs) - facts.startedAt))
}

export function crewTimeWords(facts: CrewmateFacts, nowMs: number): string {
  const elapsed = crewElapsedLabel(facts, nowMs)
  if (facts.state === 'running') return `running for ${elapsed}`
  if (facts.state === 'landed') return `landed in ${elapsed}`
  return `${crewStateLabel(facts)} · ${elapsed}`
}

export function crewCountLabel(agents: readonly CrewmateFacts[]): string {
  if (agents.length === 0) return CREW_EMPTY_LINE
  const running = crewRunning(agents).length
  const paused = crewPaused(agents).length
  return `${running} running${paused > 0 ? ` · ${paused} paused` : ''}`
}

export function crewUsageLine(agents: readonly CrewmateFacts[]): string | null {
  const counted = agents.filter(a => a.tokens !== null)
  if (counted.length === 0) return null
  const running = crewRunning(counted).length
  const n = counted.length
  const spend = crewSpendOf(counted)
  const spendPart = spend.costUSD > 0 || spend.unpricedTurns > 0 ? ` · ${formatSessionCost(spend.costUSD, spend.unpricedTurns)}` : ''
  return `crewmates ${formatTokens(crewTokenSum(counted))} spent · ${n} crewmate${n === 1 ? '' : 's'}${running > 0 ? ` · ${running} live` : ''}${spendPart}`
}

export function crewRowLine(facts: CrewmateFacts, nowMs: number): string {
  return [
    facts.name,
    crewModelLabel(facts),
    crewStateLabel(facts),
    crewTokensLabel(facts) ?? CREW_MODEL_UNKNOWN,
    crewElapsedLabel(facts, nowMs),
  ].join(' · ')
}
