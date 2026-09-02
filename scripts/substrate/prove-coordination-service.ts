#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-coordination-service.ts — the coordination
//  substrate is ONE typed service; the MCP server and the TeamBrief tool are
//  projections of it.
//
//  §1 SOLO — no team ⇒ no context; the brief is the empty brief with
//     teamName null and every section present.
//  §2 IN-TEAM — leases claim/list/conflict/release, DM + broadcast + the
//     unknown-recipient refusal, and the brief consolidates the substrate
//     (leases · unread mail · the roster/health/conflicts/handoffs/questions
//     sections) — real IO under a throwaway config home.
//  §3 THE PROJECTIONS — the MCP `brief` verb and the TeamBrief tool return
//     the SAME brief for the same context (JSON-equal), and neither file
//     consolidates on its own: no substrate reads in the projections, only
//     the service's verbs.
// ============================================================================

process.env.MERCURY_COORDINATION_MCP = '1'
;(globalThis as { MACRO?: { VERSION: string } }).MACRO = { VERSION: '0.0.0-proof' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const tmpHome = mkdtempSync(join(tmpdir(), 'mercury-coordination-service-'))
const prevConfigDir = process.env.MERCURY_CONFIG_DIR
process.env.MERCURY_CONFIG_DIR = tmpHome

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { createCoordinationServer } from '../../src/services/mcp/coordinationServer.js'
import { createLinkedTransportPair } from '../../src/services/mcp/InProcessTransport.js'
import {
  claimLeases,
  EMPTY_BRIEF,
  listTeamLeases,
  releaseLeases,
  resolveCoordinationContext,
  say,
  teamBrief,
} from '../../src/services/coordination/coordinationService.js'
import { TeamBriefTool } from '../../src/tools/TeamBriefTool/TeamBriefTool.js'
import { clearDynamicTeamContext, setDynamicTeamContext } from '../../src/utils/teammate.js'
import { writeTeamFileAsync, type TeamFile } from '../../src/utils/swarm/teamHelpers.js'
import { readMailbox, writeToMailbox } from '../../src/utils/teammateMailbox.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

function teamWith(name: string): TeamFile {
  const member = (id: string, memberName: string) => ({
    agentId: id,
    name: memberName,
    joinedAt: Date.now(),
    tmuxPaneId: '',
    cwd: tmpHome,
    subscriptions: [],
  })
  return {
    name,
    createdAt: Date.now(),
    leadAgentId: `lead@${name}`,
    governance: undefined,
    members: [member(`lead@${name}`, 'team-lead'), member(`w@${name}`, 'worker'), member(`b@${name}`, 'bob')],
  }
}

const asWorker = (team: string): void =>
  setDynamicTeamContext({ agentId: `w@${team}`, agentName: 'worker', teamName: team, color: 'blue', planModeRequired: false })
const asBob = (team: string): void =>
  setDynamicTeamContext({ agentId: `b@${team}`, agentName: 'bob', teamName: team, color: 'green', planModeRequired: false })

console.log('============================================================')
console.log(' the coordination service — one owner, two projections')
console.log('============================================================')

try {
  // ── §1 solo ───────────────────────────────────────────────────────────────
  section('§1 SOLO: no context; the empty brief')
  clearDynamicTeamContext()
  {
    check('no team ⇒ no coordination context', resolveCoordinationContext() === null)
    const brief = await teamBrief(null)
    check('the solo brief is the empty brief (teamName null)', brief.teamName === null)
    check(
      'every section is present and empty',
      (['openTasks', 'unreadMessages', 'openQuestions', 'roster', 'leases', 'health', 'conflicts', 'handoffs'] as const).every(
        k => Array.isArray(brief[k]) && brief[k].length === 0,
      ),
    )
    check('no party facet when solo', brief.party === undefined)
    check('EMPTY_BRIEF is the same shape', JSON.stringify(brief) === JSON.stringify(EMPTY_BRIEF))
  }

  // ── §2 in-team ────────────────────────────────────────────────────────────
  section('§2 IN-TEAM: leases · messaging · the consolidated brief')
  const TEAM = 'service-proof'
  await writeTeamFileAsync(TEAM, teamWith(TEAM))
  asWorker(TEAM)
  const worker = resolveCoordinationContext()
  check('in a team the context names the team and the agent', worker?.team === TEAM && worker?.agentId === 'worker', JSON.stringify(worker))
  if (worker) {
    const claim = await claimLeases(worker, ['src/api/**'])
    check('claimLeases grants the glob', claim.ok && claim.globs.join(',') === 'src/api/**' && claim.agentId === 'worker')
    const rows = await listTeamLeases(worker)
    check('listTeamLeases shows the claim', rows.some(r => r.agentId === 'worker' && r.globs.includes('src/api/**')))
    asBob(TEAM)
    const bob = resolveCoordinationContext()!
    const clash = await claimLeases(bob, ['src/api/routes/**'])
    check('an overlapping claim by another agent conflicts (no silent double lease)', !clash.ok && clash.conflict.agentId === 'worker', JSON.stringify(clash))
    // bob writes worker a note the brief must show as unread.
    const wrote = await writeToMailbox('worker', { from: 'bob', text: 'note for the brief', timestamp: new Date().toISOString() }, TEAM)
    check('bob wrote worker a note', wrote)
    asWorker(TEAM)
    const dm = await say(worker, 'bob', 'ping', 'a ping')
    check('say DM delivers', !('refused' in dm) && dm.ok === true && dm.broadcast === false)
    const bc = await say(worker, '*', 'all hands')
    check('say broadcast reaches the other two', !('refused' in bc) && bc.broadcast === true && bc.recipients.length === 2 && bc.failed === 0)
    const unknown = await say(worker, 'nobody', 'x')
    check('say to an unknown recipient is REFUSED (no dead-inbox write)', 'refused' in unknown && /not on team/.test(unknown.refused))
    const inbox = await readMailbox('bob', TEAM)
    check("bob's inbox holds the DM + the broadcast, colour-stamped", inbox.length === 2 && inbox.every(m => m.color === 'blue'))
    const brief = await teamBrief(worker)
    check('the brief names the team', brief.teamName === TEAM)
    check('the brief lists the lease', brief.leases.some(l => l.agentId === 'worker' && l.globs.includes('src/api/**')))
    check("the brief carries worker's unread note", brief.unreadMessages.some(m => m.from === 'bob' && m.text === 'note for the brief'))
    check(
      'the brief carries every consolidated section',
      (['openTasks', 'openQuestions', 'roster', 'health', 'conflicts', 'handoffs'] as const).every(k => Array.isArray(brief[k])),
    )
    check('a non-party team has no party facet', brief.party === undefined)
    const rel = await releaseLeases(worker)
    check('releaseLeases drops the lease', rel.ok && rel.released === true)
    check('after the release the list is empty of worker', !(await listTeamLeases(worker)).some(r => r.agentId === 'worker'))
  }

  // ── §3 the projections ────────────────────────────────────────────────────
  section('§3 THE PROJECTIONS: one brief, two faces; no consolidation outside the service')
  {
    asWorker(TEAM)
    const server = await createCoordinationServer()
    const [clientTransport, serverTransport] = createLinkedTransportPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'coordination-service-proof', version: '0' }, { capabilities: {} })
    await client.connect(clientTransport)
    const mcpBrief = await client.callTool({ name: 'brief', arguments: {} })
    const mcpJson = JSON.parse((mcpBrief as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '{}')
    const toolResult = await TeamBriefTool.call({} as never, { getAppState: () => ({ teamContext: undefined }) } as never)
    const toolJson = JSON.parse(JSON.stringify((toolResult as { data: unknown }).data))
    check('the MCP brief and the TeamBrief tool return the SAME brief (JSON-equal)', JSON.stringify(mcpJson) === JSON.stringify(toolJson))
    check('that brief names the team', mcpJson.teamName === TEAM && toolJson.teamName === TEAM)
    await client.close()
    await server.close()

    const serverSrc = readFileSync(join(ROOT, 'src/services/mcp/coordinationServer.ts'), 'utf8')
    const toolSrc = readFileSync(join(ROOT, 'src/tools/TeamBriefTool/TeamBriefTool.ts'), 'utf8')
    check('the MCP server imports the service', /from '\.\.\/coordination\/coordinationService\.js'/.test(serverSrc))
    check('the TeamBrief tool imports the service', /from '\.\.\/\.\.\/services\/coordination\/coordinationService\.js'/.test(toolSrc))
    const substrateReads = /\b(listTasks|readUnreadMessages|getAgentStatuses|listLeases|claimLease|releaseLease|sweepExpiredLeases|writeToMailbox|getRoomHealth|listIncomingHandoffs|listOpenQuestions)\s*\(/
    check('the MCP server performs no substrate read of its own', !substrateReads.test(serverSrc))
    check('the TeamBrief tool performs no substrate read of its own', !substrateReads.test(toolSrc))
    check('no second consolidation (buildBrief) survives in the server', !/buildBrief/.test(serverSrc))
    const serviceSrc = readFileSync(join(ROOT, 'src/services/coordination/coordinationService.ts'), 'utf8')
    check('the service owns the solo contract text', /NOT_IN_TEAM/.test(serviceSrc) && !/Not part of a team — the coordination tools/.test(serverSrc))
  }
} finally {
  clearDynamicTeamContext()
  if (prevConfigDir === undefined) delete process.env.MERCURY_CONFIG_DIR
  else process.env.MERCURY_CONFIG_DIR = prevConfigDir
}

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ ALL COORDINATION-SERVICE PROOFS PASS' : `❌ ${failures} COORDINATION-SERVICE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
