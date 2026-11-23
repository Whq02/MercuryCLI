#!/usr/bin/env bun
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'collision-fence-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { getMcpToolsCommandsAndResources, fenceMcpPrefixCollisions } = await import(join(SRC, 'integrations/mcp/client.ts'))

let failures = 0
const check = (label: string, cond: boolean, detail = '', hint = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const FIXTURE = join(import.meta.dir, '_fixture-stdio-server.mjs')
const stdioConfig = { type: 'stdio' as const, command: process.execPath, args: [FIXTURE], scope: 'local' as const }

type Report = { name: string; type: string; error?: string }
const drive = async (names: string[]): Promise<Report[]> => {
  const reports: Report[] = []
  const configs = Object.fromEntries(names.map(n => [n, { ...stdioConfig }]))
  await getMcpToolsCommandsAndResources(report => {
    const client = (report as { client: { name: string; type: string; error?: string } }).client
    reports.push({ name: client.name, type: client.type, ...(client.error !== undefined ? { error: client.error } : {}) })
  }, configs as never)
  return reports
}

section('§1 THE FENCE')
{
  const reports = await drive(['col.one', 'col_one'])
  const first = reports.find(r => r.name === 'col.one')
  const second = reports.find(r => r.name === 'col_one')
  check('both configured servers are REPORTED (nothing silent)', first !== undefined && second !== undefined, JSON.stringify(reports), 'getMcpToolsCommandsAndResources in src/integrations/mcp/client.ts must report every configured server, including a fenced one')
  check('the first name keeps the prefix (connected)', first?.type === 'connected', JSON.stringify(first), 'the first server must connect: check scripts/mcp/_fixture-stdio-server.mjs starts and fenceMcpPrefixCollisions in src/integrations/mcp/client/bulkParts.ts keeps the first name')
  check('the collider is FAILED, never spawned as a ghost', second?.type === 'failed', JSON.stringify(second), 'fenceMcpPrefixCollisions in src/integrations/mcp/client/bulkParts.ts must fail the later server whose prefix folds to the same name')
  check(
    'and the reason names the collision and the winner',
    /collid/i.test(second?.error ?? '') && (second?.error ?? '').includes('col.one'),
    second?.error?.slice(0, 160),
    'the error built in fenceMcpPrefixCollisions (src/integrations/mcp/client/bulkParts.ts) must say collision and name the winning server',
  )
}

section('§2 THE CONTROL')
{
  const reports = await drive(['alpha_srv', 'beta_srv'])
  check(
    'distinct names both connect',
    reports.filter(r => r.type === 'connected').length === 2,
    JSON.stringify(reports.map(r => [r.name, r.type])),
    'servers with distinct prefixes must not be fenced: check fenceMcpPrefixCollisions in src/integrations/mcp/client/bulkParts.ts and the fixture server',
  )
}

section('§3 ONE FENCE OWNER (rank 35)')
{
  const fence = fenceMcpPrefixCollisions as
    | ((configs: Record<string, unknown>) => { survivors: Record<string, unknown>; collided: Array<{ name: string; winner: string; error: string }> })
    | undefined
  check('the fence is exported for every connect road', typeof fence === 'function', '', 'export fenceMcpPrefixCollisions from src/integrations/mcp/client.ts')
  if (fence) {
    const verdict = fence({ 'col.one': { ...stdioConfig }, col_one: { ...stdioConfig }, 'github mcp': { ...stdioConfig }, github_mcp: { ...stdioConfig }, plain: { ...stdioConfig } })
    check('survivors keep the first name per folded prefix, in precedence order', Object.keys(verdict.survivors).join(',') === 'col.one,github mcp,plain', Object.keys(verdict.survivors).join(','), 'fenceMcpPrefixCollisions in src/integrations/mcp/client/bulkParts.ts must keep the first name per folded prefix in input order')
    check('every later collider is named with its winner', verdict.collided.map(c => `${c.name}<${c.winner}`).join(',') === 'col_one<col.one,github_mcp<github mcp', JSON.stringify(verdict.collided.map(c => [c.name, c.winner])), 'fenceMcpPrefixCollisions in src/integrations/mcp/client/bulkParts.ts must list each later collider with its winner')
    check('the reason names the collision, the folded prefix and the winner', verdict.collided.every(c => /collid/i.test(c.error) && c.error.includes(`'${c.winner}'`) && c.error.includes('mcp__')), verdict.collided[0]?.error, 'the error text built in fenceMcpPrefixCollisions (src/integrations/mcp/client/bulkParts.ts) must say collision and carry the folded mcp__ prefix and the winner name in quotes')
    const proto = fence(Object.fromEntries([['__proto__', { ...stdioConfig }], ['safe', { ...stdioConfig }]]) as never)
    check("a '__proto__' server name is an own survivor key, never the prototype", Object.keys(proto.survivors).join(',') === '__proto__,safe' && Object.getPrototypeOf(proto.survivors) === null, Object.keys(proto.survivors).join(','), 'fenceMcpPrefixCollisions in src/integrations/mcp/client/bulkParts.ts must build survivors as a null-prototype object so a __proto__ name stays an own key')
    const walk = await drive(['col.one', 'col_one'])
    check('the interactive walk reports the fence verdict verbatim', walk.find(r => r.name === 'col_one')?.error === verdict.collided[0]?.error, '', 'getMcpToolsCommandsAndResources in src/integrations/mcp/client.ts must report the error from fenceMcpPrefixCollisions unchanged')
  }
}


rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-name-collision-fence: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-name-collision-fence: all green')
process.exit(0)
