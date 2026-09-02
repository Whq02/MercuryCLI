#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-coordination-server.ts
//  PROOF: the coordination server — the in-process coordination MCP
//  (lease_claim/release/list, brief, coord_say) that ships DEFAULT-ON for the
//  fork yet had ZERO committed coverage. Every sibling substrate primitive has a
//  prove-*; this closes the gap and pins the four behaviors the work-items fix:
//    - all 5 tools register (tools/list over the REAL linked transport)
//    - SOLO (no team): every verb is a benign no-op, NOT a tool error — the
//      lease/coord verbs return {ok:false, reason:'NOT_IN_TEAM'} and brief
//      returns a clean {teamName:null} (consistent solo behavior)
//    - IN-TEAM: lease_claim/list/release + coord_say (DM + broadcast) round-trip
//    - coord_say stamps the sender color on every write (DM AND broadcast)
//    - coord_say's broadcast is governed exactly like SendMessage's: the 13a
//      lead-enable gate (broadcastEnabled=false ⇒ non-leads denied, lead allowed)
//      and the 13b turn-fairness gate (a repeat broadcaster yields while others
//      are active). Default governance ⇒ broadcasts allowed for everyone.
//
//  It drives the server the SAME way production does (client.ts:911-930): build
//  it with createCoordinationServer(), connect over createLinkedTransportPair(),
//  and call it as a real MCP Client — no private-field poking, no stubs.
//  MERCURY_COORDINATION_MCP=1 (the registry-primary spelling; default-on either
//  way) + a throwaway config home keep IO honest+isolated. The earlier
//  '-hermes' MACRO.VERSION probe is retired — the version-stamp gate died,
//  isCoordinationServerEnabled reads only the registry flag.
// ============================================================================

process.env.MERCURY_COORDINATION_MCP = '1'
;(globalThis as { MACRO?: { VERSION: string } }).MACRO = {
  VERSION: '0.0.0-proof',
}

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Throwaway teams home so leases/inboxes/turn-state are real IO but isolated.
const tmpHome = mkdtempSync(join(tmpdir(), 'mercury-coordination-'))
const prevConfigDir = process.env.MERCURY_CONFIG_DIR
process.env.MERCURY_CONFIG_DIR = tmpHome

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createCoordinationServer } from '../../src/services/mcp/coordinationServer.js'
import { createLinkedTransportPair } from '../../src/services/mcp/InProcessTransport.js'
import {
  setDynamicTeamContext,
  clearDynamicTeamContext,
} from '../../src/utils/teammate.js'
import {
  writeTeamFileAsync,
  type TeamFile,
} from '../../src/utils/swarm/teamHelpers.js'
import { readMailbox } from '../../src/utils/teammateMailbox.js'
import { getTeamsDir } from '../../src/utils/envUtils.js'
import { sanitizePathComponent } from '../../src/utils/tasks.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(
    `  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`,
  )
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

/** Connect a fresh client to a fresh in-process server (the production seam). */
async function connect(): Promise<import('@modelcontextprotocol/sdk/client/index.js').Client> {
  const server = await createCoordinationServer()
  const [clientTransport, serverTransport] = createLinkedTransportPair()
  await server.connect(serverTransport)
  const client = new Client(
    { name: 'coordination-proof', version: '0' },
    { capabilities: {} },
  )
  await client.connect(clientTransport)
  return client
}
function jsonOf(r: { content?: Array<{ text?: string }> }): {
  ok?: boolean
  reason?: string
  teamName?: string | null
  recipients?: string[]
  broadcast?: boolean
} {
  try {
    return JSON.parse(r.content?.[0]?.text ?? '{}')
  } catch {
    return {}
  }
}
function isError(r: { isError?: boolean }): boolean {
  return r.isError === true
}
function textOf(r: { content?: Array<{ text?: string }> }): string {
  return r.content?.[0]?.text ?? ''
}

function teamWith(
  name: string,
  governance: TeamFile['governance'],
): TeamFile {
  return {
    name,
    createdAt: Date.now(),
    leadAgentId: `lead@${name}`,
    governance,
    members: [
      {
        agentId: `lead@${name}`,
        name: 'team-lead',
        joinedAt: Date.now(),
        tmuxPaneId: '',
        cwd: tmpHome,
        subscriptions: [],
      },
      {
        agentId: `w@${name}`,
        name: 'worker',
        joinedAt: Date.now(),
        tmuxPaneId: '',
        cwd: tmpHome,
        subscriptions: [],
      },
      {
        agentId: `b@${name}`,
        name: 'bob',
        joinedAt: Date.now(),
        tmuxPaneId: '',
        cwd: tmpHome,
        subscriptions: [],
      },
    ],
  }
}

console.log('============================================================')
console.log(' the coordination server (coordination) — proof')
console.log('============================================================')

try {
  // ── registration ──────────────────────────────────────────────────────────
  section('all tools register (tools/list): 5 coordination verbs + render_tui')
  {
    const client = await connect()
    const names = (await client.listTools()).tools.map(t => t.name).sort()
    check(
      'registers exactly the 5 coordination verbs + render_tui',
      names.join(',') ===
        'brief,coord_say,lease_claim,lease_list,lease_release,render_tui',
      names.join(','),
    )
  }

  // ── SOLO: benign no-ops, not tool errors (work-item 6) ─────────────────────
  section('SOLO (no team): every verb is a benign no-op, NOT a tool error')
  clearDynamicTeamContext()
  {
    const client = await connect()
    for (const name of ['lease_claim', 'lease_release', 'lease_list']) {
      const args = name === 'lease_claim' ? { globs: ['src/**'] } : {}
      const r = await client.callTool({ name, arguments: args })
      check(
        `${name} solo is not a tool error (isError !== true)`,
        !isError(r),
      )
      check(
        `${name} solo returns {ok:false, reason:'NOT_IN_TEAM'}`,
        jsonOf(r).ok === false && jsonOf(r).reason === 'NOT_IN_TEAM',
      )
    }
    const say = await client.callTool({
      name: 'coord_say',
      arguments: { to: '*', message: 'hi' },
    })
    check('coord_say solo is not a tool error', !isError(say))
    check(
      "coord_say solo returns {ok:false, reason:'NOT_IN_TEAM'}",
      jsonOf(say).ok === false && jsonOf(say).reason === 'NOT_IN_TEAM',
    )
    const brief = await client.callTool({ name: 'brief', arguments: {} })
    check('brief solo is not a tool error (already benign)', !isError(brief))
    check('brief solo returns teamName:null', jsonOf(brief).teamName === null)
  }

  // ── IN-TEAM: leases + coord_say round-trip, default governance ─────────────
  section('IN-TEAM: leases + coord_say round-trip (default governance)')
  const TEAM = 'mcp-proof'
  await writeTeamFileAsync(TEAM, teamWith(TEAM, undefined))
  // A non-lead worker WITH an assigned color — proves color propagation and the
  // permissive default (a non-lead may broadcast when no governance is set).
  setDynamicTeamContext({
    agentId: `w@${TEAM}`,
    agentName: 'worker',
    teamName: TEAM,
    color: 'blue',
    planModeRequired: false,
  })
  {
    const client = await connect()
    const claim = await client.callTool({
      name: 'lease_claim',
      arguments: { globs: ['src/api/**'] },
    })
    check('lease_claim in-team succeeds', jsonOf(claim).ok === true)
    const list = await client.callTool({ name: 'lease_list', arguments: {} })
    check(
      'lease_list shows the claimed glob',
      textOf(list).includes('src/api/**'),
    )
    const dm = await client.callTool({
      name: 'coord_say',
      arguments: { to: 'bob', message: 'ping', summary: 'a ping' },
    })
    check('coord_say DM succeeds', jsonOf(dm).ok === true)
    const bc = await client.callTool({
      name: 'coord_say',
      arguments: { to: '*', message: 'all hands' },
    })
    check(
      'coord_say broadcast (default gov) allowed for a non-lead',
      jsonOf(bc).ok === true && (jsonOf(bc).recipients?.length ?? 0) === 2,
    )
    const rel = await client.callTool({ name: 'lease_release', arguments: {} })
    check('lease_release reports the drop', jsonOf(rel).ok === true)
  }

  // ── coord_say stamps the sender color (work-item 2) ────────────────────────
  section("coord_say stamps the sender's color on every write (DM + broadcast)")
  {
    // worker (color:blue) wrote one DM + one broadcast to bob above.
    const inbox = await readMailbox('bob', TEAM)
    check('bob received the DM + the broadcast', inbox.length === 2)
    check(
      'every message carries the sender color (blue) — no dropped band',
      inbox.length === 2 && inbox.every(m => m.color === 'blue'),
    )
  }

  // ── 13a lead-enable gate (work-item 1) ─────────────────────────────────────
  section('broadcast governance 13a: broadcastEnabled=false gates non-leads')
  await writeTeamFileAsync(
    TEAM,
    teamWith(TEAM, { broadcastEnabled: false }),
  )
  {
    // non-lead worker is DENIED.
    setDynamicTeamContext({
      agentId: `w@${TEAM}`,
      agentName: 'worker',
      teamName: TEAM,
      color: 'blue',
      planModeRequired: false,
    })
    const denied = await (await connect()).callTool({
      name: 'coord_say',
      arguments: { to: '*', message: 'x' },
    })
    check(
      'non-lead broadcast is REFUSED when broadcastEnabled=false',
      isError(denied) && /disabled for non-leads/.test(textOf(denied)),
    )
  }
  {
    // the lead is still ALLOWED.
    setDynamicTeamContext({
      agentId: `lead@${TEAM}`,
      agentName: 'team-lead',
      teamName: TEAM,
      color: 'red',
      planModeRequired: false,
    })
    const ok = await (await connect()).callTool({
      name: 'coord_say',
      arguments: { to: '*', message: 'x' },
    })
    check(
      'the lead may still broadcast when non-leads are gated',
      !isError(ok) && jsonOf(ok).ok === true,
    )
  }

  // ── 13b turn-fairness gate (work-item 1) ───────────────────────────────────
  section('broadcast governance 13b: a repeat broadcaster yields while others active')
  await writeTeamFileAsync(
    TEAM,
    teamWith(TEAM, {
      broadcastFairness: { repostCooldownMs: 60_000, activeWindowMs: 600_000 },
    }),
  )
  {
    // Seed turn-state so 'worker' spoke last AND 'bob' is also recently active.
    const turnsDir = join(getTeamsDir(), sanitizePathComponent(TEAM))
    mkdirSync(turnsDir, { recursive: true })
    const recent = new Date(Date.now() - 1_000).toISOString()
    writeFileSync(
      join(turnsDir, 'broadcast-turns.json'),
      JSON.stringify({
        lastSpeaker: { actor: 'worker', ts: recent },
        lastSpokeAt: { worker: recent, bob: recent },
      }),
    )
    setDynamicTeamContext({
      agentId: `w@${TEAM}`,
      agentName: 'worker',
      teamName: TEAM,
      color: 'blue',
      planModeRequired: false,
    })
    const yielded = await (await connect()).callTool({
      name: 'coord_say',
      arguments: { to: '*', message: 'again' },
    })
    check(
      'a back-to-back broadcaster is told to yield the turn (fairness)',
      isError(yielded) && /yield the turn/.test(textOf(yielded)),
    )
  }
} finally {
  clearDynamicTeamContext()
  if (prevConfigDir === undefined) delete process.env.MERCURY_CONFIG_DIR
  else process.env.MERCURY_CONFIG_DIR = prevConfigDir
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL COORDINATION-SERVER PROOFS PASS')
else console.log(`❌ ${failures} COORDINATION-SERVER PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
