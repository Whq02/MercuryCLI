#!/usr/bin/env bun
process.env.MERCURY_COORDINATION_MCP = '1'
;(globalThis as { MACRO?: { VERSION: string } }).MACRO = { VERSION: '0.0.0-proof' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'mercury-coordination-livecomms-'))
const prevConfigDir = process.env.MERCURY_CONFIG_DIR
process.env.MERCURY_CONFIG_DIR = tmpHome
process.env.MERCURY_CREWS_DIR = join(tmpHome, 'teams')

import { Client } from '@modelcontextprotocol/client'
import { createCoordinationServer } from '../../src/services/mcp/coordinationServer.js'
import { createLinkedTransportPair } from '../../src/services/mcp/InProcessTransport.js'
import { clearDynamicCrewContext, setDynamicCrewContext } from '../../src/utils/crewmate.js'
import { writeCrewFileAsync, type CrewFile } from '../../src/utils/swarm/crewHelpers.js'

type AnyTool = { call: (input: unknown, context: unknown) => Promise<{ data: unknown }> }
let liveTool: AnyTool
let toolHome = 'src/tools/LiveCommsTool/LiveCommsTool.js'
try {
  liveTool = (await import('../../src/tools/LiveCommsTool/LiveCommsTool.js')).LiveCommsTool as unknown as AnyTool
} catch {
  toolHome = 'src/tools/TeamBriefTool/TeamBriefTool.js'
  liveTool = (await import('../../src/tools/TeamBriefTool/TeamBriefTool.js')).TeamBriefTool as unknown as AnyTool
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const CREW = 'live-crew'
function crewFile(): CrewFile {
  const member = (id: string, name: string) => ({ agentId: id, name, joinedAt: Date.now(), tmuxPaneId: '', cwd: tmpHome, subscriptions: [] })
  return { name: CREW, createdAt: Date.now(), leadAgentId: `lead@${CREW}`, members: [member(`lead@${CREW}`, 'team-lead'), member(`a@${CREW}`, 'alice'), member(`b@${CREW}`, 'bob')] }
}
const asCrewmate = (name: string): void =>
  setDynamicCrewContext({ agentId: `${name[0]}@${CREW}`, agentName: name, teamName: CREW, color: name === 'alice' ? 'green' : 'blue', planModeRequired: false })

async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = await createCoordinationServer()
  const [clientTransport, serverTransport] = createLinkedTransportPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'coordination-livecomms-proof', version: '0' }, { capabilities: {} })
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

type Brief = {
  teamName: string | null
  openTasks: Array<{ id: string; subject: string; status: string }>
  unreadMessages: Array<{ from: string; text: string; summary?: string }>
  roster: Array<{ name: string; status: string; doing?: string }>
  leases: Array<{ agentId: string; globs: string[] }>
}
const briefOf = async (client: Client): Promise<Brief> => {
  const result = await client.callTool({ name: 'brief', arguments: {} })
  return JSON.parse((result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? '{}') as Brief
}
const textOf = (result: unknown): string => (result as { content?: Array<{ text?: string }> }).content?.[0]?.text ?? ''

console.log('============================================================')
console.log(' the coordination server reads and writes LiveComms')
console.log('============================================================')
console.log(`  write road: ${toolHome}`)

try {
  await writeCrewFileAsync(CREW, crewFile())

  section('§1 the words: every coordination verb speaks of the crew, never the team')
  {
    asCrewmate('alice')
    const { client, close } = await connect()
    const listed = await client.listTools()
    const verbs = listed.tools.filter(t => ['lease_claim', 'lease_release', 'lease_list', 'lease_take', 'brief', 'coord_say'].includes(t.name))
    check('the six coordination verbs register under their names (the schema stays)', verbs.length === 6, verbs.map(t => t.name).join(','))
    const crewWords = verbs.filter(t => /\bteam\b|teammate|TEAM-ONLY|TeamBrief/i.test(t.description ?? ''))
    check('no verb description says team, teammate or TeamBrief (RED on the base: TEAM-ONLY, teammates, "the TeamBrief tool")', crewWords.length === 0, crewWords.map(t => `${t.name}: ${(t.description ?? '').slice(0, 80)}`).join(' | '))
    check('the brief verb names LiveComms as the same read', /LiveComms/.test(verbs.find(t => t.name === 'brief')?.description ?? ''), verbs.find(t => t.name === 'brief')?.description ?? '')
    const instructions = client.getInstructions() ?? ''
    check('the server instructions speak of the crew and LiveComms, not the team mailbox (RED on the base: "team brief", "team-mailbox")', /crew/.test(instructions) && /LiveComms/.test(instructions) && !/\bteam\b|team-mailbox/i.test(instructions), instructions)
    await close()
  }

  section('§2 THE PIN: a task, a busy word and a message written by alice through LiveComms are in bob\'s brief, live')
  let taskId = ''
  {
    asCrewmate('alice')
    const answer = (await liveTool.call({ task: { subject: 'LIVE-TASK through the server' }, busy: { busy: true, doing: 'LIVE-DOING' }, say: { to: 'bob', message: 'LIVE-HELLO over the wire', summary: 'hello' } }, { getAppState: () => ({}) })).data as Brief & { wrote?: Array<{ ok: boolean }> }
    check('alice\'s write is receipted (RED on the base: the write road does not exist)', Array.isArray(answer.wrote) && answer.wrote.length === 3 && answer.wrote.every(w => w.ok), JSON.stringify(answer.wrote ?? null))
    taskId = answer.openTasks?.find(t => t.subject === 'LIVE-TASK through the server')?.id ?? ''
    asCrewmate('bob')
    const { client, close } = await connect()
    const brief = await briefOf(client)
    check('bob\'s MCP brief names the crew', brief.teamName === CREW, JSON.stringify(brief.teamName))
    check('bob\'s MCP brief lists alice\'s task as open (RED on the base: no such task)', brief.openTasks.some(t => t.id === taskId && t.status === 'pending'), JSON.stringify(brief.openTasks))
    check('bob\'s MCP brief reads alice busy with her word (RED on the base: no busy word)', brief.roster.some(r => r.name === 'alice' && r.status === 'busy' && r.doing === 'LIVE-DOING'), JSON.stringify(brief.roster))
    check('bob\'s MCP brief carries alice\'s message unread', brief.unreadMessages.some(m => m.from === 'alice' && m.text === 'LIVE-HELLO over the wire' && m.summary === 'hello'), JSON.stringify(brief.unreadMessages))

    section('§3 the verbs write back: coord_say and lease_claim from bob reach alice\'s brief')
    const said = await client.callTool({ name: 'coord_say', arguments: { to: 'alice', message: 'LIVE-REPLY from bob', summary: 'reply' } })
    check('coord_say to alice is accepted', !(said as { isError?: boolean }).isError && /alice/.test(textOf(said)), textOf(said))
    const claimed = await client.callTool({ name: 'lease_claim', arguments: { paths: ['src/wire/**'] } })
    check('lease_claim grants bob the path', !(claimed as { isError?: boolean }).isError && /"ok": true/.test(textOf(claimed)), textOf(claimed))
    await close()
    asCrewmate('alice')
    const alice = await connect()
    const aliceBrief = await briefOf(alice.client)
    check('alice\'s brief carries bob\'s reply unread', aliceBrief.unreadMessages.some(m => m.from === 'bob' && m.text === 'LIVE-REPLY from bob'), JSON.stringify(aliceBrief.unreadMessages))
    check('alice\'s brief lists bob\'s claim', aliceBrief.leases.some(l => l.agentId === 'bob' && l.globs.includes('src/wire/**')), JSON.stringify(aliceBrief.leases))
    const toolJson = JSON.parse(JSON.stringify((await liveTool.call({}, { getAppState: () => ({}) })).data)) as Brief
    const steady = (brief: Brief): string => JSON.stringify({ ...brief, health: ((brief as { health?: Array<Record<string, unknown>> }).health ?? []).map(h => ({ ...h, leaseAgeMs: null })) })
    check('the MCP brief and the LiveComms read are the SAME state (JSON-equal but for the claim age clock, the projection law)', steady(aliceBrief) === steady(toolJson), `${steady(aliceBrief).slice(0, 200)} vs ${steady(toolJson).slice(0, 200)}`)
    await alice.close()
  }

  section('§4 a write by bob is visible to alice\'s next read with no restart')
  {
    asCrewmate('bob')
    await liveTool.call({ task: { id: taskId, status: 'completed' } }, { getAppState: () => ({}) })
    asCrewmate('alice')
    const { client, close } = await connect()
    const brief = await briefOf(client)
    check('the completed task has left alice\'s brief', taskId !== '' && !brief.openTasks.some(t => t.id === taskId), JSON.stringify(brief.openTasks))
    await close()
  }
} finally {
  clearDynamicCrewContext()
  if (prevConfigDir === undefined) delete process.env.MERCURY_CONFIG_DIR
  else process.env.MERCURY_CONFIG_DIR = prevConfigDir
}

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ THE COORDINATION SERVER READS AND WRITES LIVECOMMS' : `❌ ${failures} COORDINATION-LIVECOMMS PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
