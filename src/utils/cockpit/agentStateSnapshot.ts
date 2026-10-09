
import { getSessionId } from '../../bootstrap/state.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  type AgentStateVerdict,
  agentNeedsYouEnabled,
  getAgentStateVerdict,
} from '../../services/agentNeedsYou.js'
import { type Snapshot, withState } from './types.js'

export type AgentStateData = {
  verdict: AgentStateVerdict | null
  needsAttention: boolean
  ageMs: number | null
}

const EMPTY: AgentStateData = {
  verdict: null,
  needsAttention: false,
  ageMs: null,
}

export function agentStateSnapshot(): Snapshot<{ data: AgentStateData }> {
  if (!agentNeedsYouEnabled()) {
    return withState(
      'off',
      EMPTY,
      flagEnv('MERCURY_AGENT_NEEDS_YOU') === '0'
        ? 'MERCURY_AGENT_NEEDS_YOU=0 (opted out)'
        : 'needs-you off',
      'agentNeedsYou',
    )
  }
  try {
    const rec = getAgentStateVerdict(getSessionId())
    if (!rec) {
      return withState(
        'unavailable',
        EMPTY,
        'no verdict yet this session',
        'agentNeedsYou',
      )
    }
    return withState(
      'live',
      {
        verdict: rec.verdict,
        needsAttention: rec.verdict.tempo === 'blocked',
        ageMs: Date.now() - rec.at,
      },
      undefined,
      'agentNeedsYou',
    )
  } catch (e) {
    return withState(
      'failed',
      EMPTY,
      `agentStateSnapshot error: ${e instanceof Error ? e.message : String(e)}`,
      'agentNeedsYou',
    )
  }
}
