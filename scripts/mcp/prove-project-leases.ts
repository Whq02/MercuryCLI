#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Client, type CallToolResult } from '@modelcontextprotocol/client'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = join(proofHome, 'work')
mkdirSync(root, { recursive: true })
const { switchSession, setOriginalCwd } = await import('../../src/bootstrap/state.ts')
setOriginalCwd(root)
switchSession('00000000-0000-4000-8000-000000000045' as never, root)
const { createMercuryServer, withMercuryLeaseHolder } = await import('../../src/services/mcp/mercuryServer.ts')
const { createLinkedTransportPair } = await import('../../src/services/mcp/InProcessTransport.ts')
const { projectLeaseHolder, takeProjectLeases, releaseProjectLeases, listProjectLeases } = await import('../../src/services/vulcan/engine/leases.ts')

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${JSON.stringify(detail)}` : ''}`)
}
const server = await createMercuryServer()
const client = new Client({ name: 'lease-proof', version: '0' })
const [a, b] = createLinkedTransportPair()
type LeaseCallResult = CallToolResult & { structuredContent?: Record<string, unknown> }
const call = (name: string, args: Record<string, unknown>, agentId?: string): Promise<LeaseCallResult> => withMercuryLeaseHolder(agentId, () => client.callTool({ name, arguments: args })) as Promise<LeaseCallResult>
const textOf = (result: Awaited<ReturnType<typeof call>>): string => JSON.stringify(result.content)
const paths = async (): Promise<string[]> => (await listProjectLeases(root)).map(lease => lease.path).sort()
const foreign = { ...projectLeaseHolder('foreign'), sessionId: 'other-session' }

try {
  await Promise.all([server.connect(a), client.connect(b)])
  const { tools } = await client.listTools()
  const release = tools.find(tool => tool.name === 'lease_release')!
  check('initialise and discovery expose the three lease tools', ['lease_take', 'lease_release', 'lease_list'].every(name => tools.some(tool => tool.name === name)))
  for (const name of ['paths', 'agentId', 'all']) {
    check(`${name} is optional and accepts null in discovery`, !release.inputSchema.required?.includes(name) && JSON.stringify(release.inputSchema.properties?.[name]).includes('"null"'))
  }
  check('release and list keep their output schemas', !!release.outputSchema && !!tools.find(tool => tool.name === 'lease_list')?.outputSchema)

  for (const args of [{}, { paths: null }, { paths: null, agentId: null, all: null }, { agentId: null, all: false }]) {
    await call('lease_take', { paths: ['own.ts'] })
    await call('lease_take', { paths: ['sibling.ts'] }, 'sibling')
    const result = await call('lease_release', args)
    check(`null and omitted mean own leases only: ${JSON.stringify(args)}`, !result.isError && result.structuredContent?.released === true && result.structuredContent?.agentId === 'main' && JSON.stringify(await paths()) === '["sibling.ts"]', result)
  }
  const noPaths = await call('lease_release', { paths: [] }, 'sibling')
  check('an explicit empty path list releases nothing', !noPaths.isError && noPaths.structuredContent?.released === false && (await paths()).includes('sibling.ts'), noPaths)
  const siblingAttempt = await call('lease_release', { paths: ['sibling.ts'] }, 'other-agent')
  check('ordinary release stays holder-scoped', !siblingAttempt.isError && siblingAttempt.structuredContent?.released === false && (await paths()).includes('sibling.ts'), siblingAttempt)
  for (const args of [{ agentId: 'sibling' }, { all: true }]) {
    const result = await call('lease_release', args, 'other-agent')
    check('a sibling cannot use the director override', result.isError === true && textOf(result).includes('director') && (await paths()).includes('sibling.ts'), result)
  }

  await call('lease_take', { paths: ['sibling-two.ts'] }, 'sibling')
  await call('lease_take', { paths: ['director.ts'] })
  const selected = await call('lease_release', { agentId: 'sibling', paths: ['sibling.ts'], all: null })
  check('the director can release named paths for one agent', !selected.isError && selected.structuredContent?.agentId === 'sibling' && JSON.stringify(await paths()) === '["director.ts","sibling-two.ts"]', selected)
  const target = await call('lease_release', { agentId: 'sibling', paths: null })
  check('the director can release all paths for one agent', !target.isError && target.structuredContent?.released === true && JSON.stringify(await paths()) === '["director.ts"]', target)
  const absent = await call('lease_release', { agentId: 'missing' })
  check('an unknown agent is an honest no-op', !absent.isError && absent.structuredContent?.released === false, absent)

  await takeProjectLeases(root, ['foreign.ts'], foreign)
  const refused = await call('lease_take', { paths: ['foreign.ts'] })
  check('a competing session take names its holder', !refused.isError && textOf(refused).includes('other-session') && textOf(refused).includes('foreign') && textOf(refused).includes('false'), refused)
  const listed = await call('lease_list', {})
  const listedLeases = listed.structuredContent?.leases as Array<{ holder: { sessionId: string; agentId: string } }>
  check('lease_list retains session and agent identities in validated structured content', !listed.isError && listedLeases.some(lease => lease.holder.sessionId === foreign.sessionId && lease.holder.agentId === foreign.agentId), listed)
  for (const args of [{ agentId: 'foreign' }, { agentId: 'foreign', paths: ['foreign.ts'] }, { all: true, paths: ['director.ts', 'foreign.ts'] }]) {
    const result = await call('lease_release', args)
    check(`cross-session override refuses by name: ${JSON.stringify(args)}`, result.isError === true && textOf(result).includes('other-session') && textOf(result).includes('foreign') && JSON.stringify(await paths()) === '["director.ts","foreign.ts"]', result)
  }
  await takeProjectLeases(root, ['same-id-foreign.ts'], { ...foreign, agentId: 'sibling' })
  await call('lease_take', { paths: ['sibling.ts'] }, 'sibling')
  const sameId = await call('lease_release', { agentId: 'sibling' })
  check('an agent id shared across sessions releases only the local holder', !sameId.isError && !(await paths()).includes('sibling.ts') && (await paths()).includes('same-id-foreign.ts'), sameId)
  await call('lease_take', { paths: ['alpha.ts'] }, 'alpha')
  await call('lease_take', { paths: ['beta.ts'] }, 'beta')
  const all = await call('lease_release', { all: true, agentId: null, paths: null })
  check('all releases the director and every local agent, not another session', !all.isError && all.structuredContent?.released === true && all.structuredContent?.agentId === undefined && JSON.stringify(await paths()) === '["foreign.ts","same-id-foreign.ts"]', all)
  const again = await call('lease_release', { all: true })
  check('all is idempotent with foreign leases present', !again.isError && again.structuredContent?.released === false, again)

  for (const args of [{ paths: 'file.ts' }, { agentId: 4 }, { all: 'true' }]) {
    const result = await call('lease_release', args)
    check('malformed optional input is a tool error, not a transport failure', result.isError === true, result)
  }
  for (const args of [{ paths: null }, { paths: [] }, {}]) {
    const result = await call('lease_take', args)
    check('lease_take still requires nonempty paths', result.isError === true, result)
  }
  for (const args of [{ all: true, agentId: 'alpha' }, { agentId: ' ' }, { paths: ['../outside.ts'] }]) {
    const result = await call('lease_release', args)
    check('handler refusals return isError without breaking the transport', result.isError === true, result)
  }
  check('the transport still serves after malformed calls and handler failures', !(await call('lease_list', {})).isError)
} finally {
  await releaseProjectLeases(root, foreign)
  await releaseProjectLeases(root, { ...foreign, agentId: 'sibling' })
  await releaseProjectLeases(root, projectLeaseHolder(), undefined, { all: true })
  await server.close()
  await client.close()
  rmSync(proofHome, { recursive: true, force: true })
}
console.log(`${checks} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)
