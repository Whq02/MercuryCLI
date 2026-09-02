#!/usr/bin/env bun
// prove-name-collision-fence — two MCP servers folding to one tool prefix
// (field card FC-023). Server names differing only outside [A-Za-z0-9_-]
// (col.one · col_one) normalise to ONE mcp__<server>__ prefix: both spawned,
// both reported connected, the second one's whole namespace silently
// dropped at the name-dedupe, and an --allowed-tools grant written for one
// name was executed by the other. The connection walk now fences the
// collision UP FRONT: the first name (config precedence) keeps the prefix;
// every later collider is reported FAILED with a reason naming the
// collision and the winner, and is never spawned.
//
//   §1 the fence: one connected, one failed-with-reason, nothing silent.
//   §2 the control: distinct names both connect.
//   §3 ONE fence owner (release-hardening audit rank 35): the pure verdict
//      the walk reads — survivors in precedence order, colliders with the
//      reason and the winner, '__proto__'-safe.
//   §4 the headless batch reads the same verdict BEFORE it spawns anything
//      and seats a collider as a failed roster row (main.tsx source pin —
//      the print path's batch is not importable without booting the CLI).
//
//  PROVE_SRC names another checkout's src (the A/B control: §3 and §4 read
//  red at the pre-fix tree — no fence owner, a headless batch that spawns
//  both colliders).
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'collision-fence-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { getMcpToolsCommandsAndResources, fenceMcpPrefixCollisions } = await import(join(SRC, 'services/mcp/client.ts'))

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
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
  check('both configured servers are REPORTED (nothing silent)', first !== undefined && second !== undefined, JSON.stringify(reports))
  check('the first name keeps the prefix (connected)', first?.type === 'connected', JSON.stringify(first))
  check('the collider is FAILED, never spawned as a ghost', second?.type === 'failed', JSON.stringify(second))
  check(
    'and the reason names the collision and the winner',
    /collid/i.test(second?.error ?? '') && (second?.error ?? '').includes('col.one'),
    second?.error?.slice(0, 160),
  )
}

section('§2 THE CONTROL')
{
  const reports = await drive(['alpha_srv', 'beta_srv'])
  check(
    'distinct names both connect',
    reports.filter(r => r.type === 'connected').length === 2,
    JSON.stringify(reports.map(r => [r.name, r.type])),
  )
}

section('§3 ONE FENCE OWNER (rank 35)')
{
  const fence = fenceMcpPrefixCollisions as
    | ((configs: Record<string, unknown>) => { survivors: Record<string, unknown>; collided: Array<{ name: string; winner: string; error: string }> })
    | undefined
  check('the fence is exported for every connect road', typeof fence === 'function')
  if (fence) {
    const verdict = fence({ 'col.one': { ...stdioConfig }, col_one: { ...stdioConfig }, 'github mcp': { ...stdioConfig }, github_mcp: { ...stdioConfig }, plain: { ...stdioConfig } })
    check('survivors keep the first name per folded prefix, in precedence order', Object.keys(verdict.survivors).join(',') === 'col.one,github mcp,plain', Object.keys(verdict.survivors).join(','))
    check('every later collider is named with its winner', verdict.collided.map(c => `${c.name}<${c.winner}`).join(',') === 'col_one<col.one,github_mcp<github mcp', JSON.stringify(verdict.collided.map(c => [c.name, c.winner])))
    check('the reason names the collision, the folded prefix and the winner', verdict.collided.every(c => /collid/i.test(c.error) && c.error.includes(`'${c.winner}'`) && c.error.includes('mcp__')), verdict.collided[0]?.error)
    // Object.fromEntries defines an OWN '__proto__' key (a literal would set
    // the prototype instead) — the user-supplied-name shape the fence meets.
    const proto = fence(Object.fromEntries([['__proto__', { ...stdioConfig }], ['safe', { ...stdioConfig }]]) as never)
    check("a '__proto__' server name is an own survivor key, never the prototype", Object.keys(proto.survivors).join(',') === '__proto__,safe' && Object.getPrototypeOf(proto.survivors) === null, Object.keys(proto.survivors).join(','))
    const walk = await drive(['col.one', 'col_one'])
    check('the interactive walk reports the fence verdict verbatim', walk.find(r => r.name === 'col_one')?.error === verdict.collided[0]?.error)
  }
}

section('§4 THE HEADLESS BATCH READS THE SAME VERDICT (rank 35)')
{
  const main = readFileSync(join(SRC, 'main.tsx'), 'utf8')
  const batchStart = main.indexOf('async function connectMcpBatch(')
  const batchEnd = main.indexOf('function dedupeByName', batchStart)
  const batch = batchStart >= 0 && batchEnd > batchStart ? main.slice(batchStart, batchEnd) : ''
  check('the print-mode batch exists', batch.length > 0)
  const fenceAt = batch.indexOf('fenceMcpPrefixCollisions(configs)')
  const partitionAt = batch.indexOf('partitionMcpConfigsByMembership(survivors)')
  check('the batch fences BEFORE the membership partition, on the survivors', fenceAt >= 0 && partitionAt > fenceAt, `fence@${fenceAt} partition@${partitionAt}`)
  check('a collider is seated as a failed roster row carrying the reason', batch.includes("...collided.map(({ name, config, error }) => ({ name, type: 'failed' as const, config, error }))"))
  const dialAt = batch.indexOf('connectToServer(name, config)')
  check('the fence runs before anything is dialed', dialAt > fenceAt, `dial@${dialAt}`)
  check('the fence is a static import from the one owner', /import \{[^}]*fenceMcpPrefixCollisions[^}]*\} from '\.\/services\/mcp\/client\.js'/s.test(main))
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-name-collision-fence: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-name-collision-fence: all green')
// The live stdio connections hold the event loop open — the verdict is
// printed; exit hard.
process.exit(0)
