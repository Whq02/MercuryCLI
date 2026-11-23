import { EMPTY_USAGE } from '../../request-parts/emptyUsage.js'
import { accumulateUsage } from '../../../models/roads/anthropic/cacheAndUsage.js'
import { wardFiringsOf } from '../../../permissions/guards/wardsGuard.js'
import { isClaudeAISubscriber } from '../../../models/sign-in/credentials/auth.js'
import { getModelUsage } from '../../../boot/process-state/processState.js'
import { ledgerSpentSince, usageSince } from './ledgerMark.js'
import { noteRunPhase } from '../../../platform/logs/runPhases.js'
import { modelUsageRows, type OutcomeFacts, type RowScope } from '../project.js'
import type { OutcomeStatus, RecoveryKind } from '../vocabulary.js'
import type { StepLedger } from './steps.js'
import { costUnknownIn } from './close.js'
import type { ConversationState } from './state.js'

interface OutcomeFactsNeeds {
  ledgerAtStart: Parameters<typeof ledgerSpentSince>[0]
  modelUsageAtStart: Parameters<typeof usageSince>[1]
  turnId: string
  capturedStopReason: string | null
  steps: StepLedger
  turnStartedAt: number
  recoveries: Array<{ kind: RecoveryKind }>
  denialsBefore: number
  notices: Array<{ level: 'warning' | 'error'; text: string }>
  scope: RowScope
}

export function outcomeFacts(this: ConversationState, facts: OutcomeFactsNeeds, status: OutcomeStatus, extra: Partial<OutcomeFacts>): OutcomeFacts {
  const { ledgerAtStart, modelUsageAtStart, turnId, capturedStopReason, steps, turnStartedAt, recoveries, denialsBefore, notices, scope } = facts
  for (const [messageId, usage] of this.settledUsageById) {
    if (this.streamFoldedIds.has(messageId)) continue
    this.streamFoldedIds.add(messageId)
    if (usage.input_tokens === 0 && usage.output_tokens === 0) continue
    this.accumulatedUsage = accumulateUsage(this.accumulatedUsage, usage)
  }
  noteRunPhase('settlement')
  const spent = ledgerSpentSince(ledgerAtStart)
  const unpricedModels = new Set(Object.keys(spent.unpricedTurns))
  const apiMs = spent.apiDuration
  const billed = usageSince(getModelUsage(), modelUsageAtStart)
  const subscriber = isClaudeAISubscriber()
  const hasUnknownCost = costUnknownIn(spent.unpricedTurns, subscriber)
  const pricedModels = Object.keys(billed).filter(model => !hasUnknownCost(model))
  const costUsd = subscriber ? pricedModels.reduce((sum, model) => sum + Math.max(0, billed[model]?.costUSD ?? 0), 0) : spent.costUSD
  const costKnown = subscriber ? pricedModels.length > 0 : unpricedModels.size === 0 || costUsd > 0
  const usage = Object.values(billed).reduce((sum, row) => ({
    ...sum,
    input_tokens: sum.input_tokens + row.inputTokens,
    output_tokens: sum.output_tokens + row.outputTokens,
    cache_read_input_tokens: sum.cache_read_input_tokens + row.cacheReadInputTokens,
    cache_creation_input_tokens: sum.cache_creation_input_tokens + row.cacheCreationInputTokens,
  }), { ...EMPTY_USAGE, output_tokens_details: this.accumulatedUsage.output_tokens_details })
  return {
    turnId,
    status,
    stopReason: capturedStopReason,
    steps: steps.count,
    wallMs: Date.now() - turnStartedAt,
    ...(apiMs > 0 ? { apiMs } : {}),
    ...(costKnown ? { costUsd } : {}),
    ...(recoveries.length > 0 ? { recoveries: [...recoveries] } : {}),
    usage,
    models: modelUsageRows(billed, hasUnknownCost),
    denials: this.denials.slice(denialsBefore),
    ...(notices.length > 0 ? { notices: [...notices] } : {}),
    wards: wardFiringsOf(scope.session_id),
    ...extra,
  }
}
