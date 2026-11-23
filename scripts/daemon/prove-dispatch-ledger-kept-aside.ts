#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-ledger-kept-')))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
for (const key of ['MERCURY_HOME', 'MERCURY_DAEMON_PERSIST', 'MERCURY_DAEMON_OWNER_PID', 'MERCURY_DAEMON_OWNER_FD']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const WHERE_TO_LOOK = 'fix the merge before publish and the keep-aside of an unusable ledger in src/daemon/concourse-workers/concourseDispatch.ts (keepDamagedFileAsideSync, flushDeferredDispatchPublishes) and the recovery ledger in src/platform/substrate/storeRecovery.ts'
const check = (label: string, cond: boolean, detail: unknown = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)} (${WHERE_TO_LOOK})` : ''}`)
}
const skip = (label: string, why: string): void => console.log(`  [SKIP] ${label} — ${why}`)
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

const dispatch = await import('../../src/daemon/concourse-workers/concourseDispatch.ts')
const recovery = await import('../../src/platform/substrate/storeRecovery.ts')

const HELD = { schema: 1, clientMessageId: 'msg-held-1', promptDigest: 'd1', envelopeDigest: 'e1', envelopeVersion: 2, state: 'queued', stateRevision: 1, acceptedAt: 1000, heldReason: 'seat', workspaceId: '/fixture/project', heldOp: { prompt: 'the queued launch of another writer', workspaceDir: '/fixture/project' } }
const WORKING = { schema: 1, clientMessageId: 'msg-working-2', promptDigest: 'd2', envelopeDigest: 'e2', envelopeVersion: 2, state: 'working', stateRevision: 3, acceptedAt: 2000, workerId: 'concourse-w2', sessionId: 's-2' }
const LEDGER = `${JSON.stringify({ version: 1, dispatches: { 'msg-held-1': HELD, 'msg-working-2': WORKING } }, null, 1)}\n`

const said: string[] = []
const realError = console.error
console.error = (...args: unknown[]) => void said.push(args.map(String).join(' '))

let scene = 0
const fresh = (): { dir: string; file: string } => {
  const dir = join(home, `scene-${++scene}`)
  mkdirSync(dir, { recursive: true })
  said.length = 0
  return { dir, file: dispatch.concourseDispatchesPath(dir) }
}
const send = async (dir: string, id: string): Promise<{ answered?: unknown; threw?: string }> => {
  const handler = dispatch.makeConcourseDispatchHandler({ admit: async () => ({ ok: false, code: 'invalid-model', error: 'refused by the fixture' }) as never, deliver: async () => true, dir })
  try {
    const answered = await handler({ clientMessageId: id, prompt: 'a new message', workspaceDir: dir })
    await dispatch.flushDeferredDispatchPublishes()
    return { answered }
  } catch (error) {
    return { threw: error instanceof Error ? error.message : String(error) }
  }
}
const idsOn = (file: string): string[] => {
  try {
    return Object.keys((JSON.parse(readFileSync(file, 'utf8')) as { dispatches?: Record<string, unknown> }).dispatches ?? {}).sort()
  } catch {
    return ['(the ledger does not read)']
  }
}
const asides = (dir: string): string[] => readdirSync(dir).filter(name => name.startsWith('concourse-dispatches.json.corrupt.')).sort()
const NAME = /^concourse-dispatches\.json\.corrupt\.\d+$/
type Event = { store?: string; kind?: string; quarantinePath?: string | null; reason?: string }

try {
  for (const [title, bytes, mode, why] of [
    ['there and unreadable', LEDGER, 0o200, 'EACCES'],
    ['cut short', LEDGER.slice(0, Math.floor(LEDGER.length * 0.6)), 0o600, 'it is not valid JSON'],
    ['of another version', LEDGER.replace('"version": 1', '"version": 2'), 0o600, 'it is not a version 1 dispatch ledger'],
  ] as const) {
    console.log(`the dispatch ledger — ${title}: it is kept aside with its other writers' records before the new one is written`)
    if (mode !== 0o600 && !POSIX_MODES) {
      skip(title, 'a mode-0200 file needs a POSIX process that is not root')
      continue
    }
    const { dir, file } = fresh()
    writeFileSync(file, bytes, { mode: 0o600 })
    chmodSync(file, mode)
    const sent = await send(dir, 'msg-new')
    const kept = asides(dir)
    const copy = kept.length === 1 ? join(dir, kept[0]!) : null
    if (copy !== null) chmodSync(copy, 0o600)
    check('the dispatch is answered, not stalled', sent.threw === undefined && (sent.answered as { clientMessageId?: string } | undefined)?.clientMessageId === 'msg-new', sent)
    check('the ledger that could not be used is kept beside the new one, byte for byte, under a name of its own', copy !== null && NAME.test(kept[0]!) && readFileSync(copy, 'utf8') === bytes, `kept ${JSON.stringify(kept)} — the queued launch of the other writer is on disk nowhere (the ledger now holds ${idsOn(file).join(', ')})`)
    check('the new ledger holds the new message', idsOn(file).join() === 'msg-new', idsOn(file))
    check('daemon.log is told once, with the path of the copy', copy !== null && said.filter(line => line === `[daemon] ${file}: the dispatch ledger could not be read for the merge before publish (${why}); it is kept aside at ${copy} with its other writers' records, and a new ledger is written`).length === 1, said)
    const events = (await recovery.readStoreRecoveryEvents()) as Event[]
    const last = events.at(-1)
    check('the recovery ledger, which the Health Check prints, names the store, the reason and where the copy is', last !== undefined && last.store === 'concourse-dispatches' && last.reason === why && last.quarantinePath === copy && (last.kind ?? 'quarantine') === 'quarantine', last ?? null)
    said.length = 0
    const next = await send(dir, 'msg-next')
    check('the dispatch after it merges with the new ledger and keeps nothing more aside', next.threw === undefined && idsOn(file).join() === 'msg-new,msg-next' && asides(dir).length === 1 && said.length === 0, { ids: idsOn(file), asides: asides(dir), said })
  }

  console.log('the dispatch ledger — a version 1 ledger holding a record that is no record: kept aside, and dispatch is not stalled')
  {
    const { dir, file } = fresh()
    const bytes = '{"version":1,"dispatches":{"msg-broken":null}}\n'
    writeFileSync(file, bytes)
    const sent = await send(dir, 'msg-new')
    const next = await send(dir, 'msg-next')
    const kept = asides(dir)
    check('both dispatches are answered and the ledger holds them', sent.threw === undefined && next.threw === undefined && idsOn(file).join() === 'msg-new,msg-next', { sent, next, ids: idsOn(file) })
    check('the ledger that could not be used is kept aside once, byte for byte', kept.length === 1 && readFileSync(join(dir, kept[0]!), 'utf8') === bytes, kept)
    check('daemon.log says why', said.some(line => line.includes('could not be read for the merge before publish (it is not a version 1 dispatch ledger); it is kept aside at ')), said)
  }

  console.log('the dispatch ledger — two that cannot be used in one millisecond: the second copy never clobbers the first')
  {
    const { dir, file } = fresh()
    const realNow = Date.now
    Date.now = () => 1763580000000
    writeFileSync(file, 'first torn ledger {')
    const first = await send(dir, 'msg-a')
    writeFileSync(file, 'second torn ledger {')
    const second = await send(dir, 'msg-b')
    Date.now = realNow
    const held = asides(dir).map(name => readFileSync(join(dir, name), 'utf8')).sort()
    check('both are kept, each under its own name', first.threw === undefined && second.threw === undefined && JSON.stringify(held) === JSON.stringify(['first torn ledger {', 'second torn ledger {']), held)
  }

  console.log('the dispatch ledger — a ledger that cannot be used and cannot be kept aside: logged as before, and dispatch goes on')
  if (process.platform !== 'darwin' || !POSIX_MODES) skip('the rename that fails', 'a file that takes no rename is made here with the immutable flag of macOS')
  else {
    const { dir, file } = fresh()
    writeFileSync(file, 'torn ledger {')
    spawnSync('/usr/bin/chflags', ['uchg', file])
    const sent = await send(dir, 'msg-new')
    spawnSync('/usr/bin/chflags', ['nouchg', file])
    check('the ledger stands as it was and nothing is kept aside', readFileSync(file, 'utf8') === 'torn ledger {' && asides(dir).length === 0, { asides: asides(dir) })
    check('daemon.log carries the line it carried before', said.filter(line => line === `[daemon] ${file}: the dispatch ledger could not be read for the merge before publish, its other writers' records are not merged: it is not valid JSON`).length >= 1 && said.every(line => !line.includes('kept aside')), said)
    check('the dispatch itself fails on the publish, as before, with the file closed to a rename', sent.threw !== undefined, sent)
  }

  console.log('the dispatch ledger — controls: no ledger is a first write, and a ledger that reads keeps the other writers\' records')
  {
    const { dir, file } = fresh()
    const first = await send(dir, 'msg-new')
    check('with no ledger the first dispatch writes it', first.threw === undefined && idsOn(file).join() === 'msg-new' && asides(dir).length === 0, idsOn(file))
    const other = fresh()
    writeFileSync(other.file, LEDGER)
    const merged = await send(other.dir, 'msg-new')
    check('with a ledger that reads, the other writers\' records are merged and nothing is kept aside or said', merged.threw === undefined && idsOn(other.file).join() === 'msg-held-1,msg-new,msg-working-2' && asides(other.dir).length === 0 && said.length === 0, { ids: idsOn(other.file), said })
  }
} finally {
  console.error = realError
  rmSync(home, { recursive: true, force: true })
}

console.log(`\nprove-dispatch-ledger-kept-aside: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
