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
  overflow?: boolean
  recoveryBandTokens?: number
}

export interface LadderRunners {
  digestProjection?: typeof projectTimeBasedMicrocompact
  notes?: typeof trySessionMemoryCompaction
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
