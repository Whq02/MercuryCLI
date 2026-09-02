// ============================================================================
//  compact/maintenanceLadder — the typed method ladder over Mercury's OWN
//  maintenance methods (spec 07-C1): digest → notes → handoff → summary.
//
//  Each rung answers { applied } or { advanced: typedReason } — a method
//  that cannot reclaim enough to clear the recovery band advances instead
//  of looping (the no-op-advance law). The ladder NEVER restructures the
//  methods it walks:
//    · digest — the time-based clearing pass. The request-context plan
//      applies it on EVERY request before the compaction gate runs, so at
//      threshold time its savings are already in the token count: the rung
//      MEASURES the standing projection and advances with the measured
//      reason (it never double-applies).
//    · notes — SessionMemory-backed reduction (trySessionMemoryCompact-
//      ion). Its no-failure-handler contract stays untouched: the rung
//      reads the method's own null/result answer, nothing more (§B5).
//    · handoff — cache-aligned handoff-as-compaction (spec 07-C2). Not
//      built in this lane: the rung advances typed, so landing C2 is a
//      drop-in runner, not a ladder rewrite. Overflow ALWAYS advances past
//      it (the same-oversized-input law).
//    · summary — full autocompact with the verbatim tail (compact-
//      Conversation), the recovery of last resort.
//
//  Overflow entries reach the ladder only after capFailover promotion was
//  consulted by the api recovery layer (the promotion-first law lives
//  there; the ladder records the skip it implies).
//
//  Gate: MERCURY_COMPACT_LADDER (opt-in; autoCompactIfNeeded consults it).
// ============================================================================
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { logForDebugging } from '../../utils/debug.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { compactConversation, type CompactionResult, type RecompactionInfo } from './compact.js'
import { projectTimeBasedMicrocompact } from './microCompact.js'
import { trySessionMemoryCompaction } from './sessionMemoryCompact.js'

export type MaintenanceMethod = 'digest' | 'notes' | 'handoff' | 'summary'

export const DEFAULT_LADDER_ORDER: readonly MaintenanceMethod[] = [
  'digest',
  'notes',
  'handoff',
  'summary',
]

export type RungVerdict =
  | { method: MaintenanceMethod; outcome: 'applied' }
  | { method: MaintenanceMethod; outcome: 'advanced'; reason: string }

export type LadderOutcome =
  | { outcome: 'applied'; method: MaintenanceMethod; result: CompactionResult; steps: RungVerdict[] }
  | { outcome: 'exhausted'; steps: RungVerdict[] }

export interface LadderInput {
  messages: Message[]
  toolUseContext: ToolUseContext
  cacheSafeParams: CacheSafeParams
  querySource?: string
  recompactionInfo: RecompactionInfo
  /** Context-overflow recovery entry: handoff is skipped by law. */
  overflow?: boolean
  /** The band a rung must clear to count as applied (tokens). */
  recoveryBandTokens?: number
}

/** Injectable rung runners — hermetic provers replace them; production
 *  callers pass nothing. */
export interface LadderRunners {
  digestProjection?: typeof projectTimeBasedMicrocompact
  notes?: typeof trySessionMemoryCompaction
  /** The C2 handoff runner. Absent (this lane) ⇒ typed advance. */
  handoff?: (input: LadderInput) => Promise<CompactionResult | null>
  summary?: typeof compactConversation
}

export function isMaintenanceLadderEnabled(): boolean {
  return isEnvTruthy(flagEnv('MERCURY_COMPACT_LADDER'))
}

export async function runMaintenanceLadder(
  input: LadderInput,
  order: readonly MaintenanceMethod[] = DEFAULT_LADDER_ORDER,
  runners: LadderRunners = {},
): Promise<LadderOutcome> {
  const steps: RungVerdict[] = []
  const advance = (method: MaintenanceMethod, reason: string): void => {
    steps.push({ method, outcome: 'advanced', reason })
  }

  for (const method of order) {
    switch (method) {
      case 'digest': {
        // Measured, never re-applied: the request plan already ran the
        // clearing pass this turn, so its savings are in the count.
        const projection = (runners.digestProjection ?? projectTimeBasedMicrocompact)(
          input.messages,
          input.querySource,
        )
        if (projection === null) {
          advance('digest', 'digest: the standing clearing pass has nothing left to clear')
        } else {
          const band = input.recoveryBandTokens ?? Number.POSITIVE_INFINITY
          advance(
            'digest',
            `digest: the standing pass reclaims ~${projection.tokensSaved} tokens upstream` +
              (projection.tokensSaved >= band
                ? ' (already applied by the request plan — the count reflects it)'
                : ` — below the ${band === Number.POSITIVE_INFINITY ? 'recovery' : band}-token band`),
          )
        }
        break
      }
      case 'notes': {
        const result = await (runners.notes ?? trySessionMemoryCompaction)(
          input.messages,
          input.toolUseContext.agentId,
          input.recompactionInfo.autoCompactThreshold,
        )
        if (result !== null) {
          steps.push({ method, outcome: 'applied' })
          return { outcome: 'applied', method, result, steps }
        }
        advance('notes', 'notes: session-memory compaction unavailable (no memory yet, gate off, or below its own floor)')
        break
      }
      case 'handoff': {
        if (input.overflow === true) {
          advance('handoff', 'handoff: skipped on overflow — the request would carry the same oversized input')
          break
        }
        const runner = runners.handoff
        if (runner === undefined) {
          advance('handoff', 'handoff: method not built in this lane (spec 07-C2 pending) — a drop-in runner slots here')
          break
        }
        const result = await runner(input)
        if (result !== null) {
          steps.push({ method, outcome: 'applied' })
          return { outcome: 'applied', method, result, steps }
        }
        advance('handoff', 'handoff: the generator refused (low-signal or cancelled)')
        break
      }
      case 'summary': {
        const result = await (runners.summary ?? compactConversation)(
          input.messages,
          input.toolUseContext,
          input.cacheSafeParams,
          true,
          undefined,
          true,
          input.recompactionInfo,
        )
        steps.push({ method, outcome: 'applied' })
        return { outcome: 'applied', method, result, steps }
      }
    }
  }

  logForDebugging(
    `maintenance ladder exhausted without applying: ${steps
      .map(s => (s.outcome === 'advanced' ? `${s.method}✗` : `${s.method}✓`))
      .join(' → ')}`,
    { level: 'warn' },
  )
  return { outcome: 'exhausted', steps }
}
