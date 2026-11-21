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
  const { getAppState, live, messages } = ports
  const { name } = params
  const state = getAppState()
  const client = state.mcp.clients.find(entry => entry.name === name)
  if (client?.type !== 'connected') return mcpToolsUnlistedAnswer(name, client)
  const model = live.activeModel ?? getEngineModel()
  const held = new Set(heldToolsAtLastPlan(String(processMainOwner()), messages))
  const tools = await Promise.all(
    filterToolsByServer(state.mcp.tools, name).map(async tool => {
      const carded = await tool
        .description(
          {},
          {
            isNonInteractiveSession: true,
            toolPermissionContext: getEmptyToolPermissionContext(),
            tools: [],
          },
        )
        .catch(passedOverAs(''))
      return {
        name: tool.mcpInfo?.toolName ?? tool.name,
        registeredAs: tool.name,
        description: withoutMcpToolCardHeader(name, carded, { openWorldHint: tool.isOpenWorld?.() === true }).trim(),
        inputSchema: (tool.inputJSONSchema as Record<string, unknown> | undefined) ?? {},
        loading: held.has(tool.name)
          ? ('held' as const)
          : isDeferredToolFor(tool, model, state.toolPermissionContext.mode, messages)
            ? ('deferred' as const)
            : ('listed' as const),
      }
    }),
  )
  return mcpToolsAnswerOf(name, tools)
}

export function setSessionKit(params: ParamsOf<typeof SESSION_VERBS.setKit.runner.name>, ports: RunnerPorts): Promise<ResultOf<typeof SESSION_VERBS.setKit.runner.name>> {
  const { applyReconnectedClient, elicitationRegistered, getAppState, live, permittedMcpConfig, registerPerTurnHandlers, resolveServerConfigFromAllSources, serializeMcpChange, setAppState } = ports
  return serializeMcpChange(async () => {
    const verdict = validateSessionKit(sessionKitFromWire(params.kit))
    if (!verdict.ok) throw refused(`kit refused — ${verdict.reason}`, 'kit')
    const before = sessionKitOf()
    const set = setProcessSessionKit(verdict.kit)
    if (!set.ok) throw refused(`kit refused — ${set.reason}`, 'kit')
    const rows = getAppState().mcp.clients
    const delta = kitEditMcpDelta(
      before,
      set.kit,
      kitDialCandidates(before, set.kit, rows.map(row => row.name)),
    )
    const connected: string[] = []
    const disconnected: string[] = []
    const errors: Record<string, string> = Object.create(null) as Record<string, string>
    for (const name of delta.disconnect) {
      const config =
        rows.find(row => row.name === name)?.config ?? resolveServerConfigFromAllSources(name)
      if (!config) continue
      const existing = getAppState().mcp.clients.find(row => row.name === name)
      if (existing?.type === 'connected') {
        await clearServerCache(name, config).catch(passedOver)
      }
      elicitationRegistered.delete(name)
      setAppState(previous => dropMcpServerFromAppState(previous, name, config))
      disconnected.push(name)
    }
    for (const name of delta.connect) {
      const config = await permittedMcpConfig(name)
      if (!config) {
        errors[name] = 'no configuration found for this server'
        continue
      }
      try {
        const client = await connectToServer(name, config)
        await applyReconnectedClient(name, client)
        if (client.type === 'connected') {
          registerPerTurnHandlers([client])
          connected.push(name)
        } else if (client.type === 'failed') {
          errors[name] = client.error ?? 'connection failed'
        } else {
          errors[name] = `server is ${client.type}`
        }
      } catch (error) {
        errors[name] = errorMessage(error)
      }
    }
    clearCommandMemoizationCaches()
    live.activeCommands = await getCommands(getCwd())
    pruneSkillSessionHooks(setAppState, getSessionId(), liveSkillRootsOf(live.activeCommands))
    if (sessionKitOf()?.resolved === false) {
      const { completeSessionKitFromRoster } = await import('../../services/mcp/kitCompletion.js')
      const { getActiveSet } = await import('../../extensions/active.js')
      completeProcessSessionKit(
        completeSessionKitFromRoster(sessionKitOf()!, {
          mcpNames: getAppState().mcp.clients.map(row => row.name),
          commands: live.activeCommands,
          extensions: getActiveSet().active.map(ext => ext.manifest.name),
        }),
      )
    }
    return { applied: true as const, connected, disconnected, errors }
  })
}
