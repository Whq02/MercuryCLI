import type { FileCheckpointsFact, ResultOf } from '../../runner/wire/methods.js'
import type { SESSION_VERBS } from '../../runner/wire/sessionVerbs.js'
import { fileHistoryEnabled, fileCheckpointSource } from '../../services/changeTransaction/fileHistory.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { sleep } from '../../utils/sleep.js'
import { anthropicWindowFact, anthropicObservedUsage } from '../../services/anthropicLimits.js'
import { openaiWindowFact } from '../../services/providers/openai/openaiWindowFact.js'
import { laneWindowFact } from '../../services/providers/laneWindowFact.js'
import { openaiCatalogueFact } from '../../services/providers/openai/openaiCatalogue.js'
import { type SessionFactsAnswerV1, effortSentOf } from '../../services/engine-connector/seatProjections.js'
import { getEngineModel } from '../../services/model/model.js'
import { getEngineModelOverride, getTotalCostUSD, getTotalAPIDuration, getTotalDuration, getTotalLinesAdded, getTotalLinesRemoved, getTotalInputTokens, getTotalOutputTokens, getTotalCacheReadInputTokens, getTotalCacheCreationInputTokens, hasUnknownModelCost, getTotalUnpricedTurns, getOriginalCwd, getProjectRoot, getSessionId } from '../../bootstrap/state.js'
import { sessionModelSpendRows } from '../../services/engine-connector/modelSpendFacts.js'
import { contextFillView } from '../../services/context/contextFill.js'
import { providerLimitWarning } from '../../services/providers/limitWarning.js'
import { openaiObservedUsage } from '../../services/providers/openai/openaiLimitState.js'
import { jevFactsOf } from '../../services/jev/jevSessionFacts.js'
import { jevLedgerSnapshot } from '../../services/jev/jevLedger.js'
import { jevStatus } from '../../services/jev/jevStatus.js'
import { is1PApiCustomer } from '../../utils/auth.js'
import { hasConsoleBillingAccess, hasClaudeAiBillingAccess } from '../../utils/billing.js'
import { anthropicSignInEmail } from '../../services/providers/providerUsage.js'
import { skillsRosterOf, mcpRosterEntriesOf } from '../../services/engine-connector/rosterTerms.js'
import { offSkillNamesOf } from '../../skills/kitGovernance.js'
import { sessionKitOf } from '../../services/mcp/sessionKitPin.js'
import { resolveEffortTruth } from '../../utils/effort.js'
import { spawnSwitchFacts } from '../../services/switchboard/spawnSwitches.js'
import { boxReading } from '../../utils/boxLock.js'
import { getCwd } from '../../utils/cwd.js'
import { getCommandQueue } from '../../utils/messageQueueManager.js'
import { projectWorkRoster } from '../../services/engine-connector/workRoster.js'
import { operatorPauseGate } from '../../run-core/pauseGate.js'
import { advisorFacts } from '../../services/advisor/index.js'
import { swarmSessionEnabled, swarmView } from '../../services/crewBoard/seam.js'
import { editOutcomeRows } from '../../services/changeTransaction/editOutcomeLedger.js'
import { processMainOwner } from '../../utils/run/resolveOwner.js'
import { noticeRows } from '../../services/notices/unreadLedger.js'
import { listSessionMission } from '../../utils/tasks.js'
import { sampleRowsOf } from '../../services/samples/facts.js'
import { takePendingScheduleEdits, markScheduleSeatObserved } from '../../services/saturn/sessionScheduleBridge.js'
import { streamIdleTimeoutMsForRoute } from '../../services/providers/streamIdleBudget.js'
import { providerFamilyOfSetting } from '../../services/model/modelTransition.js'
import { runningBuildTree } from '../../utils/artifactIdentity.js'
import { transcriptStoreHealth } from '../../utils/sessionStorage/writer.js'
import { sessionFactsToWire } from '../../services/engine-connector/seatWire.js'
import type { RunnerPorts } from './runnerPorts.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt } from '../../pi/holes.js'

const lastPublishedMission = new WeakMap<RunnerPorts['live'], SessionFactsAnswerV1['mission']>()

function missionLedgerOf(metadata: Record<string, unknown> | undefined): string | undefined {
  const ledger = metadata?.ledger
  if (typeof ledger === 'string' && ledger.trim() !== '') return ledger.trim()
  const mission = metadata?.missionId
  if (typeof mission === 'string' && mission.trim() !== '') return mission.trim()
  return undefined
}

export function fileCheckpointsFact(): FileCheckpointsFact {
  return { capture: fileHistoryEnabled(), source: fileCheckpointSource() }
}

export async function answerSessionFacts(ports: RunnerPorts): Promise<ResultOf<typeof SESSION_VERBS.sessionFacts.runner.name>> {
  return notBuilt('src/cli/headless/sessionFactsArm.ts:63')
}
