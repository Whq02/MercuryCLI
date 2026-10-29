import { getSessionId } from '../../bootstrap/state.js'
import { isKitMcpName, type SessionKitEditV1 } from '../../daemon/sessionKit.js'
import { daemonControlRpc } from '../../daemon/controlSocket.js'
import { MERCURY_DAEMON_PROTO } from '../../daemon/protocol.js'
import { checkHasTrustDialogAccepted, getCurrentProjectConfig } from '../../utils/config.js'
import { logForDebugging } from '../../utils/debug.js'
import { doesEnterpriseMcpConfigExist, filterMcpServersByPolicy, getMercuryMcpConfigs, getProjectMcpConfigs } from './config.js'
import { disabledMcpServerNamesIn } from './disabledRecord.js'
import { dynamicMcpConfigSnapshot, isStrictMcpConfigSeed, refreshDynamicMcpConfig, watchMcpConfigChanges } from './dynamicMcpSeed.js'
import { isMcpOrgan } from './membership.js'
import { sessionKitOf, applyProcessSessionKitEdit } from './sessionKitPin.js'
import { getProjectMcpServerStatus, recordProjectMcpServerChoices } from './utils.js'
import type { ScopedMcpServerConfig } from './types.js'

type Configs = Record<string, ScopedMcpServerConfig>
type ProjectMcpApprovalAnswer = 'allow' | 'deny' | 'unanswered'
type LivePorts = {
  hosted: boolean
  initial: Configs
  ready: () => boolean
  approve: (name: string, config: ScopedMcpServerConfig) => Promise<ProjectMcpApprovalAnswer>
  reconcile: (next: Configs, previous: Configs) => Promise<void>
}

export function watchLiveMcpConfig(ports: LivePorts): { stop: () => void; refresh: () => Promise<void>; addedAt: Map<string, number> } {
  const addedAt = new Map<string, number>()
  let previous: Configs = ports.initial
  let stopped = false
  let chain: Promise<void> = Promise.resolve()
  const refused = new Set<string>()
  const refresh = (): Promise<void> => {
    chain = chain.then(async () => {
      if (stopped || !ports.ready() || isStrictMcpConfigSeed()) return
      const kit = sessionKitOf()
      const known = new Set(kit?.mcpKnown ?? [...(kit?.mcp ?? []), ...disabledMcpServerNamesIn(getCurrentProjectConfig())])
      if (checkHasTrustDialogAccepted() && !doesEnterpriseMcpConfigExist()) {
        const project = filterMcpServersByPolicy(getProjectMcpConfigs().servers).allowed
        for (const [name, config] of Object.entries(project)) {
          if (refused.has(name) || getProjectMcpServerStatus(name, config) !== 'pending') continue
          if (known.has(name) && previous[name]?.scope === 'project' && JSON.stringify(previous[name]) === JSON.stringify(config)) continue
          const answer = await ports.approve(name, config)
          if (stopped) return
          if (answer === 'allow') recordProjectMcpServerChoices({ approved: [{ name, config }] })
          else if (answer === 'deny') recordProjectMcpServerChoices({ rejected: [name] })
          if (answer !== 'allow') refused.add(name)
        }
      }
      const dynamic = dynamicMcpConfigSnapshot() ?? {}
      const { servers } = await getMercuryMcpConfigs(dynamic)
      const { allowed } = filterMcpServersByPolicy({ ...servers, ...dynamic })
      const next = Object.fromEntries(Object.entries(allowed).filter(([name, config]) => config.scope !== 'project' || !refused.has(name)))
      const names = Object.keys(next).filter(name => isKitMcpName(name) && !isMcpOrgan(name))
      const members = new Set(kit?.mcp ?? [])
      const born = names.filter(name => !known.has(name))
      const gone = [...known].filter(name => !names.includes(name))
      const edit: SessionKitEditV1 = {
        mcpKnown: names,
        mcp: [...born.map(name => ({ name, on: true })), ...gone.filter(name => members.has(name)).map(name => ({ name, on: false }))],
      }
      if (born.length > 0 || gone.length > 0 || kit?.mcpKnown === undefined) {
        if (ports.hosted) {
          const reply = await daemonControlRpc({ op: 'sessionControl', proto: MERCURY_DAEMON_PROTO, action: 'set-kit', sessionId: String(getSessionId()), by: 'mcp-config', kitEdit: edit, clientOpId: `mcp-config-${crypto.randomUUID()}` }, { timeoutMs: 15_000 })
          if (!reply.ok) throw new Error(reply.error)
          if (reply.op !== 'sessionControl' || reply.outcome === 'refused') throw new Error(reply.op === 'sessionControl' ? reply.detail : 'the MCP configuration dial refused')
        } else {
          const reply = applyProcessSessionKitEdit(edit, disabledMcpServerNamesIn(getCurrentProjectConfig()))
          if (reply.outcome === 'refused') throw new Error(reply.detail)
        }
        for (const name of born) addedAt.set(name, Date.now())
      }
      if (stopped) return
      await ports.reconcile(next, previous)
      previous = next
      refreshDynamicMcpConfig()
    }).catch(error => logForDebugging(`mcp live configuration: ${String(error)}`))
    return chain
  }
  const unsubscribe = watchMcpConfigChanges(() => { void refresh() })
  void refresh()
  return { addedAt, refresh, stop: () => { stopped = true; unsubscribe() } }
}
