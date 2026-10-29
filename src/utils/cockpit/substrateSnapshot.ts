import { flagEnv } from '../../substrate/flagRegistry.js'
import { isMcpPolicyActive, describeMcpPolicy } from '../../services/mcp/toolPolicy.js'
import { isMercuryServerEnabled } from '../../services/mcp/mercuryServer.js'
import { isSaturnSchedulingEnabled } from '../../tools/ScheduleCronTool/prompt.js'
import { isMercurySubstrateProfileOn } from '../config.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { truncateToWidth } from '../truncate.js'
import { agentNeedsYouEnabled } from '../../services/agentStateHeuristic.js'
import { isInvocationTraceEnabled } from '../observability/invocationTrace.js'
import { daemonSnapshot } from './daemonSnapshot.js'
import { listCapabilityKills, getAgentCapParseRejects } from '../permissions/capabilityGate.js'
import { ctxForecastEnabled } from './ctxForecast.js'
import { thisMercuryCommand } from '../../services/privateChannel/installPath.js'
import { type Snapshot } from './types.js'

export type Capability = { name: string; on: boolean; hint: string }
export type SubstrateSection = { title: string; rows: Capability[] }
export type SubstrateData = {
  sections: SubstrateSection[]
  active: number
  total: number
  substrateOn: boolean
  activeKills: string[]
}

function buildSections(): { sections: SubstrateSection[]; activeKills: string[] } {
  const substrate = isMercurySubstrateProfileOn()

  const kills = listCapabilityKills()
  const activeKills: string[] = []
  for (const [agent, tools] of Object.entries(kills)) {
    for (const tool of tools) {
      activeKills.push(agent === '*' || agent === '' ? tool : `${agent}:${tool}`)
    }
  }
  const killOn = activeKills.length > 0

  const mcpPolicyOn = isMcpPolicyActive()
  const mcpPolicyHint = describeMcpPolicy()

  const trustedRaw = (flagEnv('MERCURY_MCP_TRUSTED_SERVERS') ?? '').trim()
  const trustedHint = trustedRaw ? `always-on · trusted: ${trustedRaw}` : 'always-on'
  const agentCapPosture = flagEnv('MERCURY_AGENT_CAP')
  const agentCapRejects = agentCapPosture ? getAgentCapParseRejects() : []

  const security: SubstrateSection = {
    title: 'Security',
    rows: [
      { name: 'Capability kill-switch', on: killOn, hint: killOn ? `active: ${activeKills.join(', ')}` : 'MERCURY_KILL=Tool' },
      { name: 'MCP policy gate', on: mcpPolicyOn, hint: mcpPolicyOn ? mcpPolicyHint : 'MERCURY_MCP_MAX_RISK=low|medium' },
      { name: 'MCP trust cards', on: true, hint: trustedHint },
      { name: 'Capability manifest', on: true, hint: 'always-on · ToolSearch' },
      { name: 'In-process MCP server (mercury)', on: isMercuryServerEnabled(), hint: isMercuryServerEnabled() ? 'live (opt out =0) · the lease verbs + render_tui' : 'MERCURY_COORDINATION_MCP=0 set' },
      {
        name: 'Agent-cap posture',
        on: !!agentCapPosture,
        hint: agentCapPosture
          ? agentCapRejects.length > 0
            ? `active · ${agentCapRejects.length} unreadable part(s) FAIL CLOSED (max-risk=low): ${truncateToWidth(agentCapRejects.join(', '), 24)}`
            : `active: ${truncateToWidth(agentCapPosture, 40)}`
          : 'MERCURY_AGENT_CAP=worker:max-risk=low',
      },
      {
        name: 'Skill self-auth',
        on: !isEnvDefinedFalsy(flagEnv('MERCURY_SKILL_SELF_AUTH')),
        hint:
          !isEnvDefinedFalsy(flagEnv('MERCURY_SKILL_SELF_AUTH'))
            ? 'skill-declared allowlists merge (opt out =0)'
            : 'MERCURY_SKILL_SELF_AUTH off — skills prompt like any tool',
      },
    ],
  }


  const cronOn = isSaturnSchedulingEnabled()
  const breakerFails = (flagEnv('MERCURY_DAEMON_BREAKER_FAILS') ?? '').trim() || '5'
  const daemon = daemonSnapshot()
  const daemonLive = daemon.state === 'live'
  const autonomy: SubstrateSection = {
    title: 'Autonomy',
    rows: [
      { name: 'Saturn scheduling', on: cronOn, hint: cronOn ? 'enabled' : 'MERCURY_SATURN_DISABLE set' },
      { name: 'Scheduler daemon', on: daemonLive, hint: daemonLive ? (daemon.reason ?? 'live') : `opt-in: ${thisMercuryCommand()} daemon` },
      { name: 'Daemon circuit-breaker', on: cronOn, hint: `daemon · trips at ${breakerFails} fails` },
    ],
  }

  const traceOn = isInvocationTraceEnabled()
  const compactAdvanceOn = isEnvTruthy(flagEnv('MERCURY_CTX_COMPACTION'))
  const ctxOn = (compactAdvanceOn || substrate)
  const agentNeedsYouOn = agentNeedsYouEnabled()
  const observability: SubstrateSection = {
    title: 'Observability / perf',
    rows: [
      { name: 'Invocation trace', on: traceOn, hint: traceOn ? 'live · /trace (opt out MERCURY_SUBSTRATE=0)' : 'MERCURY_TRACE=1 · /trace' },
      {
        name: 'Compact advance + breaker',
        on: ctxOn,
        hint: compactAdvanceOn
          ? 'advance @85% + retry breaker'
          : ctxOn
            ? 'retry breaker · advance =1'
            : 'MERCURY_CTX_COMPACTION=1',
      },
      { name: 'Agent needs-you', on: agentNeedsYouOn, hint: agentNeedsYouOn ? 'live (opt out =0) · heuristic' : 'MERCURY_AGENT_NEEDS_YOU=0 set' },
      {
        name: 'ctx autocompact forecast',
        on: ctxForecastEnabled(),
        hint: ctxForecastEnabled() ? '≈N turns in the vitals rail (opt out =0)' : 'MERCURY_CTX_FORECAST=0 set',
      },
    ],
  }

  const deckPaneOn = (isEnvTruthy(flagEnv('MERCURY_DECK_PANE')) || substrate)
  const ui: SubstrateSection = {
    title: 'UI',
    rows: [
      { name: 'MercuryFrame statusbar', on: true, hint: 'always-on' },
      { name: '/trace', on: true, hint: 'always-on' },
      { name: 'Persistent deck pane', on: deckPaneOn, hint: deckPaneOn ? 'live · fullscreen (opt out MERCURY_SUBSTRATE=0)' : 'MERCURY_DECK_PANE=1 · fullscreen' },
      {
        name: 'Warm terminal background',
        on: isEnvTruthy(flagEnv('MERCURY_WARM_BG')),
        hint: flagEnv('MERCURY_WARM_BG') === '1' ? 'OSC-11 warm bg (unset to revert)' : 'MERCURY_WARM_BG=1 · OSC-11',
      },
    ],
  }

  return { sections: [security, autonomy, observability, ui], activeKills }
}

export function substrateSnapshot(): Snapshot<{ data: SubstrateData }> {
  try {
    const { sections, activeKills } = buildSections()
    const all = sections.flatMap(s => s.rows)
    return {
      state: 'live',
      source: 'the substrate gates',
      data: {
        sections,
        active: all.filter(r => r.on).length,
        total: all.length,
        substrateOn: isMercurySubstrateProfileOn(),
        activeKills,
      },
    }
  } catch {
    return {
      state: 'unavailable',
      reason: 'substrate gates unreadable',
      data: { sections: [], active: 0, total: 0, substrateOn: false, activeKills: [] },
    }
  }
}
