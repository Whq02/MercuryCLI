#!/usr/bin/env bun

process.env.MERCURY_COORDINATION_MCP = '1'
;(globalThis as { MACRO?: { VERSION: string } }).MACRO = { VERSION: '0.0.0-proof' }

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const tmpHome = mkdtempSync(join(tmpdir(), 'mercury-coordination-service-'))
const prevConfigDir = process.env.MERCURY_CONFIG_DIR
process.env.MERCURY_CONFIG_DIR = tmpHome

import { Client } from '@modelcontextprotocol/client'
import { createCoordinationServer } from '../../src/services/mcp/coordinationServer.js'
import { createLinkedTransportPair } from '../../src/services/mcp/InProcessTransport.js'
import {
  claimLeases,
  EMPTY_BRIEF,
  listCrewLeases,
  releaseLeases,
  resolveCoordinationContext,
  say,
  crewBrief,
} from '../../src/services/coordination/coordinationService.js'
import { LiveCommsTool } from '../../src/tools/LiveCommsTool/LiveCommsTool.js'
import { clearDynamicCrewContext, setDynamicCrewContext } from '../../src/utils/crewmate.js'
import { writeCrewFileAsync, type CrewFile } from '../../src/utils/swarm/crewHelpers.js'
import { liveMessagesFor, sendLiveMessage } from '../../src/services/crew/liveComms.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

function crewWith(name: string): CrewFile {
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
    members: [member(`lead@${name}`, 'crew-lead'), member(`w@${name}`, 'worker'), member(`b@${name}`, 'bob')],
  }
}

const asWorker = (crew: string): void =>
  setDynamicCrewContext({ agentId: `w@${crew}`, agentName: 'worker', crewName: crew, color: 'blue' })
const asBob = (crew: string): void =>
  setDynamicCrewContext({ agentId: `b@${crew}`, agentName: 'bob', crewName: crew, color: 'green' })

console.log('============================================================')
console.log(' the coordination service — one owner, two projections')
console.log('============================================================')

try {
  section('§1 SOLO: no context; the empty brief')
  clearDynamicCrewContext()
  {
    check('no crew ⇒ no coordination context', resolveCoordinationContext() === null)
    const brief = await crewBrief(null)
    check('the solo brief is the empty brief (crewName null)', brief.crewName === null)
    check(
      'every section is present and empty',
      (['openTasks', 'unreadMessages', 'openQuestions', 'roster', 'leases', 'health', 'conflicts', 'handoffs'] as const).every(
        k => Array.isArray(brief[k]) && brief[k].length === 0,
      ),
    )
    check('no party facet when solo', brief.party === undefined)
    check('EMPTY_BRIEF is the same shape', JSON.stringify(brief) === JSON.stringify(EMPTY_BRIEF))
  }

  section('§2 IN-CREW: leases · messaging · the consolidated brief')
  const CREW = 'service-proof'
  await writeCrewFileAsync(CREW, crewWith(CREW))
  asWorker(CREW)
  const worker = resolveCoordinationContext()
  check('in a crew the context names the crew and the agent', worker?.crew === CREW && worker?.agentId === 'worker', JSON.stringify(worker))
  if (worker) {
    const claim = await claimLeases(worker, ['src/api/**'])
    check('claimLeases grants the glob', claim.ok && claim.globs.join(',') === 'src/api/**' && claim.agentId === 'worker')
    const rows = await listCrewLeases(worker)
    check('listCrewLeases shows the claim', rows.some(r => r.agentId === 'worker' && r.globs.includes('src/api/**')))
    asBob(CREW)
    const bob = resolveCoordinationContext()!
    const clash = await claimLeases(bob, ['src/api/routes/**'])
    check('an overlapping claim by another agent conflicts (no silent double lease)', !clash.ok && clash.conflict.agentId === 'worker', JSON.stringify(clash))
    const wrote = await sendLiveMessage(CREW, { to: 'worker', from: 'bob', text: 'note for the brief', timestamp: new Date().toISOString() })
    check('bob wrote worker a note', wrote)
    asWorker(CREW)
    const dm = await say(worker, 'bob', 'ping', 'a ping')
    check('say DM delivers', !('refused' in dm) && dm.ok === true && dm.broadcast === false)
    const bc = await say(worker, '*', 'all hands')
    check('say broadcast reaches the other two', !('refused' in bc) && bc.broadcast === true && bc.recipients.length === 2 && bc.failed === 0)
    const unknown = await say(worker, 'nobody', 'x')
    check('say to an unknown recipient is REFUSED (no dead-inbox write)', 'refused' in unknown && /not on crew/.test(unknown.refused))
    const inbox = await liveMessagesFor(CREW, 'bob')
    check("bob's inbox holds the DM + the broadcast, colour-stamped", inbox.length === 2 && inbox.every(m => m.color === 'blue'))
    const brief = await crewBrief(worker)
    check('the brief names the crew', brief.crewName === CREW)
    check('the brief lists the lease', brief.leases.some(l => l.agentId === 'worker' && l.globs.includes('src/api/**')))
    check("the brief carries worker's unread note", brief.unreadMessages.some(m => m.from === 'bob' && m.text === 'note for the brief'))
    check(
      'the brief carries every consolidated section',
      (['openTasks', 'openQuestions', 'roster', 'health', 'conflicts', 'handoffs'] as const).every(k => Array.isArray(brief[k])),
    )
    check('a non-party crew has no party facet', brief.party === undefined)
    const rel = await releaseLeases(worker)
    check('releaseLeases drops the lease', rel.ok && rel.released === true)
    check('after the release the list is empty of worker', !(await listCrewLeases(worker)).some(r => r.agentId === 'worker'))
  }

  section('§3 THE PROJECTIONS: one brief, two faces; no consolidation outside the service')
  {
    asWorker(CREW)
    const server = await createCoordinationServer()
    const [clientTransport, serverTransport] = createLinkedTransportPair()
    await server.connect(serverTransport)
    const client = new Client({ name: 'coordination-service-proof', version: '0' }, { capabilities: {} })
    await client.connect(clientTransport)
    const mcpBrief = await client.callTool({ name: 'brief', arguments: {} })
    const mcpJson = JSON.parse((mcpBrief as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '{}')
    const toolResult = await LiveCommsTool.call({} as never, { getAppState: () => ({ crewContext: undefined }) } as never)
    const toolJson = JSON.parse(JSON.stringify((toolResult as { data: unknown }).data))
    check('the MCP brief and the LiveComms tool return the SAME brief (JSON-equal)', JSON.stringify(mcpJson) === JSON.stringify(toolJson))
    check('that brief names the crew', mcpJson.crewName === CREW && toolJson.crewName === CREW)
    await client.close()
    await server.close()

    const serverSrc = readFileSync(join(ROOT, 'src/services/mcp/coordinationServer.ts'), 'utf8')
    const toolSrc = readFileSync(join(ROOT, 'src/tools/LiveCommsTool/LiveCommsTool.ts'), 'utf8')
    check('the MCP server imports the service', /from '\.\.\/coordination\/coordinationService\.js'/.test(serverSrc))
    check('the LiveComms tool imports the service', /from '\.\.\/\.\.\/services\/coordination\/coordinationService\.js'/.test(toolSrc))
    const substrateReads = /\b(listTasks|unreadLiveMessagesFor|liveMessagesFor|sendLiveMessage|getAgentStatuses|listLeases|claimLease|releaseLease|sweepExpiredLeases|writeToMailbox|getRoomHealth|listIncomingHandoffs|listOpenQuestions|listLiveTasks|listLiveClaims|listLiveBusy|upsertLiveTask|setLiveClaim|releaseLiveClaim|setLiveBusy|postLiveMessage)\s*\(/
    check('the MCP server performs no substrate read of its own', !substrateReads.test(serverSrc))
    check('the LiveComms tool performs no substrate read or write of its own', !substrateReads.test(toolSrc))
    check('no second consolidation (buildBrief) survives in the server', !/buildBrief/.test(serverSrc))
    const serviceSrc = readFileSync(join(ROOT, 'src/services/coordination/coordinationService.ts'), 'utf8')
    check('the service owns the solo contract text', /NOT_IN_CREW/.test(serviceSrc) && !/Not part of a crew — the coordination tools/.test(serverSrc))
  }
} finally {
  clearDynamicCrewContext()
  if (prevConfigDir === undefined) delete process.env.MERCURY_CONFIG_DIR
  else process.env.MERCURY_CONFIG_DIR = prevConfigDir
}

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ ALL COORDINATION-SERVICE PROOFS PASS' : `❌ ${failures} COORDINATION-SERVICE PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
