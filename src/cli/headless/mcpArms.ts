import { isMcpCatalogueMember } from '../../services/mcp/membership.js'
import { noticeRow } from '../../rows/project.js'
import { performMCPOAuthFlow } from '../../services/mcp/auth.js'
import { errorMessage } from '../../utils/errors.js'
import type { ParamsOf, ResultOf } from '../../runner/wire/methods.js'
import type { SESSION_VERBS } from '../../runner/wire/sessionVerbs.js'
import type { RunnerPorts } from './runnerPorts.js'
import { mcpToolsUnlistedAnswer, mcpToolsAnswerOf } from '../../services/mcp/toolsAnswer.js'
import { getEngineModel } from '../../services/model/model.js'
import { heldToolsAtLastPlan } from '../../services/providers/toolEconomy.js'
import { processMainOwner } from '../../utils/run/resolveOwner.js'
import { filterToolsByServer } from '../../services/mcp/utils.js'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import { withoutMcpToolCardHeader } from '../../utils/mcp/toolCard.js'
import { isDeferredToolFor } from '../../tools/ToolSearchTool/prompt.js'
import { validateSessionKit } from '../../daemon/sessionKit.js'
import { sessionKitFromWire } from '../../services/engine-connector/seatWire.js'
import { refused } from '../../runner/wire/errors.js'
import { sessionKitOf, setProcessSessionKit, completeProcessSessionKit } from '../../services/mcp/sessionKitPin.js'
import { kitEditMcpDelta, kitDialCandidates, dropMcpServerFromAppState } from '../../services/mcp/kitDial.js'
import { clearServerCache, connectToServer } from '../../services/mcp/client.js'
import { clearCommandMemoizationCaches, getCommands } from '../../commands.js'
import { getCwd } from '../../utils/cwd.js'
import { pruneSkillSessionHooks, liveSkillRootsOf } from '../../utils/hooks/sessionHooks.js'
import { getSessionId } from '../../bootstrap/state.js'
import { passedOver, passedOverAs } from '../../utils/passedOver.js'
import { notBuilt } from '../../pi/holes.js'

export async function mcpAction(params: ParamsOf<typeof SESSION_VERBS.mcpAction.runner.name>, signal: AbortSignal, ports: RunnerPorts): Promise<ResultOf<typeof SESSION_VERBS.mcpAction.runner.name>> {
  const { enqueueRow, liveScope, mcpSignIns, permittedMcpConfig, reconnectLiveMcp, serializeMcpChange } = ports
  const { name, action } = params
  if (action === 'cancel-auth') {
    mcpSignIns.get(name)?.controller.abort()
    return { outcome: 'applied' as const }
  }
  const config = await permittedMcpConfig(name)
  if (!config || !isMcpCatalogueMember(name)) return { outcome: 'refused' as const, detail: 'the server is off, unapproved, denied by policy, or no longer configured' }
  if (action === 'authenticate' && config.type !== 'http' && config.type !== 'sse') return { outcome: 'refused' as const, detail: 'this server does not use browser sign-in' }
  if (mcpSignIns.has(name)) return { outcome: 'refused' as const, detail: 'sign-in is already in progress' }
  const controller = new AbortController()
  const cancel = (): void => controller.abort(signal.reason)
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (action === 'authenticate') {
      const flow: { controller: AbortController; authorizationUrl?: string } = { controller }
      mcpSignIns.set(name, flow)
      enqueueRow(noticeRow(liveScope(), 'warning', `Signing in to ${name} (browser)`))
      await performMCPOAuthFlow(name, config, url => {
        flow.authorizationUrl = url
        enqueueRow(noticeRow(liveScope(), 'warning', `Sign-in ready for ${name} (browser)`))
      }, controller.signal)
    }
    const stillAllowed = await permittedMcpConfig(name)
    if (controller.signal.aborted || !stillAllowed || JSON.stringify(stillAllowed) !== JSON.stringify(config) || !isMcpCatalogueMember(name)) return { outcome: 'refused' as const, detail: 'the server configuration or permission changed during sign-in' }
    const client = await serializeMcpChange(() => reconnectLiveMcp(name, config))
    return client.type === 'connected'
      ? { outcome: 'applied' as const, detail: `${name} connected` }
      : { outcome: 'refused' as const, detail: client.type === 'failed' ? client.error ?? 'connection failed' : `${name} needs sign-in` }
  } catch (error) {
    return { outcome: 'refused' as const, detail: errorMessage(error) }
  } finally {
    signal.removeEventListener('abort', cancel)
    mcpSignIns.delete(name)
  }
}

export async function mcpTools(params: ParamsOf<typeof SESSION_VERBS.mcpTools.runner.name>, ports: RunnerPorts): Promise<ResultOf<typeof SESSION_VERBS.mcpTools.runner.name>> {
  return notBuilt('src/cli/headless/mcpArms.ts:66')
}

export function setSessionKit(params: ParamsOf<typeof SESSION_VERBS.setKit.runner.name>, ports: RunnerPorts): Promise<ResultOf<typeof SESSION_VERBS.setKit.runner.name>> {
  return notBuilt('src/cli/headless/mcpArms.ts:102')
}
