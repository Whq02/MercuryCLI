// ============================================================================
//  engine-connector/crewFacts — the ONE facts law for a session's crew: its
//  sub-agents, the dispatched agents and the named agents its runner hosts.
//
//  Every surface that names a sub-agent — the cockpit's CREW lane, the Crew
//  view, the /tasks board's row and its card, the usage attribution line —
//  derives the SAME record from the SAME roster row (the runner's own task
//  store, published through the facts projection) and spells it through
//  the functions below. One derivation, one spelling: two surfaces can
//  never disagree about an agent's model, status or tokens, and the
//  crew-truth prover diffs the surfaces against this owner from one
//  fixture. Nothing here reads a process global — the rows arrive from the
//  focused session's connector, whatever family its runner speaks.
// ============================================================================
import type { WorkRowV1 } from './types.js'
import { workRowRuns } from './workCounts.js'
import { formatDuration, formatTokens } from '../../utils/format.js'
import { formatSessionCost } from '../../utils/spendSpelling.js'

/** 'agent' = a dispatched sub-agent (the Agent tool's launch); 'named' = a
 *  named, addressable sub-agent (a message reaches it by its name). */
export type CrewAgentKind = 'agent' | 'named'

/** The ONE status vocabulary every crew surface speaks — running (or
 *  queued to run) · landed · stopped (the operator's or an interrupt's
 *  stop) · failed. The runner's kind-status words map here once. */
export type CrewAgentState = 'running' | 'landed' | 'stopped' | 'failed'

export interface CrewAgentTokens {
  /** input + output — the figure every row and the attribution line spell. */
  total: number
  /** Cumulative input with the cached prefix read and written counted in;
   *  null when the runner carried only a total. */
  input: number | null
  output: number | null
}

export interface CrewAgentFacts {
  id: string
  name: string
  kind: CrewAgentKind
  /** The runner's own status word — never re-derived by a surface. */
  status: string
  /** The one status vocabulary (crewStateOf over the runner's word). */
  state: CrewAgentState
  /** Running or queued to run (the ONE counting law, workRowRuns). */
  running: boolean
  /** The model the agent runs: the served id once a response landed, the
   *  launch's resolved id before; null when the runner recorded none. */
  model: string | null
  /** null until the first settled response — never a fabricated zero. */
  tokens: CrewAgentTokens | null
  /** USD the pricing owner priced at the served model's rate; null when
   *  nothing was priced. */
  costUSD: number | null
  /** Settled responses no rate on file could price — counted beside the
   *  tokens, never at a foreign rate. */
  unpricedTurns: number
  /** The tracker's tool-use count; null until the runner published one. */
  toolUses: number | null
  /** The running tool's own description (the latest activity); null when none. */
  activity: string | null
  /** The tool-use id of the launch that minted the row; null for a named
   *  agent's spawn. The transcript's tool card joins by it. */
  toolUseId: string | null
  startedAt: number
  endedAt: number | null
  agentType: string | null
  /** Named agents: the group whose mailbox they share. */
  team: string | null
  description: string | null
  error: string | null
  pendingAsks: number
  /** The session whose runner hosts the agent — its parent. */
  sessionId: string | null
}

/** A roster row that IS a sub-agent (the other kinds are processes). */
export function isCrewRow(row: WorkRowV1): boolean {
  return row.kind === 'agent' || row.kind === 'teammate'
}

const positive = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null

function tokensOf(row: WorkRowV1): CrewAgentTokens | null {
  const input = typeof row.inputTokens === 'number' && Number.isFinite(row.inputTokens) ? row.inputTokens : null
  const output = typeof row.outputTokens === 'number' && Number.isFinite(row.outputTokens) ? row.outputTokens : null
  if (input !== null && output !== null && input + output > 0) {
    return { total: input + output, input, output }
  }
  const total = positive(row.totalTokens)
  return total === null ? null : { total, input: null, output: null }
}

/** The runner's kind-status word mapped ONCE onto the crew vocabulary:
 *  running/pending run (the counting law); failed fails; killed — and
 *  the stop words an interrupt settles a row with — stopped; the rest
 *  landed. */
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

/** The record for one roster row; null for a row that is not a sub-agent. */
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
    toolUseId: typeof row.toolUseId === 'string' && row.toolUseId !== '' ? row.toolUseId : null,
    startedAt: row.startTime,
    endedAt: typeof row.endTime === 'number' && Number.isFinite(row.endTime) ? row.endTime : null,
    agentType: row.agentType ?? null,
    team: row.team ?? null,
    description: row.description ?? null,
    error: row.error ?? null,
    pendingAsks: row.pendingAsks ?? 0,
    sessionId,
  }
}

/** The session's crew in board order — running first, newest first (the
 *  /tasks board's own order). Settled agents stay listed: a landed row is
 *  a fact until the runner evicts it. */
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

/** The agent an Agent tool call launched — the transcript's tool card
 *  joins its row to the record by the call's id. */
export function crewAgentByToolUse(agents: readonly CrewAgentFacts[], toolUseId: string): CrewAgentFacts | null {
  return agents.find(a => a.toolUseId === toolUseId) ?? null
}

/** A named agent by its name (a spawn no tool call minted). */
export function crewAgentByName(agents: readonly CrewAgentFacts[], name: string): CrewAgentFacts | null {
  const bare = name.replace(/^@/, '')
  return agents.find(a => a.kind === 'named' && a.name === bare) ?? null
}

/** The tokens the crew settled, summed over the agents that settled any. */
export function crewTokenSum(agents: readonly CrewAgentFacts[]): number {
  let sum = 0
  for (const a of agents) sum += a.tokens?.total ?? 0
  return sum
}

/** The crew's spend in the ledger's law: priced USD beside the unpriced
 *  turn count (never a foreign rate, never printed free). */
export function crewSpendOf(agents: readonly CrewAgentFacts[]): { costUSD: number; unpricedTurns: number } {
  let costUSD = 0
  let unpricedTurns = 0
  for (const a of agents) {
    costUSD += a.costUSD ?? 0
    unpricedTurns += a.unpricedTurns
  }
  return { costUSD, unpricedTurns }
}

// ── the spellings — one owner, every surface ────────────────────────────────

/** The empty state every crew surface prints. */
export const CREW_EMPTY_LINE = 'no sub-agents running'
/** The door beside the empty state: how a sub-agent comes to exist. */
export const CREW_EMPTY_DOOR = 'ask the chat to delegate work, or press n to spawn a named agent'
/** A row whose runner recorded no model. */
export const CREW_MODEL_UNKNOWN = '—'

export function crewModelLabel(facts: CrewAgentFacts): string {
  return facts.model ?? CREW_MODEL_UNKNOWN
}

/** The one status word. */
export function crewStateLabel(facts: CrewAgentFacts): string {
  return facts.state
}

/** `3 tool uses`; null until the runner published a count. */
export function crewToolUsesLabel(facts: CrewAgentFacts): string | null {
  if (facts.toolUses === null) return null
  return `${facts.toolUses} tool use${facts.toolUses === 1 ? '' : 's'}`
}

/** The wait's words from a bare count — the runner's own agent-wait
 *  count (its status frame) reaches a hosted seat without the roster rows,
 *  and speaks the same spelling. Null for no agents. */
export function crewWaitingWords(running: number): string | null {
  if (!(running > 0)) return null
  return `waiting on ${running} agent${running === 1 ? '' : 's'}`
}

/** What a parent turn held open by its crew is doing — `waiting on N
 *  agents`; null when none runs (the tail's own word stands). */
export function crewWaitingLine(agents: readonly CrewAgentFacts[]): string | null {
  return crewWaitingWords(crewRunning(agents).length)
}

/** `12.3k tokens`; null before the first settled response (the surface
 *  prints its own honest absence, never a zero). */
export function crewTokensLabel(facts: CrewAgentFacts): string | null {
  return facts.tokens === null ? null : `${formatTokens(facts.tokens.total)} tokens`
}

/** `9.8k in · 2.5k out`; null when the runner carried only a total. */
export function crewTokensBreakdown(facts: CrewAgentFacts): string | null {
  const t = facts.tokens
  if (t === null || t.input === null || t.output === null) return null
  return `${formatTokens(t.input)} in · ${formatTokens(t.output)} out`
}

/** The spend figure in the ONE spelling (formatSessionCost); null when the
 *  agent priced nothing and settled no unpriced turn. */
export function crewCostLabel(facts: CrewAgentFacts): string | null {
  const cost = facts.costUSD ?? 0
  if (cost <= 0 && facts.unpricedTurns <= 0) return null
  return formatSessionCost(cost, facts.unpricedTurns)
}

/** Elapsed since the launch — frozen at the settle for a landed agent. */
export function crewElapsedLabel(facts: CrewAgentFacts, nowMs: number): string {
  return formatDuration(Math.max(0, (facts.endedAt ?? nowMs) - facts.startedAt))
}

/** The count line a crew label carries — the SAME rows the surface lists. */
export function crewCountLabel(agents: readonly CrewAgentFacts[]): string {
  if (agents.length === 0) return CREW_EMPTY_LINE
  const running = crewRunning(agents).length
  const n = agents.length
  return `${running} running · ${n} sub-agent${n === 1 ? '' : 's'}`
}

/** The usage attribution line: the crew's tokens beside the session's own
 *  total (they are IN that total — the runner's ledger folds every
 *  response its process settles, a sub-agent's included). Null when no
 *  sub-agent settled a response yet. */
export function crewUsageLine(agents: readonly CrewAgentFacts[]): string | null {
  const counted = agents.filter(a => a.tokens !== null)
  if (counted.length === 0) return null
  const running = crewRunning(counted).length
  const n = counted.length
  const spend = crewSpendOf(counted)
  const spendPart = spend.costUSD > 0 || spend.unpricedTurns > 0 ? ` · ${formatSessionCost(spend.costUSD, spend.unpricedTurns)}` : ''
  return `sub-agents ${formatTokens(crewTokenSum(counted))} tokens · ${n} agent${n === 1 ? '' : 's'}${running > 0 ? ` · ${running} live` : ''}${spendPart}`
}

/** One line per agent — name · model · status · tokens · elapsed. */
export function crewRowLine(facts: CrewAgentFacts, nowMs: number): string {
  return [
    facts.name,
    crewModelLabel(facts),
    crewStateLabel(facts),
    crewTokensLabel(facts) ?? CREW_MODEL_UNKNOWN,
    crewElapsedLabel(facts, nowMs),
  ].join(' · ')
}
