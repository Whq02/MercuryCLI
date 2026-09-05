import type { WorkRowV1 } from './types.js'
import { splitWaitSentence } from '../capacity/seatWords.js'
import { workRowRuns } from './workCounts.js'
import { formatDuration, formatTokens } from '../../utils/format.js'
import { formatSessionCost } from '../../utils/spendSpelling.js'
import { agentWaitWords, type AgentWaitV1 } from '../../tasks/LocalAgentTask/agentWait.js'

export type CrewAgentKind = 'agent' | 'named'

export type CrewAgentState = 'running' | 'landed' | 'stopped' | 'failed'

export interface CrewAgentTokens {
  total: number
  context: number | null
  input: number | null
  output: number | null
}

export interface CrewAgentFacts {
  id: string
  name: string
  kind: CrewAgentKind
  status: string
  state: CrewAgentState
  running: boolean
  model: string | null
  tokens: CrewAgentTokens | null
  costUSD: number | null
  unpricedTurns: number
  toolUses: number | null
  activity: string | null
  wait: string | null
  toolUseId: string | null
  startedAt: number
  endedAt: number | null
  agentType: string | null
  team: string | null
  description: string | null
  error: string | null
  stopReason: string | null
  phase: AgentWaitV1 | null
  pendingAsks: number
  sessionId: string | null
}

export function isCrewRow(row: WorkRowV1): boolean {
  return row.kind === 'agent' || row.kind === 'teammate'
}

const positive = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null

function tokensOf(row: WorkRowV1): CrewAgentTokens | null {
  const input = typeof row.inputTokens === 'number' && Number.isFinite(row.inputTokens) ? row.inputTokens : null
  const output = typeof row.outputTokens === 'number' && Number.isFinite(row.outputTokens) ? row.outputTokens : null
  const context = positive(row.contextTokens)
  if (input !== null && output !== null && input + output > 0) {
    return { total: input + output, context, input, output }
  }
  const total = positive(row.totalTokens)
  return total === null ? null : { total, context, input: null, output: null }
}

export function crewStateOf(row: Pick<WorkRowV1, 'status'>): CrewAgentState {
  if (workRowRuns(row as WorkRowV1)) return 'running'
  switch (row.status) {
    case 'failed':
      return 'failed'
    case 'killed':
    case 'stopped':
    case 'cancelled':
    case 'interrupted':
      return 'stopped'
    default:
      return 'landed'
  }
}

export function crewAgentFactsOf(row: WorkRowV1, sessionId: string | null): CrewAgentFacts | null {
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
    team: row.team ?? null,
    description: row.description ?? null,
    error: row.error ?? null,
    stopReason: typeof row.stopReason === 'string' && row.stopReason !== '' ? row.stopReason : null,
    phase: row.phase ?? null,
    pendingAsks: row.pendingAsks ?? 0,
    sessionId,
  }
}

export function crewAgentsOf(rows: readonly WorkRowV1[], sessionId: string | null): CrewAgentFacts[] {
  const out: CrewAgentFacts[] = []
  for (const row of rows) {
    const facts = crewAgentFactsOf(row, sessionId)
    if (facts !== null) out.push(facts)
  }
  out.sort((a, b) => {
    if (a.running !== b.running) return a.running ? -1 : 1
    return b.startedAt - a.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  })
  return out
}

export function crewRunning(agents: readonly CrewAgentFacts[]): CrewAgentFacts[] {
  return agents.filter(a => a.running)
}

export function crewAgentByToolUse(agents: readonly CrewAgentFacts[], toolUseId: string): CrewAgentFacts | null {
  return agents.find(a => a.toolUseId === toolUseId) ?? null
}

export function crewAgentByName(agents: readonly CrewAgentFacts[], name: string): CrewAgentFacts | null {
  const bare = name.replace(/^@/, '')
  return agents.find(a => a.kind === 'named' && a.name === bare) ?? null
}

export function crewTokenSum(agents: readonly CrewAgentFacts[]): number {
  let sum = 0
  for (const a of agents) sum += a.tokens?.total ?? 0
  return sum
}

export function crewSpendOf(agents: readonly CrewAgentFacts[]): { costUSD: number; unpricedTurns: number } {
  let costUSD = 0
  let unpricedTurns = 0
  for (const a of agents) {
    costUSD += a.costUSD ?? 0
    unpricedTurns += a.unpricedTurns
  }
  return { costUSD, unpricedTurns }
}


export const CREW_EMPTY_LINE = 'no sub-agents running'
export const CREW_EMPTY_DOOR = 'ask the chat to delegate work, or press n to spawn a named agent'
export const CREW_MODEL_UNKNOWN = '—'

export function crewModelLabel(facts: CrewAgentFacts): string {
  return facts.model ?? CREW_MODEL_UNKNOWN
}

export function crewStateLabel(facts: CrewAgentFacts): string {
  return facts.running && facts.wait !== null ? 'waiting' : facts.state
}

export function crewWaitLine(facts: CrewAgentFacts): string | null {
  return facts.running ? facts.wait : null
}

export function crewWaitHolders(facts: CrewAgentFacts): string | null {
  const line = crewWaitLine(facts)
  if (line === null) return null
  const { holders } = splitWaitSentence(line)
  return holders === '' ? null : `held by ${holders}`
}

export function crewPhaseWords(facts: CrewAgentFacts, nowMs: number): string | null {
  if (!facts.running) return null
  return facts.wait ?? agentWaitWords(facts.phase, nowMs) ?? facts.activity
}

export const CREW_ASK_WAIT_WORDS = 'waiting for your answer'

export function crewStatusWords(facts: CrewAgentFacts, nowMs: number): string {
  if (facts.running && facts.pendingAsks > 0) return CREW_ASK_WAIT_WORDS
  if (facts.running && facts.wait !== null) return splitWaitSentence(facts.wait).gate
  return crewPhaseWords(facts, nowMs) ?? crewStateLabel(facts)
}

export function crewToolUsesLabel(facts: CrewAgentFacts): string | null {
  if (facts.toolUses === null) return null
  return `${facts.toolUses} tool use${facts.toolUses === 1 ? '' : 's'}`
}

export function crewWaitingWords(running: number): string | null {
  if (!(running > 0)) return null
  return `waiting on ${running} agent${running === 1 ? '' : 's'}`
}

export function crewWaitingLine(agents: readonly CrewAgentFacts[]): string | null {
  return crewWaitingWords(crewRunning(agents).length)
}

export function crewStillRunningLine(running: number): string | null {
  if (!(running > 0)) return null
  return `${running} sub-agent${running === 1 ? '' : 's'} still running — open the crew view (/teammates) to stop one`
}

export function crewTokensLabel(facts: CrewAgentFacts): string | null {
  const t = facts.tokens
  if (t === null) return null
  return t.context !== null ? `${formatTokens(t.context)} context` : `${formatTokens(t.total)} spent`
}

export function crewSpendLabel(facts: CrewAgentFacts): string | null {
  return facts.tokens === null ? null : `${formatTokens(facts.tokens.total)} spent`
}

export function crewTokensBreakdown(facts: CrewAgentFacts): string | null {
  const t = facts.tokens
  if (t === null || t.input === null || t.output === null) return null
  return `${formatTokens(t.input)} in · ${formatTokens(t.output)} out`
}

export function crewCostLabel(facts: CrewAgentFacts): string | null {
  const cost = facts.costUSD ?? 0
  if (cost <= 0 && facts.unpricedTurns <= 0) return null
  return formatSessionCost(cost, facts.unpricedTurns)
}

export function crewElapsedLabel(facts: CrewAgentFacts, nowMs: number): string {
  return formatDuration(Math.max(0, (facts.endedAt ?? nowMs) - facts.startedAt))
}

export function crewCountLabel(agents: readonly CrewAgentFacts[]): string {
  if (agents.length === 0) return CREW_EMPTY_LINE
  const running = crewRunning(agents).length
  const n = agents.length
  return `${running} running · ${n} sub-agent${n === 1 ? '' : 's'}`
}

export function crewUsageLine(agents: readonly CrewAgentFacts[]): string | null {
  const counted = agents.filter(a => a.tokens !== null)
  if (counted.length === 0) return null
  const running = crewRunning(counted).length
  const n = counted.length
  const spend = crewSpendOf(counted)
  const spendPart = spend.costUSD > 0 || spend.unpricedTurns > 0 ? ` · ${formatSessionCost(spend.costUSD, spend.unpricedTurns)}` : ''
  return `sub-agents ${formatTokens(crewTokenSum(counted))} spent · ${n} agent${n === 1 ? '' : 's'}${running > 0 ? ` · ${running} live` : ''}${spendPart}`
}

export function crewRowLine(facts: CrewAgentFacts, nowMs: number): string {
  return [
    facts.name,
    crewModelLabel(facts),
    crewStateLabel(facts),
    crewTokensLabel(facts) ?? CREW_MODEL_UNKNOWN,
    crewElapsedLabel(facts, nowMs),
  ].join(' · ')
}
