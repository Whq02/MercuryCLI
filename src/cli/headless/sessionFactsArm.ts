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
  const { checkBuildBehind, getAppState, live, liveMcp, mcpSignIns, messages, missionGuard } = ports
  if (live.claimSettling !== null) await live.claimSettling
  void checkBuildBehind()
  if (!live.sessionFactsHoldSpent) {
    live.sessionFactsHoldSpent = true
    const holdMs = Number.parseInt(flagEnv('MERCURY_SESSION_FACTS_HOLD_MS') ?? '', 10)
    if (Number.isFinite(holdMs) && holdMs > 0) live.sessionFactsHold = sleep(holdMs)
  }
  if (live.sessionFactsHold !== null) await live.sessionFactsHold
  const state = getAppState()
  const anthropicWindow = anthropicWindowFact()
  const anthropicObserved = anthropicObservedUsage()
  const openaiWindow = openaiWindowFact()
  const geminiWindow = laneWindowFact('gemini')
  const openrouterWindow = laneWindowFact('openrouter')
  const huggingfaceWindow = laneWindowFact('huggingface')
  const openaiCatalogue = openaiCatalogueFact()
  const factsNow = Date.now()
  const answer: SessionFactsAnswerV1 = {
    model: {
      effective: live.activeModel ?? getEngineModel(),
      setting: getEngineModelOverride() ?? null,
    },
    ...(live.bootRefusalFact !== null ? { bootRefusal: live.bootRefusalFact } : {}),
    usage: {
      totalCostUSD: getTotalCostUSD(),
      totalAPIDurationMs: getTotalAPIDuration(),
      totalDurationMs: getTotalDuration(),
      totalLinesAdded: getTotalLinesAdded(),
      totalLinesRemoved: getTotalLinesRemoved(),
      totalInputTokens: getTotalInputTokens(),
      totalOutputTokens: getTotalOutputTokens(),
      totalCacheReadInputTokens: getTotalCacheReadInputTokens(),
      totalCacheCreationInputTokens: getTotalCacheCreationInputTokens(),
      hasUnknownModelCost: hasUnknownModelCost(),
      unpricedTurns: getTotalUnpricedTurns(),
      modelSpend: sessionModelSpendRows(),
      context: { model: live.activeModel ?? getEngineModel(), ...contextFillView(live.turnMessages?.() ?? messages, live.activeModel ?? getEngineModel()) },
      limitWarning: providerLimitWarning({ model: live.activeModel ?? getEngineModel() }),
      ...(() => {
        const observed = openaiObservedUsage()
        return observed.primary || observed.secondary ? { openaiObserved: observed } : {}
      })(),
      ...(anthropicWindow !== undefined ? { anthropicWindow } : {}),
      ...(anthropicObserved !== undefined ? { anthropicObserved } : {}),
      ...(openaiWindow !== undefined ? { openaiWindow } : {}),
      ...(geminiWindow !== undefined ? { geminiWindow } : {}),
      ...(openrouterWindow !== undefined ? { openrouterWindow } : {}),
      ...(huggingfaceWindow !== undefined ? { huggingfaceWindow } : {}),
      jev: jevFactsOf(jevLedgerSnapshot(factsNow), jevStatus(undefined, factsNow)),
    },
    identity: {
      firstPartyApi: is1PApiCustomer(),
      consoleBilling: hasConsoleBillingAccess(),
      claudeAiBilling: hasClaudeAiBillingAccess(),
      accountEmail: anthropicSignInEmail() ?? null,
    },
    skills: skillsRosterOf(live.activeCommands, offSkillNamesOf(sessionKitOf(), live.activeCommands.map(c => c.name))),
    mcp: mcpRosterEntriesOf(state.mcp.clients, []).map(row => ({
      ...row,
      toolCount: state.mcp.tools.filter(tool => tool.mcpInfo?.serverName === row.name).length,
      ...(liveMcp.addedAt.has(row.name) ? { addedAt: liveMcp.addedAt.get(row.name) } : {}),
      ...(mcpSignIns.has(row.name) ? { signingIn: true, authorizationUrl: mcpSignIns.get(row.name)?.authorizationUrl } : {}),
    })),
    permissionMode: state.toolPermissionContext.mode,
    ...((): { effortSent?: string | null } => {
      const sent = effortSentOf(resolveEffortTruth(live.activeModel ?? getEngineModel(), state.effortValue))
      return sent === undefined ? {} : { effortSent: sent }
    })(),
    spawnSwitches: spawnSwitchFacts(),
    box: boxReading(),
    ...(openaiCatalogue !== undefined ? { openaiCatalogue } : {}),
    workspace: {
      cwd: getCwd(),
      originalCwd: getOriginalCwd(),
      projectRoot: getProjectRoot(),
    },
    recoveredCommandIds: live.recoveredCommandIds,
    queue: getCommandQueue().filter(command => command.agentId === undefined).map(command => ({
      ...(command.uuid !== undefined ? { uuid: String(command.uuid) } : {}),
      value:
        typeof command.value === 'string'
          ? command.value
          : Array.isArray(command.value)
            ? command.value
                .map(block => ((block as { type?: string; text?: string }).type === 'text' ? ((block as { text?: string }).text ?? '') : ''))
                .join('')
            : '',
      mode: command.mode,
      ...(command.origin !== undefined ? { origin: command.origin } : {}),
      ...(command.priority !== undefined ? { priority: command.priority } : {}),
      ...(command.isMeta === true ? { isMeta: true as const } : {}),
    })),
    work: projectWorkRoster(state.tasks),
    pauseGate: { paused: operatorPauseGate.paused(), parked: operatorPauseGate.parked().length },
    advisor: advisorFacts(),
    ...(swarmSessionEnabled() ? { swarm: swarmView() } : {}),
    editOutcomes: editOutcomeRows(processMainOwner()),
    notices: noticeRows(),
    mission: await (async (): Promise<SessionFactsAnswerV1['mission']> => {
      try {
        const listed = (await listSessionMission()).map(task => ({
          id: task.id,
          subject: task.subject.slice(0, 120),
          ...(task.activeForm !== undefined ? { activeForm: task.activeForm.slice(0, 120) } : {}),
          status: task.status,
          ...(task.blocks.length > 0 ? { blocks: task.blocks } : {}),
          ...(task.blockedBy.length > 0 ? { blockedBy: task.blockedBy } : {}),
          ...(missionLedgerOf(task.metadata) !== undefined ? { ledger: missionLedgerOf(task.metadata) } : {}),
        }))
        lastPublishedMission.set(live, listed)
        return listed
      } catch (error) {
        passedOver(error)
        return lastPublishedMission.get(live) ?? []
      }
    })(),
    samples: await sampleRowsOf(getSessionId()),
    ...((): { missionCard?: SessionFactsAnswerV1['missionCard'] } => {
      const card = missionGuard.missionCardView(String(getSessionId()))
      return card === null ? {} : { missionCard: card }
    })(),
    ...(sessionKitOf() !== undefined ? { kit: sessionKitOf() } : {}),
    ...((): Record<string, unknown> => {
      const edits = takePendingScheduleEdits()
      return edits.length > 0 ? { pendingScheduleEdits: edits } : {}
    })(),
    streamIdleTimeoutMs: streamIdleTimeoutMsForRoute(providerFamilyOfSetting(live.activeModel ?? getEngineModel())),
    buildTree: runningBuildTree(),
    ...(transcriptStoreHealth().failing ? { transcriptStoreFailing: transcriptStoreHealth().sentence ?? '' } : {}),
    fileCheckpoints: {
      ...fileCheckpointsFact(),
      restorable: state.fileHistory.snapshots.map(snapshot => String(snapshot.messageId)),
      files: [...state.fileHistory.trackedFiles].sort(),
      ...(state.fileHistory.rewindUndo === undefined ? {} : { undo: state.fileHistory.rewindUndo.messageId }),
    },
  }
  markScheduleSeatObserved()
  return sessionFactsToWire(answer) as Record<string, unknown>
}
