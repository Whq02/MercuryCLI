import { flagEnv } from '../../substrate/flagRegistry.js'
import { chatOnlyBoot } from '../../context/surfaceRoute.js'
import { isCoordinationServerEnabled } from '../../services/mcp/coordinationServer.js'
import { isMcpPolicyActive, describeMcpPolicy } from '../../services/mcp/toolPolicy.js'
import { isSaturnSchedulingEnabled } from '../../tools/ScheduleCronTool/prompt.js'
import { isAgentSwarmsEnabled } from '../agentSwarmsEnabled.js'
import { isMercurySubstrateProfileOn } from '../config.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { truncateToWidth } from '../truncate.js'
import { agentStateClassifierEnabled } from '../../services/agentStateHeuristic.js'
import { isInvocationTraceEnabled } from '../observability/invocationTrace.js'
import { daemonSnapshot } from './daemonSnapshot.js'
import { listCapabilityKills, getAgentCapParseRejects } from '../permissions/capabilityGate.js'
import { NEVER_HAIKU_FALLBACK, recentFloorEvents } from '../model/modelFloor.js'
import { ctxForecastEnabled } from './ctxForecast.js'
import { carryForwardEnabled } from '../../daemon/carryForward.js'
import { evolutionLedgerEnabled } from '../evolution/evolutionLedger.js'
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
  const swarms = isAgentSwarmsEnabled()

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
  const trustedHint = trustedRaw ? `always-on (fork) · trusted: ${trustedRaw}` : 'always-on (fork)'
  const agentCapPosture = flagEnv('MERCURY_AGENT_CAP')
  const agentCapRejects = agentCapPosture ? getAgentCapParseRejects() : []

  const security: SubstrateSection = {
    title: 'Security',
    rows: [
      { name: 'Capability kill-switch', on: killOn, hint: killOn ? `active: ${activeKills.join(', ')}` : 'MERCURY_KILL=Tool' },
      { name: 'MCP policy gate', on: mcpPolicyOn, hint: mcpPolicyOn ? mcpPolicyHint : 'MERCURY_MCP_MAX_RISK=low|medium' },
      { name: 'MCP trust cards', on: true, hint: trustedHint },
      { name: 'Capability manifest', on: true, hint: 'always-on (fork) · ToolSearch' },
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
      {
        name: 'Delegated-model floor',
        on: true,
        hint: (() => {
          const fired = recentFloorEvents()
          const last = fired[fired.length - 1]
          return last
            ? truncateToWidth(
                `fired ×${fired.length} · last: ${last.origin} '${last.blocked}' → ${last.fallback}`,
                46,
              )
            :
              `agents: never Haiku → ${NEVER_HAIKU_FALLBACK.replace(/^claude-/, '')}`
        })(),
      },
    ],
  }

  const teamHint = 'in a team'
  const coordination: SubstrateSection = {
    title: 'Coordination',
    rows: [
      { name: 'File leases + lease-guard', on: swarms, hint: teamHint },
      { name: 'TeamBrief', on: swarms, hint: teamHint },
      { name: 'SendMessage governance', on: swarms, hint: teamHint },
      { name: 'LaunchFleet', on: swarms, hint: teamHint },
      { name: 'Coordination MCP server (mercury)', on: isCoordinationServerEnabled(), hint: isCoordinationServerEnabled() ? 'live (opt out =0) · mcp__mercury__* coord verbs' : 'MERCURY_COORDINATION_MCP=0 set' },
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
      { name: 'Scheduler daemon', on: daemonLive, hint: daemonLive ? (daemon.reason ?? 'live') : 'opt-in: mercury daemon' },
      { name: 'Daemon circuit-breaker', on: cronOn, hint: `daemon · trips at ${breakerFails} fails` },
      {
        name: 'Carry-forward handoff',
        on: carryForwardEnabled(),
        hint: carryForwardEnabled() ? 'auto-clear seeds a handoff note (opt out =0)' : 'MERCURY_CARRY_FORWARD=0 set',
      },
      {
        name: 'Evolution ledger',
        on: evolutionLedgerEnabled(),
        hint: evolutionLedgerEnabled() ? 'program rows → .mercury/evolution/ (opt out =0)' : 'MERCURY_EVOLUTION_LEDGER=0 set',
      },
    ],
  }

  const traceOn = isInvocationTraceEnabled()
  const compactAdvanceOn = isEnvTruthy(flagEnv('MERCURY_CTX_COMPACTION'))
  const ctxOn = (compactAdvanceOn || substrate)
  const agentClassifierOn = agentStateClassifierEnabled()
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
      { name: 'Agent-state classifier', on: agentClassifierOn, hint: agentClassifierOn ? 'live (opt out =0) · heuristic' : 'MERCURY_AGENT_CLASSIFIER=0 set' },
      {
        name: 'ctx autocompact forecast',
        on: ctxForecastEnabled(),
        hint: ctxForecastEnabled() ? '≈N turns in the telemetry rail (opt out =0)' : 'MERCURY_CTX_FORECAST=0 set',
      },
    ],
  }

  const deckPaneOn = (isEnvTruthy(flagEnv('MERCURY_DECK_PANE')) || substrate)
  const ui: SubstrateSection = {
    title: 'UI',
    rows: [
      { name: 'MercuryFrame statusbar', on: true, hint: 'always-on (fork)' },
      chatOnlyBoot()
        ? { name: '/trace', on: true, hint: 'always-on (fork) · /deck and /fleet are off in this boot — the concourse is off' }
        : { name: '/deck · /trace · /fleet', on: true, hint: 'always-on (fork)' },
      { name: 'Persistent deck pane', on: deckPaneOn, hint: deckPaneOn ? 'live · fullscreen (opt out MERCURY_SUBSTRATE=0)' : 'MERCURY_DECK_PANE=1 · fullscreen' },
      {
        name: 'Warm terminal background',
        on: isEnvTruthy(flagEnv('MERCURY_WARM_BG')),
        hint: flagEnv('MERCURY_WARM_BG') === '1' ? 'OSC-11 warm bg (unset to revert)' : 'MERCURY_WARM_BG=1 · OSC-11',
      },
      {
        name: 'Relevance recall (cards)',
        on: flagEnv('MERCURY_RELEVANT_RECALL') === '1',
        hint: flagEnv('MERCURY_RELEVANT_RECALL') === '1' ? 'ranked card recall on' : 'MERCURY_RELEVANT_RECALL=1 · /cards',
      },
    ],
  }

  return { sections: [security, coordination, autonomy, observability, ui], activeKills }
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
