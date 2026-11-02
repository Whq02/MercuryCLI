#!/usr/bin/env bun
import { proofHome } from '../lib/hermetic.ts'
import { mkdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { Database } from 'bun:sqlite'
import { Client, type CallToolResult } from '@modelcontextprotocol/client'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const root = join(proofHome, 'work')
mkdirSync(join(root, '.mercury'), { recursive: true, mode: 0o700 })
const store = join(root, '.mercury', 'project-leases.sqlite')
const { switchSession, setOriginalCwd } = await import('../../src/bootstrap/state.ts')
setOriginalCwd(root)
switchSession('00000000-0000-4000-8000-000000000053' as never, root)
const leases = await import('../../src/services/vulcan/engine/leases.ts')
const { runEngineOp } = await import('../../src/services/vulcan/engine/ops.ts')
const { createMercuryServer, withMercuryLeaseHolder } = await import('../../src/services/mcp/mercuryServer.ts')
const { createLinkedTransportPair } = await import('../../src/services/mcp/InProcessTransport.ts')

let checks = 0
let failures = 0
function check(label: string, ok: boolean, detail: unknown = ''): void {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)?.slice(0, 600)}` : ''}`)
}
const escaped: string[] = []
process.on('uncaughtException', error => { escaped.push(`uncaught: ${String(error)}`) })
process.on('unhandledRejection', reason => { escaped.push(`unhandled: ${String(reason)}`) })

const server = await createMercuryServer()
const client = new Client({ name: 'lease-fault-proof', version: '0' })
const [a, b] = createLinkedTransportPair()
type LeaseCallResult = CallToolResult & { structuredContent?: Record<string, unknown> }
const call = (name: string, args: Record<string, unknown>, agentId?: string): Promise<LeaseCallResult> => withMercuryLeaseHolder(agentId, () => client.callTool({ name, arguments: args })) as Promise<LeaseCallResult>
const textOf = (result: LeaseCallResult): string => (result.content as Array<{ text?: string }>).map(block => block.text ?? '').join('')
const refused = (result: LeaseCallResult, verb: string, words: string): boolean => result.isError === true && textOf(result).startsWith(`${verb} failed: `) && textOf(result).includes(words)
async function everyVerbRefuses(fault: string, words: string): Promise<void> {
  const take = await call('lease_take', { paths: ['src/a.ts'] })
  const list = await call('lease_list', {})
  const release = await call('lease_release', {})
  check(`${fault}: lease_take is a refusal row naming the fault`, refused(take, 'lease_take', words), textOf(take))
  check(`${fault}: lease_list is a refusal row naming the fault`, refused(list, 'lease_list', words), textOf(list))
  check(`${fault}: lease_release is a refusal row naming the fault`, refused(release, 'lease_release', words), textOf(release))
}
async function serviceResumes(after: string): Promise<void> {
  const take = await call('lease_take', { paths: ['src/a.ts'] })
  const list = await call('lease_list', {})
  const release = await call('lease_release', {})
  check(`${after}: the same server takes, lists and releases again`, !take.isError && textOf(take).includes('"ok": true') && !list.isError && list.structuredContent?.total === 1 && !release.isError && release.structuredContent?.released === true, { take: textOf(take).slice(0, 200), list: textOf(list).slice(0, 200), release: textOf(release).slice(0, 200) })
}

try {
  await Promise.all([server.connect(a), client.connect(b)])
  await serviceResumes('before any fault')

  writeFileSync(store, randomBytes(4096))
  await everyVerbRefuses('a store that is not a database', 'not a database')
  rmSync(store)
  await serviceResumes('after the broken store is removed')

  rmSync(store)
  mkdirSync(store)
  await everyVerbRefuses('a directory in the store\'s place', 'project lease storage must be a regular file')
  rmdirSync(store)
  await serviceResumes('after the directory is removed')

  const writer = new Database(store)
  writer.exec('BEGIN IMMEDIATE')
  const started = performance.now()
  const locked = await call('lease_take', { paths: ['src/a.ts'] })
  const waited = performance.now() - started
  check('a store another writer holds is refused after the 5 s busy wait, not left hanging', refused(locked, 'lease_take', 'database is locked') && waited >= 4_000 && waited < 15_000, { text: textOf(locked), waited: Math.round(waited) })
  writer.exec('ROLLBACK')
  writer.close()
  await serviceResumes('after the other writer lets go')

  const seeded = new Database(store)
  seeded.prepare('INSERT INTO leases (path, record) VALUES (?, ?)').run('broken/not-json.ts', 'not json')
  seeded.prepare('INSERT INTO leases (path, record) VALUES (?, ?)').run('broken/no-holder.ts', JSON.stringify({ path: 'broken/no-holder.ts', holder: { sessionId: '', agentId: 'x', pid: 0 }, acquiredAt: 'now' }))
  seeded.close()
  const afterRows = await call('lease_list', {})
  check('rows whose holder cannot be read are dropped by the next operation instead of failing every operation', !afterRows.isError && afterRows.structuredContent?.total === 0, textOf(afterRows).slice(0, 300))
  const retaken = await call('lease_take', { paths: ['broken/not-json.ts'] })
  check('their paths are free again', !retaken.isError && textOf(retaken).includes('"ok": true'), textOf(retaken).slice(0, 200))
  await call('lease_release', {})

  const gone = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  await once(gone, 'close')
  const dead = await leases.takeProjectLeases(root, ['src/a.ts'], { sessionId: 'c0ffee00-0000-4000-8000-000000000003', agentId: 'departed', pid: gone.pid! }).then(() => 'took', error => (error as Error).message)
  check('a holder whose process has ended is refused by name in the engine', dead === 'the lease holder process has ended', dead)
  const viaOp = await runEngineOp('lease_take', { paths: ['../outside.ts'] }, root).then(text => `returned: ${text}`, error => `threw: ${(error as Error).message}`)
  check('the Godot operation road surfaces a bad path as an error the tool turns into "lease_take failed: …"', viaOp === 'threw: lease path is outside the project: ../outside.ts', viaOp)

  const badHolder = await leases.releaseProjectLeases(root, { sessionId: '', agentId: 'x', pid: 0 }).then(() => 'released', error => (error as Error).message)
  check('an untrusted holder identity is refused before the store is touched', badHolder === 'a lease needs a trusted session, agent and process holder', badHolder)

  await serviceResumes('at the end')
  check('no fault escaped the lease road as an uncaught exception or unhandled rejection', escaped.length === 0, escaped)
} finally {
  await leases.releaseProjectLeases(root, leases.projectLeaseHolder(), undefined, { all: true }).catch(() => undefined)
  await server.close()
  await client.close()
  rmSync(proofHome, { recursive: true, force: true })
}
console.log(`${checks} checks, ${failures} failures`)
process.exit(failures ? 1 : 0)
