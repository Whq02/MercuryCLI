#!/usr/bin/env bun
process.env.MERCURY_COORDINATION_MCP = '1'
;(globalThis as { MACRO?: { VERSION: string } }).MACRO = { VERSION: '0.0.0-proof' }

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tmpHome = mkdtempSync(join(tmpdir(), 'mercury-lease-words-'))
process.env.MERCURY_CONFIG_DIR = tmpHome
process.env.MERCURY_TEAMS_DIR = join(tmpHome, 'teams')

import { Client } from '@modelcontextprotocol/client'
import { createCoordinationServer } from '../../src/services/mcp/coordinationServer.js'
import { createLinkedTransportPair } from '../../src/services/mcp/InProcessTransport.js'
import { clearDynamicTeamContext, setDynamicTeamContext } from '../../src/utils/teammate.js'
import { writeTeamFileAsync, type TeamFile } from '../../src/utils/swarm/teamHelpers.js'
import { getSessionId, switchSession } from '../../src/bootstrap/state.js'
import { makeTally } from '../daemon/dupline-world.ts'

const tally = makeTally('prove-lease-words')
const work = join(tmpHome, 'work')
mkdirSync(work, { recursive: true })
process.chdir(work)
switchSession(getSessionId(), tmpHome)
writeFileSync(join(work, 'x.txt'), 'x\n')
writeFileSync(join(work, 'y.txt'), 'y\n')

type Result = { isError?: boolean; content?: Array<{ type?: string; text?: string }> }
const textOf = (r: Result): string => r.content?.map(c => (c.type === 'text' ? (c.text ?? '') : '')).join('') ?? ''
const jsonOf = (r: Result): Record<string, unknown> => {
  try {
    return JSON.parse(textOf(r)) as Record<string, unknown>
  } catch {
    return {}
  }
}

async function connect(): Promise<Client> {
  const server = await createCoordinationServer()
  const [clientTransport, serverTransport] = createLinkedTransportPair()
  await server.connect(serverTransport)
  const client = new Client({ name: 'lease-words-proof', version: '0' }, { capabilities: {} })
  await client.connect(clientTransport)
  return client
}

const TEAM = 'lease-words'
const team: TeamFile = {
  name: TEAM,
  createdAt: Date.now(),
  leadAgentId: `lead@${TEAM}`,
  governance: undefined,
  members: [
    { agentId: `lead@${TEAM}`, name: 'team-lead', joinedAt: Date.now(), tmuxPaneId: '', cwd: work, subscriptions: [] },
    { agentId: `w@${TEAM}`, name: 'worker', joinedAt: Date.now(), tmuxPaneId: '', cwd: work, subscriptions: [] },
  ],
}
await writeTeamFileAsync(TEAM, team)
setDynamicTeamContext({ agentId: `w@${TEAM}`, agentName: 'worker', teamName: TEAM, planModeRequired: false })

try {
  const client = await connect()
  const tools = (await client.listTools()).tools
  const claim = tools.find(t => t.name === 'lease_claim')
  const release = tools.find(t => t.name === 'lease_release')
  const props = (t: { inputSchema?: { properties?: Record<string, unknown>; required?: string[] } } | undefined): { keys: string[]; required: string[] } => ({
    keys: Object.keys(t?.inputSchema?.properties ?? {}).sort(),
    required: [...(t?.inputSchema?.required ?? [])].sort(),
  })

  tally.section('A. one word on both lease verbs, the other accepted as its alias')
  const claimProps = props(claim)
  const releaseProps = props(release)
  tally.check('A1 lease_claim takes paths and accepts globs, neither required', claimProps.keys.includes('paths') && claimProps.keys.includes('globs') && claimProps.required.length === 0, JSON.stringify(claimProps))
  tally.check('A2 lease_release takes paths and accepts globs', releaseProps.keys.includes('paths') && releaseProps.keys.includes('globs'), JSON.stringify(releaseProps))
  tally.check('A3 both descriptions say paths and name globs as the same argument', /\bpaths\b/.test(claim?.description ?? '') && /\bglobs\b/.test(claim?.description ?? '') && /\bpaths\b/.test(release?.description ?? '') && /\bglobs\b/.test(release?.description ?? ''), `${claim?.description}\n${release?.description}`)

  tally.section('B. a claim with either spelling lands')
  const withPaths = (await client.callTool({ name: 'lease_claim', arguments: { paths: ['src/a.ts'], reason: 'probe' } })) as Result
  tally.check('B1 a claim sent as paths (with the reason the model adds) is granted', !withPaths.isError && jsonOf(withPaths).ok === true && JSON.stringify(jsonOf(withPaths).globs) === JSON.stringify(['src/a.ts']), textOf(withPaths).slice(0, 300))
  const withGlobs = (await client.callTool({ name: 'lease_claim', arguments: { globs: ['src/b/**'] } })) as Result
  tally.check('B2 a claim sent as globs is granted', !withGlobs.isError && jsonOf(withGlobs).ok === true && JSON.stringify(jsonOf(withGlobs).globs) === JSON.stringify(['src/b/**']), textOf(withGlobs).slice(0, 300))
  const withBoth = (await client.callTool({ name: 'lease_claim', arguments: { paths: ['src/c.ts'], globs: ['src/d.ts'] } })) as Result
  tally.check('B3 both spellings together lease the union', !withBoth.isError && jsonOf(withBoth).ok === true && JSON.stringify([...((jsonOf(withBoth).globs as string[]) ?? [])].sort()) === JSON.stringify(['src/c.ts', 'src/d.ts']), textOf(withBoth).slice(0, 300))
  const none = (await client.callTool({ name: 'lease_claim', arguments: { reason: 'no list at all' } })) as Result
  tally.check('B4 a claim with no list is refused', none.isError === true, textOf(none).slice(0, 300))
  tally.check('B5 the refusal names both spellings', /\bpaths\b/.test(textOf(none)) && /\bglobs\b/.test(textOf(none)), textOf(none).slice(0, 300))
  const emptySet = (await client.callTool({ name: 'lease_claim', arguments: { paths: [] } })) as Result
  tally.check('B6 an explicit empty set still releases the team lease', !emptySet.isError && jsonOf(emptySet).ok === true && JSON.stringify(jsonOf(emptySet).globs) === JSON.stringify([]), textOf(emptySet).slice(0, 300))

  tally.section('C. a release with either spelling releases')
  const takeX = (await client.callTool({ name: 'lease_take', arguments: { paths: ['x.txt'] } })) as Result
  tally.check('C1 an exact project lease is taken', !takeX.isError && jsonOf(takeX).ok === true, textOf(takeX).slice(0, 300))
  const releaseX = (await client.callTool({ name: 'lease_release', arguments: { paths: ['x.txt'] } })) as Result
  tally.check('C2 a release sent as paths releases it', !releaseX.isError && jsonOf(releaseX).ok === true && jsonOf(releaseX).released === true, textOf(releaseX).slice(0, 300))
  const takeY = (await client.callTool({ name: 'lease_take', arguments: { paths: ['y.txt'] } })) as Result
  tally.check('C3 a second exact project lease is taken', !takeY.isError && jsonOf(takeY).ok === true, textOf(takeY).slice(0, 300))
  const claimAgain = (await client.callTool({ name: 'lease_claim', arguments: { paths: ['src/e.ts'] } })) as Result
  tally.check('C4 the team lease stands again', !claimAgain.isError && jsonOf(claimAgain).ok === true, textOf(claimAgain).slice(0, 300))
  const releaseY = (await client.callTool({ name: 'lease_release', arguments: { globs: ['y.txt'] } })) as Result
  tally.check('C5 a release sent as globs releases the named project lease', !releaseY.isError && jsonOf(releaseY).ok === true && jsonOf(releaseY).released === true, textOf(releaseY).slice(0, 300))
  const listAfter = (await client.callTool({ name: 'lease_list', arguments: {} })) as Result
  const leases = (jsonOf(listAfter).leases as Array<{ agentId?: string; globs?: string[] }>) ?? []
  tally.check('C6 the team lease was not the one released', leases.some(l => l.agentId === 'worker' && JSON.stringify(l.globs) === JSON.stringify(['src/e.ts'])), textOf(listAfter).slice(0, 400))
  const releaseTeam = (await client.callTool({ name: 'lease_release', arguments: {} })) as Result
  tally.check('C7 a release with no list still drops the team lease', !releaseTeam.isError && jsonOf(releaseTeam).ok === true && jsonOf(releaseTeam).released === true, textOf(releaseTeam).slice(0, 300))
  await client.close()
} finally {
  clearDynamicTeamContext()
}

if (tally.failed() === 0) rmSync(tmpHome, { recursive: true, force: true })
else console.log(`\nworld kept: ${tmpHome}`)
tally.finish()
