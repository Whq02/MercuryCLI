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

const { getProjectDir, getProjectsDir } = await import('../../src/sessions/transcripts/paths.ts')
const door = await import('../../src/daemon/switchboard/transcriptPruneDoor.ts')
const verb = await import('../../src/commands/verbs/sessionsVerb.ts').catch(() => null)

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
  running: '77777777-7777-4777-8777-777777777777',
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
    mkdirSync(join(store, sessionId, 'subagents', 'nested'), { recursive: true })
    writeFileSync(join(store, sessionId, 'subagents', 'agent-1.jsonl'), '{"type":"user"}\n')
    writeFileSync(join(store, sessionId, 'subagents', 'nested', 'agent-2.jsonl'), '{"type":"assistant"}\n')
    writeFileSync(join(store, `${sessionId}.cast`), 'recording\n')
  }
  return path
}
const namedPath = seed(STORE, ids.named)
const siblingPath = seed(STORE, ids.sibling)
const elsewherePath = seed(OTHER_STORE, ids.elsewhere)
const livePath = seed(STORE, ids.live, false)
const parkedPath = seed(STORE, ids.parked, false)
const runningPath = seed(STORE, ids.running, false)
writeFileSync(join(DAEMON, 'concourse-workers.json'), JSON.stringify({
  version: 1,
  workers: {
    'concourse-w1': { schema: 1, runnerId: 'concourse-w1', sessionId: ids.live, workspaceId: PROJ, isolation: 'shared', modelKey: 'fixture-model', startedAt: Date.now() },
    'concourse-w2': { schema: 1, runnerId: 'concourse-w2', sessionId: ids.parked, workspaceId: PROJ, isolation: 'shared', modelKey: 'fixture-model', startedAt: Date.now(), parkedAt: Date.now() },
    'concourse-w3': { schema: 1, runnerId: 'concourse-w3', sessionId: ids.sibling, workspaceId: PROJ, isolation: 'shared', modelKey: 'fixture-model', startedAt: Date.now() - 5000, endedAt: Date.now() - 1000 },
    'concourse-w4': { schema: 1, runnerId: 'concourse-w4', sessionId: ids.running, workspaceId: PROJ, isolation: 'shared', modelKey: 'fixture-model', startedAt: Date.now(), pid: process.pid },
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
  check('the verb module exists (src/commands/verbs/sessionsVerb.ts)', verb !== null, 'src/commands/verbs/sessionsVerb.ts did not import; restore it and its export sessionsDeleteCli (every later check then fails with rc -1)')
  const { builtHelp } = await import('../lib/builtProduct.ts')
  check('main.tsx registers `sessions delete <id>` with --yes', builtHelp('sessions').includes('delete [options] <id>') && builtHelp('sessions', 'delete').includes('Usage: mercury sessions delete [options] <id>') && builtHelp('sessions', 'delete').includes('--yes'), 'register the sessions delete <id> subcommand with a --yes option in src/boot/main/subcommands.ts (it calls sessionsDeleteCli)')
  check('the door offers a named session without an age window (buildSessionDeleteOffer)', typeof door.buildSessionDeleteOffer === 'function', 'export buildSessionDeleteOffer from src/daemon/switchboard/transcriptPruneDoor.ts')
  for (const file of ['assets/completions/mercury.bash', 'assets/completions/_mercury', 'assets/completions/mercury.fish']) {
    check(`${file} completes the sessions verb`, /\bsessions\b/.test(source(file)), `${file}: add the sessions verb to this completion file`)
  }
}

section('§1 refusals: a live session, a session with a live runner, an unknown id, a non-id, no terminal without --yes; a parked session is deleted')
{
  const before = listing(STORE)
  const live = await run(ids.live, { yes: true })
  check('a session the daemon hosts now is refused with the reason', live.rc === 1 && /is live/.test(text(live)) && /the daemon/.test(text(live)), `sessionsDeleteCli in src/commands/verbs/sessionsVerb.ts must refuse a session the daemon hosts (exit 1, message with is live and the daemon); got: ${text(live)}`)
  check('…and its transcript stays', existsSync(livePath))
  const running = await run(ids.running, { yes: true })
  check('a session with a live runner (its record neither parked nor ended, its pid alive) is refused too', running.rc === 1 && /is live/.test(text(running)) && /Stop it first/.test(text(running)) && existsSync(runningPath), `sessionsDeleteCli in src/commands/verbs/sessionsVerb.ts must refuse a session whose record is neither parked nor ended (boardHomedSessionIds in src/daemon/concourse-workers/queries.ts holds it); got: ${text(running)}`)
  const unknown = await run(ids.absent, { yes: true })
  check('an unknown id is refused with the roster hint', unknown.rc === 1 && /No saved session 99999999-9999-4999-8999-999999999999/.test(text(unknown)) && /roster/.test(text(unknown)) && /\/sessions/.test(text(unknown)), `the no-saved-session refusal in sessionsDeleteCli (src/commands/verbs/sessionsVerb.ts) must exit 1 and name the id and the /sessions roster; got: ${text(unknown)}`)
  for (const given of ['', 'latest', '../x.jsonl', `${STORE}/${ids.named}.jsonl`, '11111111-1111-4111-8111-11111111111', "'; rm -rf /", 'C:\\Users\\x\\.mercury\\projects\\p\\11111111-1111-4111-8111-111111111111.jsonl']) {
    const refused = await run(given, { yes: true })
    check(`not a session id, refused with exit 2: ${JSON.stringify(given)}`, refused.rc === 2 && /needs a session id \(a UUID\)/.test(text(refused)), `sessionsDeleteCli in src/commands/verbs/sessionsVerb.ts must refuse this input with exit 2 and the needs-a-session-id message; got rc ${refused.rc}: ${text(refused)}`)
  }
  const noTerminal = await run(ids.named)
  check('without a terminal and without --yes: refused, nothing asked, nothing deleted', noTerminal.rc === 2 && /pass --yes/.test(text(noTerminal)) && noTerminal.asked.length === 0 && existsSync(namedPath), `sessionsDeleteCli in src/commands/verbs/sessionsVerb.ts must exit 2 with pass --yes when not interactive, without asking or deleting; got: ${text(noTerminal)}`)
  const declined = await run(ids.named, {}, true, false)
  check('on a terminal, answering No deletes nothing and says so', declined.rc === 0 && declined.asked.length === 1 && /Nothing deleted/.test(text(declined)) && existsSync(namedPath), `sessionsDeleteCli in src/commands/verbs/sessionsVerb.ts must ask once and on No print Nothing deleted, exit 0 and keep the file; got: ${text(declined)}`)
  check('the question names the records kept beside the transcript', /receipts, resume snapshot/.test(declined.asked[0] ?? ''), `the question passed to io.ask in sessionsDeleteCli (src/commands/verbs/sessionsVerb.ts) must name receipts, resume snapshot; got: ${declined.asked[0]}`)
  check('the store is untouched after every refusal', JSON.stringify(listing(STORE)) === JSON.stringify(before), 'a refusal path in sessionsDeleteCli (src/commands/verbs/sessionsVerb.ts) removed a file; return before operatorPruneTranscripts runs')
  const { buildConcourseSnapshot } = await import('../../src/screen/concourse-model/concourseSnapshot.ts')
  const { readSessionWorkers } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
  const boardBefore = JSON.stringify(await buildConcourseSnapshot({ recordsDir: DAEMON }))
  const parked = await run(ids.parked, { yes: true })
  check('a parked session (its record at rest, no live runner) is deleted when its user asks', parked.rc === 0 && parked.asked.length === 0 && !existsSync(parkedPath), `sessionsDeleteCli in src/commands/verbs/sessionsVerb.ts must delete a session whose record is parked (boardHomedSessionIds in src/daemon/concourse-workers/queries.ts leaves a parked record out of the live set); got rc ${parked.rc}: ${text(parked)}`)
  check('…and the answer names the session and its transcript', /Deleted session 55555555-5555-4555-8555-555555555555: the transcript — \d+ KB freed\./.test(text(parked)) && /Session 55555555-5555-4555-8555-555555555555 — .*55555555-5555-4555-8555-555555555555\.jsonl/.test(text(parked)), `fix the io.out lines of sessionsDeleteCli in src/commands/verbs/sessionsVerb.ts; got: ${text(parked)}`)
  check('nothing but the parked session\'s transcript left the store', JSON.stringify(before.filter(entry => !listing(STORE).includes(entry))) === JSON.stringify([`${ids.parked}.jsonl`]), `removed: ${JSON.stringify(before.filter(entry => !listing(STORE).includes(entry)))}`)
  const boardAfter = JSON.stringify(await buildConcourseSnapshot({ recordsDir: DAEMON }))
  const record = readSessionWorkers(DAEMON)['concourse-w2']
  check('the daemon\'s record of the deleted session is ended, so nothing holds it parked', record?.endedAt !== undefined, `operatorPruneTranscripts in src/daemon/switchboard/transcriptPruneDoor.ts must settle the unended record of a session whose transcript it removed (settleConcourseWorker); the record reads ${JSON.stringify(record)}`)
  check('the Session Concourse listed the parked session before the delete and lists no row for it after', boardBefore.includes(ids.parked) && !boardAfter.includes(ids.parked), `buildConcourseSnapshot in src/screen/concourse-model/concourseSnapshot.ts reads every unended record: listed before ${boardBefore.includes(ids.parked)}, after ${boardAfter.includes(ids.parked)}`)
  check('the records of the other sessions stand as they were', readSessionWorkers(DAEMON)['concourse-w1']?.endedAt === undefined && readSessionWorkers(DAEMON)['concourse-w4']?.endedAt === undefined && boardAfter.includes(ids.live), JSON.stringify(readSessionWorkers(DAEMON)))
  const listed: string[] = []
  const listRc = verb === null ? -1 : await verb.sessionsListCli({ all: true }, { out: line => listed.push(line), err: line => listed.push(line), interactive: false, ask: async () => false })
  check('mercury sessions list no longer lists the deleted session, and still lists the others', listRc === 0 && !listed.join('\n').includes(ids.parked) && [ids.live, ids.running, ids.named, ids.sibling].every(id => listed.join('\n').includes(id)), `sessionsListCli in src/commands/verbs/sessionsVerb.ts lists the saved transcripts; got rc ${listRc}: ${listed.join(' | ')}`)
}

section('§2 the delete: the transcript and its two sidecars go, nothing else; the verb says what went')
{
  const before = listing(STORE)
  const yes = await run(ids.named, {}, true, true)
  check('answering Yes deletes the session and exits 0', yes.rc === 0 && yes.asked.length === 1, `sessionsDeleteCli in src/commands/verbs/sessionsVerb.ts must ask once and return 0 on Yes; got rc ${yes.rc}: ${text(yes)}`)
  check('the transcript is gone', !existsSync(namedPath), 'operatorPruneTranscripts in src/daemon/switchboard/transcriptPruneDoor.ts did not remove the transcript')
  check('the receipts sidecar is gone', !existsSync(join(STORE, `${ids.named}.receipts.jsonl`)), 'operatorPruneTranscripts in src/daemon/switchboard/transcriptPruneDoor.ts must also remove the .receipts.jsonl sidecar')
  check('the resume snapshot is gone', !existsSync(`${namedPath}.resume-snapshot.json`), 'operatorPruneTranscripts in src/daemon/switchboard/transcriptPruneDoor.ts must also remove the .resume-snapshot.json sidecar')
  check('the recording (.cast) stays — recordings are the sweep\'s business', existsSync(join(STORE, `${ids.named}.cast`)), 'the delete door in src/daemon/switchboard/transcriptPruneDoor.ts removed the .cast recording; only the transcript and its two sidecars may go')
  check('the session\'s subagents folder (including nested files) and its then-empty session folder are gone', !existsSync(join(STORE, ids.named, 'subagents')) && !existsSync(join(STORE, ids.named)), 'operatorPruneTranscripts in src/daemon/switchboard/transcriptPruneDoor.ts must remove <session>/subagents and the empty <session> folder')
  check('the sibling session, its sidecars and its subagents folder stay untouched', existsSync(siblingPath) && existsSync(join(STORE, `${ids.sibling}.receipts.jsonl`)) && existsSync(join(STORE, ids.sibling, 'subagents', 'agent-1.jsonl')), 'the delete door in src/daemon/switchboard/transcriptPruneDoor.ts removed another session files; it may touch only the named id')
  const removed = before.filter(entry => !listing(STORE).includes(entry))
  const expectedRemoved = [
    ids.named,
    join(ids.named, 'subagents'),
    join(ids.named, 'subagents', 'agent-1.jsonl'),
    join(ids.named, 'subagents', 'nested'),
    join(ids.named, 'subagents', 'nested', 'agent-2.jsonl'),
    `${ids.named}.jsonl`,
    `${ids.named}.jsonl.resume-snapshot.json`,
    `${ids.named}.receipts.jsonl`,
  ].sort()
  check('exactly the transcript, its sidecars and its subagents tree left the store', JSON.stringify(removed) === JSON.stringify(expectedRemoved), `removed: ${JSON.stringify(removed)}`)
  check('the receipt names the transcript, the receipts and the snapshot with the bytes freed', /Deleted session 11111111-1111-4111-8111-111111111111: the transcript and its receipts and its resume snapshot — \d+ KB freed\./.test(text(yes)), `fix the final io.out line of sessionsDeleteCli in src/commands/verbs/sessionsVerb.ts; got: ${text(yes)}`)
  check('the line before the question names the file, its size and its date', /Session 11111111-1111-4111-8111-111111111111 — .*11111111-1111-4111-8111-111111111111\.jsonl \(\d+ KB, modified 20\d\d-/.test(text(yes)), `fix the io.out line printed before the question in sessionsDeleteCli (src/commands/verbs/sessionsVerb.ts); got: ${text(yes)}`)
  const again = await run(ids.named, { yes: true })
  check('deleting it again is the unknown-id refusal', again.rc === 1 && /No saved session/.test(text(again)), `after the delete, savedSessionNamed in src/commands/verbs/sessionsVerb.ts must no longer find the id; got: ${text(again)}`)
}

section('§3 --yes for scripts, and a session saved under another project store')
{
  const scripted = await run(ids.elsewhere, { yes: true })
  check('--yes deletes without a question, naming the other project store', scripted.rc === 0 && scripted.asked.length === 0 && /another project's sessions/.test(text(scripted)) && !existsSync(elsewherePath), `sessionsDeleteCli in src/commands/verbs/sessionsVerb.ts must delete without asking under --yes and say it is in another project's sessions; got: ${text(scripted)}`)
  check('the other store keeps the recording and removes the deleted session subagents folder', existsSync(join(OTHER_STORE, `${ids.elsewhere}.cast`)) && !existsSync(join(OTHER_STORE, ids.elsewhere)), 'the delete door in src/daemon/switchboard/transcriptPruneDoor.ts must keep the .cast recording and remove the deleted session subagents folder')
}

section('§4 the prune is untouched: the age window still rules the card\'s offer, a live session is never offered, the door\'s sweep law holds')
{
  const rows = [
    { sessionId: ids.sibling, fullPath: siblingPath, fileSize: 100, modified: new Date(Date.now() - 40 * 86_400_000) },
    { sessionId: ids.live, fullPath: livePath, fileSize: 100, modified: new Date(Date.now() - 40 * 86_400_000) },
    { sessionId: ids.parked, fullPath: parkedPath, fileSize: 100, modified: new Date() },
  ]
  const offer = door.buildPruneOffer(rows, { scopeLabel: 'this project', windowDays: 30, liveSessionIds: new Set([ids.live]) })
  check('the card\'s offer still takes only the aged, not-live rows', offer.candidates.map(c => c.sessionId).join(',') === ids.sibling && offer.windowDays === 30, `buildPruneOffer in src/daemon/switchboard/transcriptPruneDoor.ts must keep only rows older than the window and not live; got: ${JSON.stringify(offer.candidates.map(c => c.sessionId))}`)
  const namedOffer = typeof door.buildSessionDeleteOffer === 'function' ? door.buildSessionDeleteOffer : () => undefined
  const named = namedOffer(rows[1]!, { scopeLabel: 'session', liveSessionIds: new Set([ids.live]) })
  check('the named offer refuses a live session (null), whatever its age', named === null, 'buildSessionDeleteOffer in src/daemon/switchboard/transcriptPruneDoor.ts must return null for an id in liveSessionIds')
  const young = namedOffer(rows[2]!, { scopeLabel: 'session', liveSessionIds: new Set() })
  check('the named offer takes a session of any age once it is not live', young != null && young.candidates.length === 1 && young.candidates[0]!.sessionId === ids.parked, 'buildSessionDeleteOffer in src/daemon/switchboard/transcriptPruneDoor.ts must offer one candidate for a non-live session of any age')
}
  const plainId = '66666666-6666-4666-8666-666666666666'
  const plainPath = seed(STORE, plainId, false)
  const plainBytes = readFileSync(plainPath).byteLength
  const plainReceipt = await door.operatorPruneTranscripts(door.buildSessionDeleteOffer({ sessionId: plainId, fullPath: plainPath, fileSize: plainBytes, modified: new Date() }, { scopeLabel: 'session', liveSessionIds: new Set() })!)
  check('a session without a subagents folder prunes cleanly as before', plainReceipt.deleted === 1 && plainReceipt.failed === 0 && plainReceipt.bytesFreed === plainBytes && !existsSync(plainPath), JSON.stringify(plainReceipt))
  const keepParentId = '77777777-7777-4777-8777-777777777777'
  const keepParentPath = seed(STORE, keepParentId, false)
  const keepParentBytes = readFileSync(keepParentPath).byteLength
  mkdirSync(join(STORE, keepParentId, 'subagents', 'deep'), { recursive: true })
  const agentPayload = 'a'.repeat(4096)
  const deepPayload = 'b'.repeat(2048)
  writeFileSync(join(STORE, keepParentId, 'subagents', 'agent-x.jsonl'), agentPayload)
  writeFileSync(join(STORE, keepParentId, 'subagents', 'deep', 'agent-y.jsonl'), deepPayload)
  writeFileSync(join(STORE, keepParentId, 'other.txt'), 'keep')
  const keepReceipt = await door.operatorPruneTranscripts(door.buildSessionDeleteOffer({ sessionId: keepParentId, fullPath: keepParentPath, fileSize: keepParentBytes, modified: new Date() }, { scopeLabel: 'session', liveSessionIds: new Set() })!)
  check('bytesFreed counts the removed subagents files, and a non-empty session folder keeps its non-subagents file', keepReceipt.deleted === 1 && keepReceipt.bytesFreed === keepParentBytes + agentPayload.length + deepPayload.length && !existsSync(join(STORE, keepParentId, 'subagents')) && existsSync(join(STORE, keepParentId, 'other.txt')), JSON.stringify(keepReceipt))

for (const dir of [HOME, PROJ]) removeScratch(dir)
console.log(`\n${checks - failures}/${checks} checks passed`)
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
