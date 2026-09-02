#!/usr/bin/env bun
// ============================================================================
//  scripts/sessionStorage/prove-listing-memo.ts — FN-020 row 8: one estate
//  sweep shared among every session-listing surface.
//
//  The class: the tab strip (every boot and every in-place switch), the
// cockpit's solo RECENT lane, /sessions, /sessiontab and /resume each ran
//  loadAllProjectsMessageLogs on their own — one readdir per project
//  directory, one stat per lifetime session file, head-plus-tail reads for
//  the newest rows — and the sweeps co-fired inside one mount window. The
//  progressive loader now single-flights concurrent callers and memoizes a
//  completed result keyed by TRUTH (the projects root's and every project
//  directory's mtime — a birth or a removal in ANY process moves one) for
//  at most 5 s; this process's own title save invalidates explicitly.
//
//    L1  single-flight: three concurrent listings run ONE sweep
//    L2  the memo serves: five listings inside the TTL run no sweep
//    L3  the truth moves: a session file born or removed in a project
//        directory makes the very next listing sweep again
//    L4  the in-process invalidation (the title save's call)
//    L5  the public door rides the memo; callers get fresh row objects
//    L6  wiring — served only on an equal truth stamp inside the TTL, the
//        stamp is root + directory mtimes, the flight is cleared by
//        identity, the sweep body is the one the pool prover pins, the
//        memo carries its stale-registry row
//
//  The instrument is the loader's own census (sweeps · served · joined) —
//  operation-shaped, never a wall clock.
// ============================================================================
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'listing-memo-home-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const ROOT = join(import.meta.dir, '..', '..')

const { getProjectsDir } = await import('../../src/utils/sessionStorage/paths.ts')
const logs = await import('../../src/utils/sessionStorage/logs.ts')
type SessionLogResult = import('../../src/utils/sessionStorage/logs.ts').SessionLogResult

const projectsDir = getProjectsDir()
const P = 6
const PER = 7
const uuidAt = (p: number, i: number): string => `${p.toString(16).padStart(4, '0')}${i.toString(16).padStart(4, '0')}-1111-4111-8111-123456789abc`
const userRow = (id: string, text: string): string =>
  `${JSON.stringify({ type: 'user', uuid: id, sessionId: id, timestamp: new Date().toISOString(), cwd: '/tmp/listing-memo', message: { role: 'user', content: text } })}\n`
mkdirSync(projectsDir, { recursive: true })
for (let p = 0; p < P; p++) {
  const dir = join(projectsDir, `proj-${p}`)
  mkdirSync(dir)
  for (let i = 0; i < PER; i++) {
    const id = uuidAt(p, i)
    writeFileSync(join(dir, `${id}.jsonl`), userRow(id, `prompt ${p}-${i}`))
  }
}
const S = P * PER
const census = logs.listingCensus
const ids = (r: SessionLogResult): string => r.allStatLogs.map(l => String(l.sessionId ?? '')).sort().join(',')
const progressive = (): Promise<SessionLogResult> => logs.loadAllProjectsMessageLogsProgressive()

section('L1 single-flight — concurrent callers share ONE sweep')
{
  const [a, b, c] = await Promise.all([progressive(), progressive(), progressive()])
  check('three concurrent listings ran exactly one sweep (two callers joined it)', census.sweeps === 1 && census.joined === 2, JSON.stringify(census))
  check(`every caller got the whole estate (${S} rows), the same rows`, a.allStatLogs.length === S && ids(a) === ids(b) && ids(b) === ids(c), `${a.allStatLogs.length}`)
  check('each caller holds its own row objects (fresh objects, exactly as a fresh sweep handed them)', a.allStatLogs[0] !== b.allStatLogs[0] && a.allStatLogs[0]!.sessionId === b.allStatLogs[0]!.sessionId)
}

section('L2 the memo serves — unchanged truth inside the TTL')
{
  const before = { ...census }
  for (let i = 0; i < 5; i++) await progressive()
  check('five sequential listings ran no sweep — all served from the memo', census.sweeps === before.sweeps && census.served === before.served + 5, JSON.stringify(census))
  console.log(`  BEFORE (by construction of the replaced loader): every listing = ${P} readdirs + ${S} stats + the newest rows' head+tail reads · AFTER: 1 readdir + ${P} directory stats validate the memo; 0 sweeps`)
}

section('L3 the truth moves — a birth or a removal in ANY process is seen on the next listing')
{
  const sweepsBefore = census.sweeps
  const bornId = uuidAt(2, 99)
  writeFileSync(join(projectsDir, 'proj-2', `${bornId}.jsonl`), userRow(bornId, 'born'))
  const r = await progressive()
  check('a session file born in a project directory makes the next listing sweep again', census.sweeps === sweepsBefore + 1, JSON.stringify(census))
  check('…and the newborn is in the rows', r.allStatLogs.some(l => l.sessionId === bornId) && r.allStatLogs.length === S + 1, `${r.allStatLogs.length}`)
  await progressive()
  check('the listing after that is served again (the new truth memoized)', census.sweeps === sweepsBefore + 1)
  rmSync(join(projectsDir, 'proj-2', `${bornId}.jsonl`))
  const r2 = await progressive()
  check('a removal is seen the same way', census.sweeps === sweepsBefore + 2 && !r2.allStatLogs.some(l => l.sessionId === bornId) && r2.allStatLogs.length === S, `${r2.allStatLogs.length}`)
}

section("L4 this process's own title save invalidates")
{
  const sweepsBefore = census.sweeps
  await progressive()
  check('served before the invalidation', census.sweeps === sweepsBefore)
  logs.invalidateSessionListingMemo()
  await progressive()
  check('the listing after invalidateSessionListingMemo sweeps again', census.sweeps === sweepsBefore + 1)
  const src = readFileSync(join(ROOT, 'src/utils/sessionStorage/logs.ts'), 'utf8')
  check('saveCustomTitle calls the invalidation right after its append', /type: 'custom-title',[\s\S]{0,200}?\}\)\n(?:\s*\/\/[^\n]*\n)*\s*invalidateSessionListingMemo\(\)/.test(src))
}

section('L5 the public door rides the memo; callers get fresh rows')
{
  const sweepsBefore = census.sweeps
  const servedBefore = census.served
  const all = await logs.loadAllProjectsMessageLogs()
  const again = await logs.loadAllProjectsMessageLogs()
  check('loadAllProjectsMessageLogs (the strip, the rail, /resume, /sessiontab) is served by the memo', census.sweeps === sweepsBefore && census.served === servedBefore + 2, JSON.stringify(census))
  check('the two answers agree row for row', all.length > 0 && all.length === again.length && all.every((l, i) => l.sessionId === again[i]!.sessionId && l.modified.getTime() === again[i]!.modified.getTime()), `${all.length}`)
  if (all.length > 0) {
    all[0]!.value = 999
    const third = await logs.loadAllProjectsMessageLogs()
    check('a caller mutating its rows never reaches the memo (fresh objects per listing)', third[0]!.value !== 999, String(third[0]!.value))
  }
}

section('L6 wiring')
{
  const src = readFileSync(join(ROOT, 'src/utils/sessionStorage/logs.ts'), 'utf8')
  check('the memo is served only on an equal truth stamp inside the TTL', /memo\.key === key && memo\.truth === truth && Date\.now\(\) - memo\.at < LISTING_MEMO_TTL_MS/.test(src) && /const LISTING_MEMO_TTL_MS = 5_000/.test(src))
  check("the truth stamp is the root's mtime plus every project directory's mtime", /const root = await stat\(projectsDir\)[\s\S]{0,400}?\(await stat\(dir\)\)\.mtimeMs/.test(src))
  check('the running sweep is shared (single-flight) and cleared by identity', /listingFlight !== null && listingFlight\.key === key/.test(src) && /listingFlight\.promise === promise\) listingFlight = null/.test(src))
  check('the sweep body is the one the pool prover pins (mapWithConcurrency over getSessionFilesLite)', /mapWithConcurrency\(projectDirs, discoveryPoolWidth\(\), projectDir =>\n\s*getSessionFilesLite\(projectDir, limit\),/.test(src))
  const registry = readFileSync(join(ROOT, 'scripts/staleness/prove-stale-registry.ts'), 'utf8')
  check('the memo carries its stale-registry row (keyed-by-truth)', registry.includes('src/utils/sessionStorage/logs.ts :: listingMemo :: keyed-by-truth'))
}

console.log(failures === 0 ? '\n✅ ALL LISTING-MEMO PROOFS PASS' : `\n❌ ${failures} LISTING-MEMO PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
