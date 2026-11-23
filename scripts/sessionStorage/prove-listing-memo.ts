#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const { getProjectsDir } = await import('../../src/sessions/transcripts/paths.ts')
const logs = await import('../../src/sessions/transcripts/sessionListings.ts')
type SessionPage = import('../../src/sessions/transcripts/sessionListings.ts').SessionPage

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
const ids = (r: SessionPage): string => r.allStatLogs.map(l => String(l.sessionId ?? '')).sort().join(',')
const progressive = (): Promise<SessionPage> => logs.listSessionsAcrossProjectsProgressive()

section('L1 single-flight — concurrent callers share ONE sweep')
{
  const [a, b, c] = await Promise.all([progressive(), progressive(), progressive()])
  check('three concurrent listings ran exactly one sweep (two callers joined it)', census.sweeps === 1 && census.joined === 2, `${JSON.stringify(census)}; fix listSessionsAcrossProjectsProgressive in src/sessions/transcripts/sessionListings.ts so concurrent callers join one sweep`)
  check(`every caller got the whole estate (${S} rows), the same rows`, a.allStatLogs.length === S && ids(a) === ids(b) && ids(b) === ids(c), `${a.allStatLogs.length}; fix listSessionsAcrossProjectsProgressive in src/sessions/transcripts/sessionListings.ts so every joined caller gets all rows`)
  check('each caller holds its own row objects (fresh objects, exactly as a fresh sweep handed them)', a.allStatLogs[0] !== b.allStatLogs[0] && a.allStatLogs[0]!.sessionId === b.allStatLogs[0]!.sessionId, 'fix listSessionsAcrossProjectsProgressive in src/sessions/transcripts/sessionListings.ts to hand each caller its own copy of the rows')
}

section('L2 the memo serves — unchanged truth inside the TTL')
{
  const before = { ...census }
  for (let i = 0; i < 5; i++) await progressive()
  check('five sequential listings ran no sweep — all served from the memo', census.sweeps === before.sweeps && census.served === before.served + 5, `${JSON.stringify(census)}; fix the memo check in listSessionsAcrossProjectsProgressive in src/sessions/transcripts/sessionListings.ts so an unchanged estate is served without a sweep`)
  console.log(`  BEFORE (by construction of the replaced loader): every listing = ${P} readdirs + ${S} stats + the newest rows' head+tail reads · AFTER: 1 readdir + ${P} directory stats validate the memo; 0 sweeps`)
}

section('L3 the truth moves — a birth or a removal in ANY process is seen on the next listing')
{
  const sweepsBefore = census.sweeps
  const bornId = uuidAt(2, 99)
  writeFileSync(join(projectsDir, 'proj-2', `${bornId}.jsonl`), userRow(bornId, 'born'))
  const r = await progressive()
  check('a session file born in a project directory makes the next listing sweep again', census.sweeps === sweepsBefore + 1, `${JSON.stringify(census)}; fix the memo validation in src/sessions/transcripts/sessionListings.ts so a new file in a project directory forces a sweep`)
  check('…and the newborn is in the rows', r.allStatLogs.some(l => l.sessionId === bornId) && r.allStatLogs.length === S + 1, `${r.allStatLogs.length}; fix listSessionsAcrossProjectsProgressive in src/sessions/transcripts/sessionListings.ts to include the newborn session`)
  await progressive()
  check('the listing after that is served again (the new truth memoized)', census.sweeps === sweepsBefore + 1, `${JSON.stringify(census)}; fix listSessionsAcrossProjectsProgressive in src/sessions/transcripts/sessionListings.ts to memoize the sweep it just ran`)
  rmSync(join(projectsDir, 'proj-2', `${bornId}.jsonl`))
  const r2 = await progressive()
  check('a removal is seen the same way', census.sweeps === sweepsBefore + 2 && !r2.allStatLogs.some(l => l.sessionId === bornId) && r2.allStatLogs.length === S, `${r2.allStatLogs.length}; fix the memo validation in src/sessions/transcripts/sessionListings.ts so a removed session file forces a sweep`)
}

section("L4 this process's own title save invalidates")
{
  const sweepsBefore = census.sweeps
  await progressive()
  check('served before the invalidation', census.sweeps === sweepsBefore, `${JSON.stringify(census)}; fix listSessionsAcrossProjectsProgressive in src/sessions/transcripts/sessionListings.ts to serve from the memo`)
  logs.invalidateSessionListingMemo()
  await progressive()
  check('the listing after invalidateSessionListingMemo sweeps again', census.sweeps === sweepsBefore + 1, `${JSON.stringify(census)}; fix invalidateSessionListingMemo in src/sessions/transcripts/sessionListings.ts to drop the memo`)
  const id = uuidAt(0, 0)
  const beforeSave = census.sweeps
  await logs.saveCustomTitle(id as never, 'renamed', join(projectsDir, 'proj-0', `${id}.jsonl`))
  const afterSave = await progressive()
  check('saveCustomTitle calls the invalidation right after its append', census.sweeps === beforeSave + 1 && afterSave.logs.some(row => row.sessionId === id && row.customTitle === 'renamed'), `${JSON.stringify(census)}; fix saveCustomTitle in src/sessions/transcripts/sessionListings.ts to call invalidateSessionListingMemo after its append`)
}

section('L5 the public door rides the memo; callers get fresh rows')
{
  const sweepsBefore = census.sweeps
  const servedBefore = census.served
  const all = await logs.listSessionsAcrossProjects()
  const again = await logs.listSessionsAcrossProjects()
  check('listSessionsAcrossProjects (the rail, /resume, /sessiontab) is served by the memo', census.sweeps === sweepsBefore && census.served === servedBefore + 2, `${JSON.stringify(census)}; fix listSessionsAcrossProjects in src/sessions/transcripts/sessionListings.ts to read through the memo`)
  check('the two answers agree row for row', all.length > 0 && all.length === again.length && all.every((l, i) => l.sessionId === again[i]!.sessionId && l.modified.getTime() === again[i]!.modified.getTime()), `${all.length}; fix listSessionsAcrossProjects in src/sessions/transcripts/sessionListings.ts so repeated listings return the same rows`)
  if (all.length > 0) {
    all[0]!.value = 999
    const third = await logs.listSessionsAcrossProjects()
    check('a caller mutating its rows never reaches the memo (fresh objects per listing)', third[0]!.value !== 999, `${String(third[0]!.value)}; fix listSessionsAcrossProjects in src/sessions/transcripts/sessionListings.ts to return copies of the memoized rows`)
  }
}


console.log(failures === 0 ? '\n✅ ALL LISTING-MEMO PROOFS PASS' : `\n❌ ${failures} LISTING-MEMO PROOF(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
