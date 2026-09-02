// ============================================================================
//  Agent Studio data layer — pure projections over the loaded estate.
//  No I/O here (mercury-ui rule): the component passes the loaded
//  AgentDefinitionsResult; this module filters/sorts/annotates rows.
// ============================================================================
import type {
  AgentDefinition,
  AgentDefinitionsResult,
} from '../../../tools/AgentTool/loadAgentsDir.js'
import {
  type AgentEstateEntry,
  resolveAgentEstate,
} from '../../../services/agents/resolver.js'
import { fuzzySearch } from '../../../utils/fuzzyMatch.js'

export type StudioScopeTab =
  | 'all'
  | 'project'
  | 'user'
  | 'built-in'
  | 'extension'
  | 'managed'

export const SCOPE_TABS: StudioScopeTab[] = [
  'all',
  'project',
  'user',
  'built-in',
  'extension',
  'managed',
]

export type StudioStatusFilter = 'all' | 'issues' | 'disabled'
export const STATUS_FILTERS: StudioStatusFilter[] = [
  'all',
  'issues',
  'disabled',
]

export type StudioRow = {
  id: string
  kind: 'agent' | 'invalid'
  agent?: AgentDefinition
  /** For invalid rows: the unparseable file. */
  invalid?: { path: string; error: string }
  /** Set when another candidate wins this name. */
  shadowed?: boolean
}

function scopeOf(agent: AgentDefinition): StudioScopeTab {
  switch (agent.source) {
    case 'built-in':
      return 'built-in'
    case 'extension':
      return 'extension'
    case 'userSettings':
      return 'user'
    case 'policySettings':
      return 'managed'
    case 'projectSettings':
    case 'localSettings':
    case 'flagSettings':
      return 'project'
  }
}

export function isFileBacked(
  agent: AgentDefinition,
): agent is AgentDefinition & { filePath: string; revision: string } {
  return (
    typeof (agent as { filePath?: string }).filePath === 'string' &&
    typeof (agent as { revision?: string }).revision === 'string'
  )
}

export type StudioEstate = {
  rows: StudioRow[]
  estate: Map<string, AgentEstateEntry>
  counts: { total: number; issues: number; disabled: number }
}

export function buildStudioRows(
  result: AgentDefinitionsResult,
  opts: {
    tab: StudioScopeTab
    filter: StudioStatusFilter
    query: string
  },
): StudioEstate {
  const estate = resolveAgentEstate(result)
  const winners = new Set(result.activeAgents)

  let rows: StudioRow[] = []
  for (const agent of result.allAgents) {
    const isWinner = winners.has(agent)
    rows.push({
      id: `${agent.agentType}:${agent.source}:${(agent as { filePath?: string }).filePath ?? 'mem'}`,
      kind: 'agent',
      agent,
      shadowed: !isWinner && agent.disabled !== true,
    })
  }
  for (const f of result.failedFiles ?? []) {
    rows.push({
      id: `invalid:${f.path}`,
      kind: 'invalid',
      invalid: f,
    })
  }

  const counts = {
    total: rows.length,
    issues: rows.filter(
      r => r.kind === 'invalid' || r.shadowed === true,
    ).length,
    disabled: rows.filter(r => r.agent?.disabled === true).length,
  }

  if (opts.tab !== 'all') {
    rows = rows.filter(r =>
      r.kind === 'invalid' ? opts.tab === 'project' : scopeOf(r.agent!) === opts.tab,
    )
  }
  switch (opts.filter) {
    case 'issues':
      rows = rows.filter(r => r.kind === 'invalid' || r.shadowed === true)
      break
    case 'disabled':
      rows = rows.filter(r => r.agent?.disabled === true)
      break
    case 'all':
      break
  }

  const query = opts.query.trim()
  if (query) {
    // Haystack per row, prefixed with a row-index tag so ranked results map
    // back even when two rows share display text.
    const haystacks = rows.map(
      (r, i) =>
        `${i} ${
          r.kind === 'invalid'
            ? `${r.invalid!.path} invalid`
            : `${r.agent!.agentType} ${r.agent!.whenToUse.slice(0, 200)} ${r.agent!.source} ${r.agent!.model ?? ''}`
        }`,
    )
    const ranked = fuzzySearch(haystacks, query, 60)
    rows = ranked
      .map(m => rows[Number(m.path.slice(0, m.path.indexOf(' ')))])
      .filter((r): r is StudioRow => r !== undefined)
  } else {
    // Stable order: winners first by name, then shadowed, then invalid.
    rows = [...rows].sort((a, b) => {
      const rank = (r: StudioRow): number =>
        r.kind === 'invalid' ? 2 : r.shadowed ? 1 : 0
      if (rank(a) !== rank(b)) return rank(a) - rank(b)
      const an = a.agent?.agentType ?? a.invalid?.path ?? ''
      const bn = b.agent?.agentType ?? b.invalid?.path ?? ''
      return an.localeCompare(bn, undefined, { sensitivity: 'base' })
    })
  }

  return { rows, estate, counts }
}
