
import { getSessionId } from '../../bootstrap/state.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  type AgentStateVerdict,
  agentStateClassifierEnabled,
  getAgentStateVerdict,
} from '../../services/agentStateClassifier.js'
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
  if (!agentStateClassifierEnabled()) {
    return withState(
      'off',
      EMPTY,
      flagEnv('MERCURY_AGENT_CLASSIFIER') === '0'
        ? 'MERCURY_AGENT_CLASSIFIER=0 (opted out)'
        : 'classifier off',
      'agentStateClassifier',
    )
  }
  try {
    const rec = getAgentStateVerdict(getSessionId())
    if (!rec) {
      return withState(
        'unavailable',
        EMPTY,
        'no verdict yet this session',
        'agentStateClassifier',
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
      'agentStateClassifier',
    )
  } catch (e) {
    return withState(
      'failed',
      EMPTY,
      `agentStateSnapshot error: ${e instanceof Error ? e.message : String(e)}`,
      'agentStateClassifier',
    )
  }
}
