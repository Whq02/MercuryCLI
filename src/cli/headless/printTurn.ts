import type { RunnerPorts } from './runnerPorts.js'
import type { ConnectedMCPServer } from '../../utils/mcp/types.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { QueuedCommand } from '../../types/textInputTypes.js'
import type { RowDraft } from '../../rows/project.js'
import { minutesKnobToMs, armInactivityDeadline, holdDeadlineUntil, declaredWaitEnd, DeadlineExceededError } from '../../utils/deadline.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { withElicitationEntered } from '../../services/mcp/elicitationHandler.js'
import { mcpToolPartition, getTools, toolsWithheldByDeny, getAllBaseTools } from '../../tools.js'
import type { Tool } from '../../Tool.js'
import { isSyntheticOutputToolEnabled, createSyntheticOutputTool, SYNTHETIC_OUTPUT_TOOL_NAME } from '../../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { isHostNotice } from '../../input-core/command-queue.js'
import { spokenNotifications, foldNotifications, foldNotificationValues } from './turnDriver.js'
import { randomUUID, type UUID } from 'node:crypto'
import { fitCompletionCommands } from '../../services/agentResults/summaryRoom.js'
import { getEngineModel } from '../../services/model/model.js'
import type { BatchedPrompt } from '../../types/textInputTypes.js'
import { logForDebugging } from '../../utils/debug.js'
import type { RequestWaitV1 } from '../../services/providers/streamIdleBudget.js'
import { LOCAL_FIRST_BYTE_CAP_MS } from '../../services/providers/localLiveness.js'
import { keepTurnLiveWhileHostAnswers } from './hostAskLiveness.js'
import { runWithWorkload } from '../../utils/workloadContext.js'
import type { MCPServerConnection } from '../../utils/mcp/types.js'
import { processMainOwner } from '../../utils/run/resolveOwner.js'
import { clearToolRosterLatches, clearToolRosterRestore } from '../../services/providers/toolEconomy.js'
import { declareLawfulPrefixChange } from '../../services/providers/lawfulPrefixChange.js'
import { getSessionId } from '../../bootstrap/state.js'
import { sessionFactsOf, ask } from '../../rows/turn.js'
import { getCwd } from '../../utils/cwd.js'
import { ruleSpelling, ruleSourceWords, withheldByRuleWords } from '../../utils/permissions/ruleReason.js'
import { sessionRow, noticeRow } from '../../rows/project.js'
import { TOOL_WITHHELD_CODE } from '../../rows/vocabulary.js'
import { advisorMainRound } from '../../services/advisor/index.js'
import { mentionDropped, turnOpened } from '../../rows/read.js'
import { untoldHiddenCharacterLines } from '../../utils/text/hiddenCharacterFindings.js'
import { GLYPH } from '../../utils/glyphs.js'
import { holdQueuedWordsForTurnEnd } from '../../utils/messageQueueManager.js'
import { logError } from '../../utils/log.js'
import { SESSION_VERBS } from '../../runner/wire/sessionVerbs.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt } from '../../pi/holes.js'

const DEFAULT_HEADLESS_IDLE_MINUTES = 20

function headlessTurnIdleLimitMs(): number {
  return minutesKnobToMs(flagEnv('MERCURY_HEADLESS_IDLE_MINUTES'), DEFAULT_HEADLESS_IDLE_MINUTES)
}

export async function registerElicitationHandlersForClient(client: ConnectedMCPServer, serverName: string, ports: RunnerPorts): Promise<void> {
  return notBuilt('src/cli/headless/printTurn.ts:48')
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
  return notBuilt('src/cli/headless/printTurn.ts:122')
}
