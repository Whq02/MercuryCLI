// ============================================================================
//  agentStateSnapshot — content-derived "what is this agent doing / does it
//  need me" signal, from the per-turn agent-state classifier.
//
//  Complements the process/session-state derivations (sessionOutcome,
//  attentionDerive — those read the SDK session-state union
//  idle/running/requires_action); this reads the latest *assistant text* and
//  classifies it into {working|blocked|done|failed} + tempo, so a deck/fleet/
//  MercuryFrame surface can show a needs-attention dot a process signal can't see
//  (e.g. "the agent ended its turn with a question").
//
//  Honest-state envelope: 'off' when the classifier is disabled (opted out with
//  MERCURY_AGENT_CLASSIFIER=0 — it is LIVE by default for the
//  fork), 'unavailable' when enabled but no verdict yet this session, 'live' once
//  a verdict exists. Never throws.
// ============================================================================

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
  /** True when the agent's last turn needs the user (blocked or failed). */
  needsAttention: boolean
  /** Age of the verdict in ms (null when none). */
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
