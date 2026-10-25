#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'sessions-delete-home-')))
const PROJ = realpathSync(mkdtempSync(join(tmpdir(), 'sessions-delete-proj-')))
const DAEMON = join(HOME, 'daemon')
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DAEMON_DIR = DAEMON
mkdirSync(DAEMON, { recursive: true })
process.chdir(PROJ)

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 700)}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const ROOT = resolve(import.meta.dir, '..', '..')
const source = (relative: string): string => readFileSync(join(ROOT, relative), 'utf8')

const { getProjectDir, getProjectsDir } = await import('../../src/utils/sessionStorage/paths.ts')
const door = await import('../../src/utils/sessionStorage/transcriptPruneDoor.ts')
const verb = await import('../../src/cli/sessionsVerb.ts').catch(() => null)

const STORE = getProjectDir(PROJ)
const OTHER_STORE = join(getProjectsDir(), '-other-project')
mkdirSync(STORE, { recursive: true })
mkdirSync(OTHER_STORE, { recursive: true })
const ids = {
  named: '11111111-1111-4111-8111-111111111111',
  sibling: '22222222-2222-4222-8222-222222222222',
  elsewhere: '33333333-3333-4333-8333-333333333333',
  live: '44444444-4444-4444-8444-444444444444',
  parked: '55555555-5555-4555-8555-555555555555',
  absent: '99999999-9999-4999-8999-999999999999',
}
const transcriptLine = (sessionId: string): string =>
  JSON.stringify({ type: 'user', sessionId, uuid: `${sessionId}-u1`, timestamp: '2026-10-01T00:00:00.000Z', message: { role: 'user', content: 'hello' } }) + '\n'
const seed = (store: string, sessionId: string, sidecars = true): string => {
  const path = join(store, `${sessionId}.jsonl`)
  writeFileSync(path, transcriptLine(sessionId).repeat(40))
  if (sidecars) {
    writeFileSync(join(store, `${sessionId}.receipts.jsonl`), '{"kind":"receipt"}\n')
    writeFileSync(`${path}.resume-snapshot.json`, JSON.stringify({ snapshot: true }).repeat(200))
    mkdirSync(join(store, sessionId, 'subagents'), { recursive: true })
    writeFileSync(join(store, sessionId, 'subagents', 'agent-1.jsonl'), '{"type":"user"}\n')
    writeFileSync(join(store, `${sessionId}.cast`), 'recording\n')
  }
  return path
}
const namedPath = seed(STORE, ids.named)
const siblingPath = seed(STORE, ids.sibling)
const elsewherePath = seed(OTHER_STORE, ids.elsewhere)
const livePath = seed(STORE, ids.live, false)
const parkedPath = seed(STORE, ids.parked, false)
writeFileSync(join(DAEMON, 'concourse-workers.json'), JSON.stringify({
  version: 1,
  workers: {
    'concourse-w1': { schema: 1, runnerId: 'concourse-w1', sessionId: ids.live, workspaceId: PROJ, isolation: 'shared', modelKey: 'fixture-model', startedAt: Date.now() },
    'concourse-w2': { schema: 1, runnerId: 'concourse-w2', sessionId: ids.parked, workspaceId: PROJ, isolation: 'shared', modelKey: 'fixture-model', startedAt: Date.now(), parkedAt: Date.now() },
    'concourse-w3': { schema: 1, runnerId: 'concourse-w3', sessionId: ids.sibling, workspaceId: PROJ, isolation: 'shared', modelKey: 'fixture-model', startedAt: Date.now() - 5000, endedAt: Date.now() - 1000 },
  },
}))
const listing = (dir: string): string[] => readdirSync(dir, { recursive: true }).map(String).sort()

type Run = { rc: number; out: string[]; err: string[]; asked: string[] }
const run = async (given: string, options: { yes?: boolean } = {}, interactive = false, answer = false): Promise<Run> => {
  const result: Run = { rc: -1, out: [], err: [], asked: [] }
  if (verb === null) return result
  result.rc = await verb.sessionsDeleteCli(given, options, {
    out: line => result.out.push(line),
    err: line => result.err.push(line),
    interactive,
    ask: async question => {
      result.asked.push(question)
      return answer
    },
  })
  return result
}
const text = (r: Run): string => [...r.out, ...r.err].join('\n')

section('§0 the verb exists and rides the one delete door')
{
  check('the verb module exists (src/cli/sessionsVerb.ts)', verb !== null)
  check('main.tsx registers `sessions delete <id>` with --yes', /\.command\('sessions'\)/.test(source('src/main.tsx')) && /\.command\('delete <id>'\)/.test(source('src/main.tsx')) && /option\('--yes'/.test(source('src/main.tsx')))
  check('the verb deletes through operatorPruneTranscripts and never unlinks on its own', verb !== null && source('src/cli/sessionsVerb.ts').includes('operatorPruneTranscripts(') && !/unlinkSync\(|rmSync\(|\.unlink\(|\brm\(/.test(source('src/cli/sessionsVerb.ts')))
  check('the door offers a named session without an age window (buildSessionDeleteOffer)', typeof door.buildSessionDeleteOffer === 'function')
  check('AUTOMATION.md names the verb in the headless section', /`mercury sessions delete <id>`/.test(source('docs/AUTOMATION.md')))
  for (const file of ['assets/completions/mercury.bash', 'assets/completions/_mercury', 'assets/completions/mercury.fish']) {
    check(`${file} completes the sessions verb`, /\bsessions\b/.test(source(file)), file)
  }
}

section('§1 refusals: a live session, a parked session, an unknown id, a non-id, no terminal without --yes')
{
  const before = listing(STORE)
  const live = await run(ids.live, { yes: true })
  check('a session the daemon hosts now is refused with the reason', live.rc === 1 && /is live/.test(text(live)) && /the daemon/.test(text(live)), text(live))
  check('…and its transcript stays', existsSync(livePath))
  const parked = await run(ids.parked, { yes: true })
  check('a parked session (hosted, not ended) is refused too', parked.rc === 1 && /is live/.test(text(parked)) && existsSync(parkedPath), text(parked))
  const unknown = await run(ids.absent, { yes: true })
  check('an unknown id is refused with the roster hint', unknown.rc === 1 && /No saved session 99999999-9999-4999-8999-999999999999/.test(text(unknown)) && /roster/.test(text(unknown)) && /\/sessions/.test(text(unknown)), text(unknown))
  for (const given of ['', 'latest', '../x.jsonl', `${STORE}/${ids.named}.jsonl`, '11111111-1111-4111-8111-11111111111', "'; rm -rf /", 'C:\\Users\\x\\.mercury\\projects\\p\\11111111-1111-4111-8111-111111111111.jsonl']) {
    const refused = await run(given, { yes: true })
    check(`not a session id, refused with exit 2: ${JSON.stringify(given)}`, refused.rc === 2 && /needs a session id \(a UUID\)/.test(text(refused)), text(refused))
  }
  const noTerminal = await run(ids.named)
  check('without a terminal and without --yes: refused, nothing asked, nothing deleted', noTerminal.rc === 2 && /pass --yes/.test(text(noTerminal)) && noTerminal.asked.length === 0 && existsSync(namedPath), text(noTerminal))
  const declined = await run(ids.named, {}, true, false)
  check('on a terminal, answering No deletes nothing and says so', declined.rc === 0 && declined.asked.length === 1 && /Nothing deleted/.test(text(declined)) && existsSync(namedPath), text(declined))
  check('the question names the records kept beside the transcript', /receipts, resume snapshot/.test(declined.asked[0] ?? ''), declined.asked[0])
  check('the store is untouched after every refusal', JSON.stringify(listing(STORE)) === JSON.stringify(before))
}

section('§2 the delete: the transcript and its two sidecars go, nothing else; the verb says what went')
{
  const before = listing(STORE)
  const yes = await run(ids.named, {}, true, true)
  check('answering Yes deletes the session and exits 0', yes.rc === 0 && yes.asked.length === 1, text(yes))
  check('the transcript is gone', !existsSync(namedPath))
  check('the receipts sidecar is gone', !existsSync(join(STORE, `${ids.named}.receipts.jsonl`)))
  check('the resume snapshot is gone', !existsSync(`${namedPath}.resume-snapshot.json`))
  check('the recording (.cast) stays — recordings are the sweep\'s business', existsSync(join(STORE, `${ids.named}.cast`)))
  check('the session\'s own folder stays (no directory is ever removed by the door)', existsSync(join(STORE, ids.named, 'subagents', 'agent-1.jsonl')))
  check('the sibling session and its sidecars stay', existsSync(siblingPath) && existsSync(join(STORE, `${ids.sibling}.receipts.jsonl`)))
  const removed = before.filter(entry => !listing(STORE).includes(entry))
  check('exactly three entries left the store', JSON.stringify(removed) === JSON.stringify([`${ids.named}.jsonl`, `${ids.named}.jsonl.resume-snapshot.json`, `${ids.named}.receipts.jsonl`]), JSON.stringify(removed))
  check('the receipt names the transcript, the receipts and the snapshot with the bytes freed', /Deleted session 11111111-1111-4111-8111-111111111111: the transcript and its receipts and its resume snapshot — \d+ KB freed\./.test(text(yes)), text(yes))
  check('the line before the question names the file, its size and its date', /Session 11111111-1111-4111-8111-111111111111 — .*11111111-1111-4111-8111-111111111111\.jsonl \(\d+ KB, modified 20\d\d-/.test(text(yes)), text(yes))
  const again = await run(ids.named, { yes: true })
  check('deleting it again is the unknown-id refusal', again.rc === 1 && /No saved session/.test(text(again)), text(again))
}

section('§3 --yes for scripts, and a session saved under another project store')
{
  const scripted = await run(ids.elsewhere, { yes: true })
  check('--yes deletes without a question, naming the other project store', scripted.rc === 0 && scripted.asked.length === 0 && /another project's sessions/.test(text(scripted)) && !existsSync(elsewherePath), text(scripted))
  check('the other store keeps everything else', existsSync(join(OTHER_STORE, `${ids.elsewhere}.cast`)) && existsSync(join(OTHER_STORE, ids.elsewhere, 'subagents', 'agent-1.jsonl')))
}

section('§4 the prune is untouched: the age window still rules the card\'s offer, a live session is never offered, the door\'s sweep law holds')
{
  const rows = [
    { sessionId: ids.sibling, fullPath: siblingPath, fileSize: 100, modified: new Date(Date.now() - 40 * 86_400_000) },
    { sessionId: ids.live, fullPath: livePath, fileSize: 100, modified: new Date(Date.now() - 40 * 86_400_000) },
    { sessionId: ids.parked, fullPath: parkedPath, fileSize: 100, modified: new Date() },
  ]
  const offer = door.buildPruneOffer(rows, { scopeLabel: 'this project', windowDays: 30, liveSessionIds: new Set([ids.live]) })
  check('the card\'s offer still takes only the aged, not-live rows', offer.candidates.map(c => c.sessionId).join(',') === ids.sibling && offer.windowDays === 30, JSON.stringify(offer.candidates.map(c => c.sessionId)))
  const namedOffer = typeof door.buildSessionDeleteOffer === 'function' ? door.buildSessionDeleteOffer : () => undefined
  const named = namedOffer(rows[1]!, { scopeLabel: 'session', liveSessionIds: new Set([ids.live]) })
  check('the named offer refuses a live session (null), whatever its age', named === null)
  const young = namedOffer(rows[2]!, { scopeLabel: 'session', liveSessionIds: new Set() })
  check('the named offer takes a session of any age once it is not live', young != null && young.candidates.length === 1 && young.candidates[0]!.sessionId === ids.parked)
  const sweep = source('src/utils/cleanup.ts')
  check('the sweep still knows neither the door nor the verb', !sweep.includes('operatorPruneTranscripts') && !sweep.includes('transcriptPruneDoor') && !sweep.includes('sessionsVerb'))
  check('the door still unlinks only the three named files (no rm, no directory removal)', !/rmSync\(|\brm\(|rmdir|recursive/.test(source('src/utils/sessionStorage/transcriptPruneDoor.ts')))
}

for (const dir of [HOME, PROJ]) removeScratch(dir)
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
