// ============================================================================
//  src/query/config.ts — the immutable per-run configuration, snapshotted
//  ONCE at query entry. Deliberately separate from per-iteration state and
//  the mutable tool-use context so a future pure reducer can take
//  (state, event, config). Compile-time feature gates are deliberately
//  EXCLUDED — they are tree-shaking boundaries and stay inline at the
//  blocks they guard.
// ============================================================================
import { getSessionId } from '../bootstrap/state.js'

export type QueryConfig = {
  sessionId: string
  gates: {
    /** Always false — the emission is
     *  unreachable until a registered flag arms it. */
    emitToolUseSummaries: boolean
    /** Internal-user flag — always false in this build. */
    isAnt: boolean
  }
}

export function buildQueryConfig(): QueryConfig {
  return {
    sessionId: String(getSessionId()),
    gates: {
      emitToolUseSummaries: false,
      isAnt: false,
    },
  }
}
