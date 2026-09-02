// ============================================================================
//  src/bootstrap/runtime/api-capture.ts — the API-capture family owner
//
//
//  Scope: CONVERSATION — the last-API-request capture for /share and bug
//  reports, the prompt/request correlation ids, and the post-compaction
//  one-shot. promptId is additionally nulled by the facade's resetCostState
//  (the /clear + login scope boundary — see state.ts).
//
//  BOOTSTRAP-ISOLATION LEAF (the same custom-rules/bootstrap-isolation
//  convention state.ts carries): this module imports ONLY types. No
//  src/utils value imports. src/bootstrap/state.ts is the ONLY sanctioned
//  importer; every consumer goes through the frozen facade.
// ============================================================================
import type { ApiRequestParams } from '../../types/wire.js'

export class ApiCaptureOwner {
  // The most recent API request minus its messages — /share and bug reports
  // read it for params/headers truth.
  lastAPIRequest: Omit<ApiRequestParams, 'messages'> | null = null
  // The message array of that request — held by REFERENCE, never cloned.
  // /share's serialized_conversation.json must show the EXACT post-
  // compaction, instructions-injected set that went to the API; a defensive
  // clone would break that reality pin and double memory on huge contexts
  // (a recorded risk).
  lastAPIRequestMessages: ApiRequestParams['messages'] | null = null
  // The auto-mode classifier's recent request(s), for the /share transcript.
  lastClassifierRequests: unknown[] | null = null
  // Instruction-file content, parked here by context.ts for the auto-mode
  // classifier — the parking spot breaks the yoloClassifier →
  // instruction-engine → filesystem → permissions import cycle.
  cachedInstructionPrompt: string | null = null
  // Correlation id (UUID) tying the current user prompt to the telemetry
  // events its turn produces. Nulled by resetCostState (see the header).
  promptId: string | null = null
  // requestId of the last successful MAIN-chain API response (subagents
  // excluded). Shutdown reads it to send the cache-eviction hint upstream.
  lastMainRequestId: string | undefined = undefined
  // Date.now() at the last successful API completion — the idle-gap input
  // for telling a TTL-expired cache miss (~5min TTL) from a busted one.
  lastApiCompletionTimestamp: number | null = null
  // Armed by compaction (auto or /compact); the next API success consumes it
  // to tag itself post-compaction, separating compaction-induced cache
  // misses from TTL expiry in the logs.
  pendingPostCompaction = false

  /** Arm the one-shot: compaction just ran. */
  markPostCompaction(): void {
    this.pendingPostCompaction = true
  }

  /** Fire the one-shot: true exactly once per compaction, false after. */
  consumePostCompaction(): boolean {
    const was = this.pendingPostCompaction
    this.pendingPostCompaction = false
    return was
  }
}
