import type { RunnerPorts } from './runnerPorts.js'
import type { ConnectedMCPServer } from '../../integrations/mcp-shapes/mcpServerRecords.js'
import type { AppState } from '../../screen/app-state/AppStateStore.js'
import type { QueuedCommand } from '../../screen/composer/input-core/textInput.js'
import type { RowDraft } from '../../engine/rows/project.js'
import { minutesKnobToMs, armInactivityDeadline, holdDeadlineUntil, declaredWaitEnd, DeadlineExceededError } from '../../platform/async/deadline.js'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { withElicitationEntered } from '../../integrations/mcp/elicitationHandler.js'
import { mcpToolPartition, getTools, toolsWithheldByDeny, getAllBaseTools } from '../../tools/kit/toolList.js'
import type { Tool } from '../../tools/kit/tool.js'
import { isSyntheticOutputToolEnabled, createSyntheticOutputTool, SYNTHETIC_OUTPUT_TOOL_NAME } from '../../tools/structured-output/SyntheticOutputTool.js'
import { isHostNotice } from '../../screen/composer/input-core/command-queue.js'
import { spokenNotifications, foldNotifications, foldNotificationValues } from './turnDriver.js'
import { randomUUID, type UUID } from 'node:crypto'
import { fitCompletionCommands } from '../../crew/agent-results/summaryRoom.js'
import { getEngineModel } from '../../models/catalogue/engineModel.js'
import type { BatchedPrompt } from '../../screen/composer/input-core/textInput.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import type { RequestWaitV1 } from '../../models/roads/streamIdleBudget.js'
import { LOCAL_FIRST_BYTE_CAP_MS } from '../../models/roads/localLiveness.js'
import { keepTurnLiveWhileHostAnswers } from './hostAskLiveness.js'
import { runWithWorkload } from '../../models/roads/workloadContext.js'
import type { MCPServerConnection } from '../../integrations/mcp-shapes/mcpServerRecords.js'
import { processMainOwner } from '../../engine/run-owner/resolveOwner.js'
import { clearToolRosterLatches, clearToolRosterRestore } from '../../models/roads/toolEconomy.js'
import { declareLawfulPrefixChange } from '../../models/roads/lawfulPrefixChange.js'
import { getSessionId } from '../../boot/process-state/processState.js'
import { sessionFactsOf, ask } from '../../engine/rows/turn.js'
import { getCwd } from '../../platform/files/cwd.js'
import { ruleSpelling, ruleSourceWords, withheldByRuleWords } from '../../permissions/rules/ruleReason.js'
import { sessionRow, noticeRow } from '../../engine/rows/project.js'
import { TOOL_WITHHELD_CODE } from '../../engine/rows/vocabulary.js'
import { advisorMainRound } from '../../models/advisor/index.js'
import { mentionDropped, turnOpened } from '../../engine/rows/read.js'
import { untoldHiddenCharacterLines } from '../../platform/text/hiddenCharacterFindings.js'
import { GLYPH } from '../../screen/theme/glyphs.js'
import { holdQueuedWordsForTurnEnd } from './messageQueueManager.js'
import { logError } from '../../platform/logs/errorLog.js'
import { SESSION_VERBS } from '../runner-wire/sessionVerbs.js'
import { passedOver } from '../../platform/errors/passedOver.js'

const DEFAULT_HEADLESS_IDLE_MINUTES = 20

function headlessTurnIdleLimitMs(): number {
  return minutesKnobToMs(flagEnv('MERCURY_HEADLESS_IDLE_MINUTES'), DEFAULT_HEADLESS_IDLE_MINUTES)
}

export async function registerElicitationHandlersForClient(client: ConnectedMCPServer, serverName: string, ports: RunnerPorts): Promise<void> {
  const { asks, io } = ports
  client.client.setRequestHandler('elicitation/create', async (request, ctx) => {
    return withElicitationEntered(client.client, () => {
      const params = request.params
      if (params.mode === 'url') {
        return asks.handleElicitation(
          serverName,
          params.message,
          undefined,
          ctx.mcpReq.signal,
          'url',
          params.url,
          params.elicitationId,
        )
      }
      return asks.handleElicitation(
        serverName,
        params.message,
        params.requestedSchema,
        ctx.mcpReq.signal,
        'form',
        undefined,
        undefined,
      )
    })
  })
  client.client.setNotificationHandler('notifications/elicitation/complete', notification => {
    io.outbound.enqueue({
      method: SESSION_VERBS.elicitationComplete.runner.name,
      params: {
        server: serverName,
        elicitation_id: notification.params.elicitationId,
      },
    })
  })
}

export function registerPerTurnHandlers(clients: MCPServerConnection[], ports: RunnerPorts): void {
  const { elicitationRegistered, registerElicitationHandlersForClient } = ports
  for (const client of clients) {
    if (client.type !== 'connected') continue
    if (elicitationRegistered.has(client.name)) continue
    elicitationRegistered.add(client.name)
    const failed = (error: unknown): void => {
      elicitationRegistered.delete(client.name)
      logError(error)
      passedOver(error)
    }
    try {
      void Promise.resolve(registerElicitationHandlersForClient(client, client.name)).catch(failed)
    } catch (error) {
      failed(error)
    }
  }
}

export function assembleTurnTools(state: AppState, turnSchema: Record<string, unknown> | undefined, ports: RunnerPorts): Tool[] {
  const { answerSchemaOf, baseToolNames, sessionTools } = ports
  const mcpPartition = mcpToolPartition(state.mcp.tools as Tool[], state.toolPermissionContext)
  const pool: Tool[] = [
    ...getTools(state.toolPermissionContext),
    ...sessionTools.filter(tool => !baseToolNames.has(tool.name) && !tool.isMcp),
    ...mcpPartition,
  ]
  const seen = new Set<string>()
  const deduped: Tool[] = []
  for (const tool of pool) {
    if (seen.has(tool.name)) continue
    seen.add(tool.name)
    deduped.push(tool)
  }
  const answerSchema = answerSchemaOf(turnSchema)
  if (answerSchema === undefined || !isSyntheticOutputToolEnabled({ isNonInteractiveSession: true })) return deduped
  const synthetic = createSyntheticOutputTool(answerSchema)
  if (!('tool' in synthetic)) return deduped
  const at = deduped.findIndex(tool => tool.name === SYNTHETIC_OUTPUT_TOOL_NAME)
  if (at === -1) return [...deduped, synthetic.tool]
  if (deduped[at] === synthetic.tool) return deduped
  return deduped.map((tool, index) => (index === at ? synthetic.tool : tool))
}

export async function runPrintTurn(command: QueuedCommand, batch: QueuedCommand[], onMessage: (message: RowDraft) => void, given: QueuedCommand[] | undefined, ports: RunnerPorts): Promise<void> {
  let initialNotices = given ?? []
  const { advisorRoad, answerSchemaOf, applySeatEffort, applySeatModel, asks, assembleTools, canUseTool, checkBuildBehind, emitCommandNotifications, enqueueRow, getAppState, getReadFileCache, injectModelSwitchBreadcrumbs, inputPrompt, io, landAdvisorQuiet, landSpawnSwitch, live, liveScope, localCommandInput, maxTime, messages, options, party, peer, promisedWaitOf, recordHostNoticeRows, recordNoticeRows, registerPerTurnHandlers, setAppState, setReadFileCache, statusIsProgress, statusRowOf, swarmLead, swarmResumes, tellFailedMcpServers, tellSkippedProjectMcpServers } = ports
  const { applyLiveBootMenuEnv } = await import('../../platform/substrate/startupMenu.js')
  applyLiveBootMenuEnv()
  const members = batch.length > 0 ? batch : [command]
  live.turnReachedModel = false
  if (members.some(isHostNotice) || initialNotices.some(isHostNotice)) {
    const hostNotices = [...initialNotices, ...members].filter(isHostNotice)
    emitCommandNotifications(hostNotices)
    await recordHostNoticeRows(hostNotices)
    initialNotices = initialNotices.filter(member => !isHostNotice(member))
  }
  const heard = members.filter(member => !isHostNotice(member))
  if (heard.length === 0) return
  const spoken = spokenNotifications(heard)
  if (spoken.length < heard.length) await recordNoticeRows(heard.filter(member => !spoken.includes(member)), { isMeta: true })
  if (spoken.length < members.length) {
    batch = spoken.length > 1 ? spoken : []
    command = foldNotifications(spoken)
  }
  live.turnReachedModel = true
  const promptUuid = command.uuid ?? randomUUID()
  const localCommand = localCommandInput(command)
  const modeNotice = localCommand ? null : ports.takeModeNotice()
  if (modeNotice !== null) initialNotices = [...initialNotices, modeNotice]
  live.turnAnchor = localCommand ? null : promptUuid
  if (localCommand) party.blockOpen()
  const delivery = command.mode === 'task-notification' ? fitCompletionCommands(batch.length > 0 ? batch : [command], { messages, model: live.activeModel ?? getEngineModel() }) : []
  const promptValue = delivery.length > 1 ? foldNotificationValues(delivery.map(member => member.value)) : delivery[0]?.value ?? command.value
  const batchUuids = batch.map(member => member.uuid).filter((uuid): uuid is UUID => uuid !== undefined)
  const batchTail: BatchedPrompt[] =
    command.mode === 'prompt'
      ? batch.slice(1).map(member => ({
          value: member.value,
          ...(member.uuid !== undefined ? { uuid: member.uuid } : {}),
          ...(member.origin !== undefined ? { origin: member.origin } : {}),
        }))
      : []
  emitCommandNotifications([...initialNotices, command])
  const turnAbort = new AbortController()
  live.inFlightAbort = turnAbort
  live.turnsRun += 1
  live.currentTurn = live.turnsRun
  live.currentTurnId = null
  const turnIdleLimitMs = headlessTurnIdleLimitMs()
  const turnWatchdog = armInactivityDeadline({
    seam: 'unattended turn',
    limitMs: turnIdleLimitMs,
    advice: 'the turn was aborted and the run exits non-zero; MERCURY_HEADLESS_IDLE_MINUTES tunes the limit (0 disables)',
    onExpire: error => {
      logForDebugging(`print: ${error.message}`)
      turnAbort.abort(error)
    },
  })
  let promiseHold: { cancel(): void } | null = null
  const holdPromise = (wait: Extract<RequestWaitV1, { kind: 'first-byte' }> | null): void => {
    promiseHold?.cancel()
    promiseHold = wait === null || !turnWatchdog.armed ? null : holdDeadlineUntil(turnWatchdog, declaredWaitEnd(wait.sinceMs, wait.budgetMs, LOCAL_FIRST_BYTE_CAP_MS), turnIdleLimitMs / 2)
  }
  live.hostAsks = keepTurnLiveWhileHostAnswers({
    watchdog: turnWatchdog,
    limitMs: turnIdleLimitMs,
    parkedWithHost: () => asks.pendingControlRequestCount(),
    parkedAsks: () => asks.parkedAsks(),
    settleParkedAsks: cause => (live.capabilities.holds_asks ? 0 : asks.denyPendingPermissionRequests(cause)),
  })
  const workload = command.workload ?? options.workload
  try {
    await runWithWorkload(workload, async () => {
      const state = getAppState()
      const turnClients: MCPServerConnection[] = [
        ...state.mcp.clients,
      ]
      registerPerTurnHandlers(turnClients)
      const answerSchema = answerSchemaOf(command.schema)
      const answerSchemaKey = answerSchema === undefined ? '' : JSON.stringify(answerSchema)
      if (live.lastAnswerSchemaKey !== null && answerSchemaKey !== live.lastAnswerSchemaKey) {
        const owner = String(processMainOwner())
        clearToolRosterLatches(owner)
        clearToolRosterRestore()
        declareLawfulPrefixChange(owner, answerSchema === undefined ? 'this turn asked for no structured output' : 'this turn asked for its own structured-output schema')
      }
      live.lastAnswerSchemaKey = answerSchemaKey
      const assembledTools = assembleTools(state, command.schema)
      const mcpCommands = state.mcp.commands
      const dedupedCommands = [
        ...live.activeCommands,
        ...mcpCommands.filter(
          mcpCommand => !live.activeCommands.some(existing => existing.name === mcpCommand.name),
        ),
      ]
      if (live.sessionRowFor !== String(getSessionId())) {
        live.sessionRowFor = String(getSessionId())
        const withheld = toolsWithheldByDeny([...getAllBaseTools(), ...state.mcp.tools], state.toolPermissionContext)
        const facts = await sessionFactsOf(
          { cwd: getCwd(), tools: assembledTools, mcpClients: turnClients, commands: dedupedCommands, agents: live.activeAgents },
          live.activeModel ?? getEngineModel(),
          state.toolPermissionContext.mode,
          live.resumeOf,
          withheld.map(({ tool, rule }) => ({ tool, rule: ruleSpelling(rule.ruleValue), source: ruleSourceWords(rule.source) })),
        )
        enqueueRow(sessionRow({ session_id: getSessionId() }, facts))
        for (const entry of withheld) enqueueRow(noticeRow(liveScope(), 'warning', withheldByRuleWords(entry.tool, entry.rule), TOOL_WITHHELD_CODE))
      }
      tellSkippedProjectMcpServers()
      tellFailedMcpServers()
      for await (const message of ask({
        commands: dedupedCommands,
        prompt: promptValue,
        ...(options.syntaxInput !== undefined && command.value === inputPrompt ? { syntaxInput: options.syntaxInput } : {}),
        promptUuid,
        ...(batchUuids.length > 0 ? { batchUuids } : {}),
        ...(batchTail.length > 0 ? { batchTail } : {}),
        ...(initialNotices.length > 0 ? { initialNotices } : {}),
        isMeta: command.isMeta,
        operatorPrompt: command.mode === 'prompt' && command.isMeta !== true,
        ...(command.origin !== undefined ? { origin: command.origin } : {}),
        ...(command.skipSlashCommands === true ? { skipSlashCommands: true } : {}),
        ...(command.mode === 'bash' ? { promptMode: 'bash' as const } : {}),
        cwd: getCwd(),
        tools: assembledTools,
        mcpClients: turnClients,
        thinkingConfig: live.thinkingConfig,
        maxTurns: options.maxTurns,
        maxBudgetUsd: options.maxBudgetUsd,
        maxTime,
        canUseTool,
        ...(peer !== null ? { hostHoldsAsks: true } : {}),
        userSpecifiedModel: live.activeModel,
        fallbackModel: options.fallbackModel,
        jsonSchema: answerSchema,
        mutableMessages: messages,
        onTurnMessages: read => {
          live.turnMessages = read
        },
        contentReplacementState: live.contentReplacementState,
        getReadFileCache,
        setReadFileCache,
        customSystemPrompt: options.systemPrompt,
        appendSystemPrompt: options.appendSystemPrompt,
        getAppState,
        setAppState,
        abortController: turnAbort,
        partialRows: options.includePartialMessages || live.capabilities.partial_rows,
        turn: live.currentTurn ?? undefined,
        onLiveness: () => turnWatchdog.touch(),
        onToolRoundSettled: rows => {
          void advisorMainRound(String(getSessionId()), rows, advisorRoad)
        },
        handleElicitation: (
          serverName: string,
          params: { message: string; mode?: 'form' | 'url'; url?: string; elicitationId?: string },
          elicitSignal?: AbortSignal,
        ) =>
          asks.handleElicitation(
            serverName,
            params.message,
            undefined,
            elicitSignal,
            params.mode,
            params.url,
            params.elicitationId,
          ),
        agents: live.activeAgents,
        setSDKStatus: (status: unknown) => {
          if (statusIsProgress(status)) turnWatchdog.touch()
          const promised = promisedWaitOf(status)
          if (promised !== undefined) holdPromise(promised)
          else if (typeof status === 'object' && status !== null && 'streamActivity' in status) holdPromise(null)
          const row = statusRowOf(status)
          if (row !== null) enqueueRow(row)
        },
      })) {
        turnWatchdog.touch()
        if (turnOpened(message)) {
          live.currentTurnId = message.turn_id
          if (options.door !== 'wire') for (const line of untoldHiddenCharacterLines()) process.stderr.write(`${GLYPH.warn} ${line}\n`)
        }
        if (options.door !== 'wire' && mentionDropped(message)) process.stderr.write(`${GLYPH.warn} ${message.text}\n`)
        onMessage(message)
      }
      tellFailedMcpServers()
    })
  } finally {
    party.turnEnd()
    live.turnAnchor = null
    live.hostAsks?.stop()
    live.hostAsks = null
    holdPromise(null)
    turnWatchdog.cancel()
    live.inFlightAbort = null
    live.currentTurn = null
    if (live.heldSeatModel !== null) {
      const held = live.heldSeatModel
      live.heldSeatModel = null
      await applySeatModel(held.model, held.words, held.replacedDefault)
      io.outbound.enqueue({ method: SESSION_VERBS.sessionApplied.runner.name, params: { request_id: held.requestId, verb: 'set_model', model: held.model } })
    }
    if (live.heldSeatEffort !== null) {
      const held = live.heldSeatEffort
      live.heldSeatEffort = null
      applySeatEffort(held.effort)
      io.outbound.enqueue({ method: SESSION_VERBS.sessionApplied.runner.name, params: { request_id: held.requestId, verb: 'set_effort', effort: held.effort } })
    }
    holdQueuedWordsForTurnEnd(false)
    if (live.deferredModelBreadcrumb !== null) {
      const crumb = live.deferredModelBreadcrumb
      live.deferredModelBreadcrumb = null
      await injectModelSwitchBreadcrumbs(crumb.to, crumb.from)
    }
    if (live.deferredSpawnSwitches.length > 0) {
      const toggles = live.deferredSpawnSwitches
      live.deferredSpawnSwitches = []
      for (const toggle of toggles) {
        landSpawnSwitch(toggle.kind, toggle.on)
        io.outbound.enqueue({ method: SESSION_VERBS.sessionApplied.runner.name, params: { request_id: toggle.requestId, verb: 'set_spawn_switch', switch: toggle.kind, on: toggle.on } })
      }
    }
    if (live.deferredAdvisorQuiet.length > 0) {
      const quiets = live.deferredAdvisorQuiet
      live.deferredAdvisorQuiet = []
      for (const quiet of quiets) landAdvisorQuiet(quiet)
    }
    swarmLead.check()
    swarmResumes.check()
    void checkBuildBehind(true)
  }
  if (turnWatchdog.fired) {
    throw new DeadlineExceededError('unattended turn', turnIdleLimitMs, turnIdleLimitMs, turnWatchdog.progressCount, 'no engine event for the whole limit — the turn was aborted; MERCURY_HEADLESS_IDLE_MINUTES tunes the limit (0 disables)')
  }
}
