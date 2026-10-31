#!/usr/bin/env bun
// gate-watch: src/substrate/stateLifecycle.ts src/utils/spawnLedger.ts src/extensions/paths.ts src/entrypoints/cli.tsx src/extensions/bundled/index.ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'retired-build-debris-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_DAEMON_DIR
delete process.env.MERCURY_VERSIONS_DIR
delete process.env.MERCURY_EXTENSIONS_DIR
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const lifecycle = await import('../../src/substrate/stateLifecycle.ts')
const { bashAuditPath } = await import('../../src/utils/spawnLedger.ts')
const { getBundledDir } = await import('../../src/extensions/paths.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-31T12:00:00Z')
const backdate = (p: string, ageMs: number): void => {
  const t = (NOW - ageMs) / 1000
  utimesSync(p, t, t)
}
const plantDir = (p: string, files: Record<string, string> = { 'entry.bin': 'x' }): void => {
  mkdirSync(p, { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(p, name), body)
}
const manifest = (dir: string, version: string, node: string): void => plantDir(dir, { 'manifest.json': JSON.stringify({ schema: 2, name: 'mercury', version, runtime: { vendored: true, version: node } }) })

section('§0 the installed builds the pruners read: this process, versions/*, runtime/builds/*')
manifest(join(HOME, 'versions', '1.0.0-beta.41'), '1.0.0-beta.41', '24.20.0')
manifest(join(HOME, 'runtime', 'builds', '94b0c74b14c1-e9df8521'), '1.0.1', '24.22.1')
mkdirSync(join(HOME, 'runtime', 'builds', '.staging-0df1181a'), { recursive: true })
writeFileSync(join(HOME, 'versions', 'current.txt'), '1.0.0-beta.41\n')
{
  const facts = await lifecycle.installedBuildFacts()
  check('the versions this home carries: this build, the versions/ install, the runtime build', [...facts.versions].sort().join(',') === '1.0.0,1.0.0-beta.41,1.0.1', [...facts.versions].join(','))
  check('the Node versions: this process plus each installed build\'s vendored node', facts.nodeVersions.has(process.version) && facts.nodeVersions.has('v24.20.0') && facts.nodeVersions.has('v24.22.1') && facts.nodeVersions.size === new Set([process.version, 'v24.20.0', 'v24.22.1']).size, [...facts.nodeVersions].join(','))
}

section('§1 the compile cache: a Node version no installed build carries goes; the rest, and anything that is not a Node cache folder, stays')
const cache = join(HOME, 'compile-cache')
const retired = join(cache, 'v24.21.0-arm64-964aae3f-501')
const retiredToo = join(cache, 'v24.17.0-arm64-7d232dbd-501')
const vendored = join(cache, 'v24.22.1-arm64-964aae3f-501')
const olderInstall = join(cache, 'v24.20.0-arm64-964aae3f-501')
const own = join(cache, `${process.version}-arm64-964aae3f-501`)
const stranger = join(cache, 'my-notes')
plantDir(retired, { 'a.cache': 'x'.repeat(2048), 'b.cache': 'y' })
plantDir(retiredToo)
plantDir(vendored)
plantDir(olderInstall)
plantDir(own)
plantDir(stranger, { 'keep.txt': 'not ours to judge' })
writeFileSync(join(cache, 'README'), 'a file beside the folders')

section('§2 bundled extensions: a version no installed build carries goes; this build\'s, an installed build\'s and a fresh stage folder stay')
const bundled = getBundledDir()
const staleCraft = join(bundled, 'filmcraft', '1.0.0-beta.42-bb11799c143363f0')
const staleMedia = join(bundled, 'mercury-media', '1.0.0-rc.1-76bb3e9a47b15b6f')
const current = join(bundled, 'filmcraft', '1.0.0-78fc06294b6bbaef')
const installed = join(bundled, 'filmcraft', '1.0.0-beta.41-76bb3e9a47b15b6f')
const runtimeBuild = join(bundled, 'photocraft', '1.0.1-5724e874a8205b01')
const oldStage = join(bundled, 'filmcraft', '1.0.0-78fc06294b6bbaef.stage-3f6a2c1e-8d1b-4d7a-9a0c-0b1e2f3a4b5c')
const freshStage = join(bundled, 'filmcraft', '1.0.0-78fc06294b6bbaef.stage-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
const oddFolder = join(bundled, 'filmcraft', 'notes')
for (const dir of [staleCraft, staleMedia, current, installed, runtimeBuild, oldStage, freshStage]) plantDir(dir, { 'mercury-extension.json': '{}' })
plantDir(oddFolder, { 'todo.txt': 'kept' })
backdate(oldStage, 2 * DAY)
writeFileSync(join(bundled, 'filmcraft', 'loose.txt'), 'a loose file')

section('§3 the Bash audit ledger: a 16 MB live file is renamed whole; the rows stay readable; the newest four rotated files stay')
const live = bashAuditPath()
mkdirSync(join(live, '..'), { recursive: true })
const row = (i: number): string => JSON.stringify({ ts: '2026-10-31T00:00:00.000Z', spawnedBy: 'crewmate:x#1', pid: 1, cwd: '/p', command: `echo ${i} ${'x'.repeat(200)}`, exitCode: 0, interrupted: false }) + '\n'
const rows: string[] = []
let bytes = 0
for (let i = 0; bytes < lifecycle.BASH_AUDIT_ROTATE_BYTES + 4096; i++) {
  const line = row(i)
  rows.push(line)
  bytes += line.length
}
writeFileSync(live, rows.join(''))
const daemonDir = join(live, '..')
const olderRotated = ['2026-10-01T00-00-00Z', '2026-10-05T00-00-00Z', '2026-10-10T00-00-00Z', '2026-10-15T00-00-00Z', '2026-10-20T00-00-00Z'].map(stamp => join(daemonDir, `bash-audit.${stamp}.jsonl`))
for (const p of olderRotated) writeFileSync(p, row(0))
writeFileSync(join(daemonDir, 'spawn-ledger.jsonl'), row(1))
writeFileSync(join(daemonDir, 'daemon.log'), 'a log line\n')

section('§4 one lifecycle pass')
await lifecycle._resetLifecycleForProofs()
const pass = await lifecycle.runLifecyclePass({ budgetMs: 60_000, maxRemovals: 1000, now: () => NOW })
const receipt = (id: string) => pass.receipts.find(r => r.id === id)
check('the pass completed the cycle with no failure', pass.cycleComplete && pass.cycleFailures === 0, JSON.stringify(pass.receipts.filter(r => r.failures.length > 0)))
check('the three classes ran and finished', ['compile-cache-retired-nodes', 'bundled-extension-folders', 'bash-audit-ledger'].every(id => receipt(id)?.done === true), pass.receipts.map(r => `${r.id}:${r.done}`).join(' '))

check('compile cache: the two retired Node versions are gone', !existsSync(retired) && !existsSync(retiredToo))
check('compile cache: the vendored node of the runtime build, the older install\'s node and this process\'s node stay', existsSync(vendored) && existsSync(olderInstall) && existsSync(own))
check('compile cache: a folder that is not a Node cache folder and a loose file stay', existsSync(join(stranger, 'keep.txt')) && existsSync(join(cache, 'README')))
check('compile cache receipt: 5 visited, 2 removed, 3 retained', receipt('compile-cache-retired-nodes')?.visited === 5 && receipt('compile-cache-retired-nodes')?.removed === 2 && receipt('compile-cache-retired-nodes')?.retained === 3, JSON.stringify(receipt('compile-cache-retired-nodes')))

check('bundled: the beta.42 and rc.1 folders are gone', !existsSync(staleCraft) && !existsSync(staleMedia))
check('bundled: this build\'s folder, the installed beta.41 folder and the runtime build\'s 1.0.1 folder stay', existsSync(current) && existsSync(installed) && existsSync(runtimeBuild))
check('bundled: a stage folder two days old is gone, a fresh one stays', !existsSync(oldStage) && existsSync(freshStage))
check('bundled: a folder without a digest and a loose file stay', existsSync(join(oddFolder, 'todo.txt')) && existsSync(join(bundled, 'filmcraft', 'loose.txt')))
check('bundled receipt: 7 visited, 3 removed, 4 retained', receipt('bundled-extension-folders')?.visited === 7 && receipt('bundled-extension-folders')?.removed === 3 && receipt('bundled-extension-folders')?.retained === 4, JSON.stringify(receipt('bundled-extension-folders')))

const rotatedNow = join(daemonDir, lifecycle.bashAuditRotatedName(NOW))
check('audit: the live file was renamed whole to its stamped sibling', !existsSync(live) && existsSync(rotatedNow) && readFileSync(rotatedNow, 'utf8') === rows.join(''), rotatedNow)
check('audit: the rotated rows parse as the same JSONL the live file held', readFileSync(rotatedNow, 'utf8').trimEnd().split('\n').every(line => JSON.parse(line).command.startsWith('echo ')))
const remaining = readdirSync(daemonDir).filter(name => /^bash-audit\./.test(name)).sort()
check('audit: the newest four rotated files stay (the fresh one and the three newest planted), the two oldest go', remaining.join(',') === ['bash-audit.2026-10-10T00-00-00Z.jsonl', 'bash-audit.2026-10-15T00-00-00Z.jsonl', 'bash-audit.2026-10-20T00-00-00Z.jsonl', `bash-audit.${lifecycle.bashAuditRotatedName(NOW).slice('bash-audit.'.length)}`].sort().join(','), remaining.join(','))
check('audit: the spawn ledger and the daemon log beside it are untouched', existsSync(join(daemonDir, 'spawn-ledger.jsonl')) && existsSync(join(daemonDir, 'daemon.log')))
check('audit receipt: 7 visited (the live file and six rotated), 2 removed, 4 retained', receipt('bash-audit-ledger')?.visited === 7 && receipt('bash-audit-ledger')?.removed === 2 && receipt('bash-audit-ledger')?.retained === 4, JSON.stringify(receipt('bash-audit-ledger')))

section('§5 a second pass finds nothing more to do; a small live file is left alone')
writeFileSync(live, row(7))
await lifecycle._resetLifecycleForProofs()
const again = await lifecycle.runLifecyclePass({ budgetMs: 60_000, maxRemovals: 1000, now: () => NOW + 1000 })
check('nothing more is removed by the three classes', ['compile-cache-retired-nodes', 'bundled-extension-folders', 'bash-audit-ledger'].every(id => again.receipts.find(r => r.id === id)?.removed === 0), JSON.stringify(again.receipts.map(r => [r.id, r.removed])))
check('a live audit file under the size stays where it is, whole', existsSync(live) && statSync(live).size === row(7).length)

section('§6 the pruners run off the housekeeping cycle, never at boot')
{
  const cli = readFileSync(join(import.meta.dir, '../../src/entrypoints/cli.tsx'), 'utf8')
  const housekeeping = readFileSync(join(import.meta.dir, '../../src/utils/backgroundHousekeeping.ts'), 'utf8')
  check('the boot path that enables the compile cache prunes nothing', !cli.includes('stateLifecycle') && !cli.includes('compile-cache-retired'))
  check('the lifecycle pass runs from the housekeeping cycle, which waits for a quiet minute after the first frame', housekeeping.includes('runLifecyclePass') && housekeeping.includes('getLastInteractionTime() > seams.now() - 1000 * 60'))
}

rmSync(HOME, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-retired-build-debris: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-retired-build-debris: all green')
