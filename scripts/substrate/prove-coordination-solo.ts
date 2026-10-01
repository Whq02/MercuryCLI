#!/usr/bin/env bun
process.env.MERCURY_COORDINATION_MCP = '1'
;(globalThis as { MACRO?: { VERSION: string } }).MACRO = { VERSION: '0.0.0-proof' }

import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const tmpHome = mkdtempSync(join(tmpdir(), 'mercury-coordination-solo-'))
const prevConfigDir = process.env.MERCURY_CONFIG_DIR
process.env.MERCURY_CONFIG_DIR = tmpHome

import { Client } from '@modelcontextprotocol/client'
import { createCoordinationServer } from '../../src/services/mcp/coordinationServer.js'
import { createLinkedTransportPair } from '../../src/services/mcp/InProcessTransport.js'
import { resolveCoordinationContext } from '../../src/services/coordination/coordinationService.js'
import { LiveCommsTool } from '../../src/tools/LiveCommsTool/LiveCommsTool.js'
import { runWithAgentContext } from '../../src/utils/agentContext.js'
import { birthSessionCrew, bornCrewContext } from '../../src/utils/crew/crewBirth.js'
import { clearDynamicCrewContext, getLeadCrewFallback, setDynamicCrewContext, setLeadCrewFallback } from '../../src/utils/crewmate.js'
import { appendCrewMember, getCrewDir, getCrewFilePath, writeCrewFileAsync, type CrewFile } from '../../src/utils/swarm/crewHelpers.js'
import { liveMessagesFor } from '../../src/services/crew/liveComms.js'
import { getSessionId, switchSession } from '../../src/bootstrap/state.js'

switchSession(getSessionId(), tmpHome)

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

type Result = { isError?: boolean; content?: Array<{ text?: string }> }
type Answer = { ok?: boolean; reason?: string; crewName?: string | null; leases?: Array<{ globs?: string[] }>; projectLeases?: unknown[]; roster?: Array<{ name: string }>; recipients?: string[] }
const textOf = (r: Result): string => r.content?.[0]?.text ?? ''
const jsonOf = (r: Result): Answer => {
  try {
    return JSON.parse(textOf(r)) as Answer
  } catch {
    return {}
  }
}
const isError = (r: Result): boolean => r.isError === true
const notInCrew = (r: Result): boolean => !isError(r) && jsonOf(r).ok === false && jsonOf(r).reason === 'NOT_IN_CREW'
const shown = (r: Result): string => `isError=${String(r.isError)} ${textOf(r).replace(/\s+/g, ' ').slice(0, 140)}`

async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = await createCoordinationServer()
  const [clientTransport, serverTransport] = createLinkedTransportPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'coordination-solo-proof', version: '0' }, { capabilities: {} })
  await client.connect(clientTransport)
  return {
    client,
    close: async () => {
      await client.close()
      await server.close()
    },
  }
}

const sid = String(getSessionId())
const SUB = 'agent-solo-sub'
const worktree = mkdtempSync(join(tmpdir(), 'mercury-coordination-solo-worktree-'))
mkdirSync(join(worktree, 'src'), { recursive: true })

const asSubagent = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithAgentContext({ agentType: 'subagent', agentId: SUB, subagentName: 'general-purpose' }, fn)
async function inWorktree<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.cwd()
  process.chdir(worktree)
  try {
    return await fn()
  } finally {
    process.chdir(saved)
  }
}

async function soloVerbs(client: Client, who: string): Promise<void> {
  const call = (name: string, args: Record<string, unknown>): Promise<Result> => client.callTool({ name, arguments: args }) as Promise<Result>
  const toMain = await call('coord_say', { to: 'main', message: 'to the parent' })
  check(`${who}: coord_say to a name is the typed not-in-crew result, not a tool error (RED on the base: isError "Crew <session> does not exist.")`, notInCrew(toMain), shown(toMain))
  const toAll = await call('coord_say', { to: '*', message: 'to everyone' })
  check(`${who}: coord_say broadcast is the typed not-in-crew result`, notInCrew(toAll), shown(toAll))
  const claim = await call('lease_claim', { paths: ['src/solo/**'] })
  check(`${who}: lease_claim is the typed not-in-crew result (RED on the base: the claim landed on a crew with no roster)`, notInCrew(claim), shown(claim))
  const list = await call('lease_list', {})
  const rows = jsonOf(list)
  check(`${who}: lease_list answers the project-lease shape, no crew glob row (RED on the base: the phantom crew's glob lease)`, !isError(list) && rows.ok === true && Array.isArray(rows.leases) && rows.leases.every(row => row.globs === undefined) && rows.projectLeases === undefined, shown(list))
  const brief = await call('brief', {})
  check(`${who}: brief answers crewName null (RED on the base: crewName named the session)`, !isError(brief) && jsonOf(brief).crewName === null, shown(brief))
}

const crewWith = (name: string): CrewFile => {
  const member = (id: string, memberName: string) => ({ agentId: id, name: memberName, joinedAt: Date.now(), tmuxPaneId: '', cwd: tmpHome, subscriptions: [] })
  return { name, createdAt: Date.now(), leadAgentId: `lead@${name}`, members: [member(`lead@${name}`, 'crew-lead'), member(`w@${name}`, 'worker')] }
}

console.log('============================================================')
console.log(' the crew tools answer a session that is not in a crew')
console.log('============================================================')
console.log(`  session ${sid} · config home ${tmpHome} · worktree ${worktree}`)

try {
  section('§1 the born crew with no roster: the lead and its sub-agent in a worktree get the typed not-in-crew answer')
  {
    clearDynamicCrewContext()
    check('the session crew is born: the lead fallback names the session', birthSessionCrew(sid) === sid && getLeadCrewFallback() === sid, String(getLeadCrewFallback()))
    check('precondition: no roster file exists for the born crew', !existsSync(getCrewFilePath(sid)), getCrewFilePath(sid))
    check('the resolver hands no context for a born crew with no roster (RED on the base: a context naming the session)', resolveCoordinationContext() === null, JSON.stringify(resolveCoordinationContext()))
    check("…nor on the lead's AppState rung, the LiveComms road", resolveCoordinationContext(bornCrewContext(sid)) === null, JSON.stringify(resolveCoordinationContext(bornCrewContext(sid))))
    const { client, close } = await connect()
    await soloVerbs(client, 'the lead')
    await inWorktree(() => asSubagent(() => soloVerbs(client, 'a sub-agent in a worktree')))
    check('no phantom crew folder is written by the solo calls (RED on the base: crews/<session>/leases/leases.json)', !existsSync(getCrewDir(sid)), getCrewDir(sid))
    await close()
  }

  section('§2 the LiveComms projection speaks the same solo contract')
  {
    const result = (await LiveCommsTool.call({ say: { to: '*', message: 'LIVE-SOLO' } } as never, { getAppState: () => ({ crewContext: bornCrewContext(sid) }) } as never)) as { data: Answer & { wrote?: Array<{ ok: boolean; detail: string }> } }
    check('the LiveComms brief of a born crew with no roster is the empty brief (RED on the base: it named the session as its crew)', result.data.crewName === null, JSON.stringify(result.data.crewName))
    check('…and its say is not attempted against a crew that does not exist (RED on the base: a REFUSED receipt "does not exist")', result.data.wrote === undefined, JSON.stringify(result.data.wrote))
    const block = LiveCommsTool.mapToolResultToToolResultBlockParam!(result.data as never, 'tu-solo')
    check('the rendered answer explains the solo state', typeof block.content === 'string' && /Not part of a crew/.test(block.content), String(block.content).slice(0, 120))
  }

  section('§3 the first join founds the roster: the same tools light up, for the lead and for the sub-agent in its worktree')
  {
    await appendCrewMember(sid, { agentId: `alpha@${sid}`, name: 'alpha', joinedAt: Date.now(), tmuxPaneId: 'in-process', cwd: worktree, subscriptions: [] } as never)
    check('the roster exists after the first crewmate join', existsSync(getCrewFilePath(sid)))
    const lead = resolveCoordinationContext()
    check('the resolver now hands the session crew to the lead', lead?.crew === sid && lead?.agentId === 'crew-lead', JSON.stringify(lead))
    const { client, close } = await connect()
    const call = (name: string, args: Record<string, unknown>): Promise<Result> => client.callTool({ name, arguments: args }) as Promise<Result>
    const leadBrief = await call('brief', {})
    check('the lead brief names the crew and lists the crewmate', jsonOf(leadBrief).crewName === sid && (jsonOf(leadBrief).roster ?? []).some(m => m.name === 'alpha'), shown(leadBrief))
    const leadClaim = await call('lease_claim', { paths: ['src/lead/**'] })
    check('the lead claims in its crew', !isError(leadClaim) && jsonOf(leadClaim).ok === true, shown(leadClaim))
    const leadList = await call('lease_list', {})
    check('lease_list carries the crew claim beside the project leases', !isError(leadList) && (jsonOf(leadList).leases ?? []).some(row => (row.globs ?? []).includes('src/lead/**')) && Array.isArray(jsonOf(leadList).projectLeases), shown(leadList))
    await inWorktree(() =>
      asSubagent(async () => {
        const sub = resolveCoordinationContext()
        check('the sub-agent in the worktree resolves the same crew under its own id (the roster is read from the config home, not the cwd)', sub?.crew === sid && sub?.agentId === SUB, `${JSON.stringify(sub)} cwd=${process.cwd()}`)
        const brief = await call('brief', {})
        check("the sub-agent's brief names the crew", jsonOf(brief).crewName === sid, shown(brief))
        const dm = await call('coord_say', { to: 'alpha', message: 'FROM-THE-WORKTREE' })
        check('coord_say to a crewmate delivers from the worktree', !isError(dm) && jsonOf(dm).ok === true, shown(dm))
        const all = await call('coord_say', { to: '*', message: 'ALL-FROM-THE-WORKTREE' })
        check('coord_say broadcast reaches the lead and the crewmate', !isError(all) && jsonOf(all).ok === true && (jsonOf(all).recipients ?? []).length === 2, shown(all))
      }),
    )
    const inbox = await liveMessagesFor(sid, 'alpha')
    check("alpha's inbox holds the DM and the broadcast, both from the sub-agent's own id", inbox.filter(m => m.from === SUB).length === 2 && inbox.some(m => m.text === 'FROM-THE-WORKTREE'), JSON.stringify(inbox.map(m => [m.from, m.text])))
    await close()
  }

  section('§4 a crewmate identity and the recovery seam keep their word')
  {
    const CREW = 'solo-proof-crew'
    await writeCrewFileAsync(CREW, crewWith(CREW))
    setDynamicCrewContext({ agentId: `w@${CREW}`, agentName: 'worker', crewName: CREW, color: 'blue', planModeRequired: false })
    const worker = resolveCoordinationContext()
    check('a crewmate identity resolves its crew', worker?.crew === CREW && worker?.agentId === 'worker', JSON.stringify(worker))
    clearDynamicCrewContext()
    setLeadCrewFallback(CREW)
    const led = resolveCoordinationContext()
    check('a led crew the recovery seam registers (its roster on disk) resolves for the lead', led?.crew === CREW && led?.agentId === 'crew-lead', JSON.stringify(led))
    setLeadCrewFallback('never-founded-crew')
    check('a lead fallback naming a crew with no roster hands nothing', resolveCoordinationContext() === null, JSON.stringify(resolveCoordinationContext()))
    setLeadCrewFallback(sid)
    const serviceSrc = readFileSync(join(ROOT, 'src/services/coordination/coordinationService.ts'), 'utf8')
    check('the resolver verifies the roster for the lead rungs and leaves a crewmate identity alone (structural)', serviceSrc.includes('if (!isCrewmate() && !crewRosterExists(crew)) return null'))
    const helpersSrc = readFileSync(join(ROOT, 'src/utils/swarm/crewHelpers.ts'), 'utf8')
    check('the roster owner answers whether a roster exists, by the same readable path its readers use (structural)', helpersSrc.includes('export function crewRosterExists(crewName: string): boolean') && helpersSrc.includes('return existsSync(readableCrewFilePath(crewName))'))
  }
} finally {
  clearDynamicCrewContext()
  if (prevConfigDir === undefined) delete process.env.MERCURY_CONFIG_DIR
  else process.env.MERCURY_CONFIG_DIR = prevConfigDir
}

console.log('\n' + '═'.repeat(76))
console.log(failures === 0 ? '✅ THE CREW TOOLS ANSWER A SESSION THAT IS NOT IN A CREW' : `❌ ${failures} COORDINATION-SOLO PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
