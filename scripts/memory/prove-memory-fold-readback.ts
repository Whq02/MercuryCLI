import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Message } from '../../src/types/message.ts'

const home = mkdtempSync(join(tmpdir(), 'memory-fold-readback-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
process.env.MERCURY_EMBED_ENGINE = 'off'
writeFileSync(join(home, 'settings.json'), JSON.stringify({ memory: { journal: false }, jev: { enabled: false } }))
const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { retireFoldToMemory, readBackStoredRow, foldMemoryWitness, foldMemoryStoredText } = await import('../../src/services/compact/foldRetirement.ts')
const { makeOwnerKey } = await import('../../src/services/run/ownerKey.ts')
const { acceptUserRequest, noteRunEvent } = await import('../../src/services/run/runCoordinator.ts')
const { readMemoryRecord, consolidatedIdOf, retainItems, _resetMemoryVerbSessionStateForTesting } = await import('../../src/mneme/memoryVerbs.ts')
const { memoryPointerForId, renderPointerLine } = await import('../../src/mneme/mnemePointers.ts')
const { pendingRows } = await import('../../src/mneme/mnemeBuffer.ts')
const { maybeConsolidate } = await import('../../src/mneme/mnemeConsolidate.ts')
const { readPins } = await import('../../src/mneme/mnemeUsage.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')

const dir = mnemeLibraryDir()
mkdirSync(dir, { recursive: true })
const twin = join(home, 'twin-library')
mkdirSync(twin, { recursive: true })
const user = (text: string): Message => ({ type: 'user', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { role: 'user', content: text } }) as never
const assistant = (text: string): Message => ({ type: 'assistant', uuid: randomUUID(), timestamp: new Date().toISOString(), message: { id: randomUUID(), role: 'assistant', content: [{ type: 'text', text }] } }) as never
const messages = [user('Finish the quartz release page.'), assistant('Checking the signed manifest.'), user('Go on.'), assistant('The census is next.')]
const pinsFile = (): string | null => { try { return readFileSync(join(dir, 'pins.json'), 'utf8') } catch { return null } }
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`); if (!ok) failures++ }
function run(objective: string, next: string, sessionId: string): ReturnType<typeof makeOwnerKey> {
  const owner = makeOwnerKey({ workspace: home, sessionId, lane: 'main' })
  acceptUserRequest(owner, { objective, rootMessageId: null })
  noteRunEvent(owner, { type: 'substantive', at: Date.now(), reason: 'work began' })
  noteRunEvent(owner, { type: 'task-transition', at: Date.now(), taskId: 'page', title: 'The quartz release page', state: 'in-progress' })
  noteRunEvent(owner, { type: 'next-action', at: Date.now(), action: next })
  return owner
}
try {
  const pinsBefore = pinsFile()
  const owner = run('Finish the quartz release page before the tag.', 'Run the harbour census, then tag.', 'readback-one')
  const committed = retireFoldToMemory({ messages, owner, epoch: 2, records: messages.length, dir, sessions: [] })
  check('a successful write commits: the envelope carries a resolvable pending pointer, its item and the sha256 witness of the stored text', committed.state === 'committed' && 'pointer' in committed && committed.pointer.id.startsWith('pending:') && committed.item !== null && committed.contentWitness.digest === foldMemoryWitness(foldMemoryStoredText(committed.item)), JSON.stringify(committed).slice(0, 300))
  assert.equal(committed.state, 'committed')
  assert.ok('pointer' in committed && committed.item !== null)
  const stored = readBackStoredRow(committed.pointer.id, dir)
  check('the stored row read back through the shared read-back is the item byte for byte and its witness is the envelope\'s', stored !== null && stored.text === foldMemoryStoredText(committed.item) && foldMemoryWitness(stored.text) === committed.contentWitness.digest && !stored.pin, JSON.stringify(stored).slice(0, 200))
  const record = readMemoryRecord(committed.pointer.id, dir, { sessions: [] })
  check('the public read of the advertised pointer returns the same stored text', record.found && typeof record.content === 'string' && stored !== null && record.content.startsWith(stored.text), JSON.stringify(record).slice(0, 200))
  check('the shared pointer builder resolves the advertised id to the same identity, graded as an unconfirmed pending record — never an owner ruling', (() => { const pointer = memoryPointerForId(committed.pointer.id, { dir, sessions: [] }); return pointer !== null && pointer.id === committed.pointer.id && pointer.kind === 'fact' && /\[pending · unconfirmed · cited (?:\d+|unknown)\]/.test(renderPointerLine(pointer)) })(), committed.pointer.id)
  check('no pin was written by the fold', readPins(dir).length === 0 && pinsFile() === pinsBefore)
  const secretOwner = run('Rotate the deploy token ghp_fixture0000abcdefghijklmnopqrstuvwxyz0123456789 on the harbour box.', 'Store the new token.', 'readback-secret')
  const secret = retireFoldToMemory({ messages, owner: secretOwner, epoch: 3, records: messages.length, dir, sessions: [] })
  check('a run state carrying a secret is a failed envelope naming the refusal, with nothing stored', secret.state === 'failed' && 'reason' in secret && /secret/i.test(secret.reason) && pendingRows(dir).length === 1, JSON.stringify(secret).slice(0, 300))
  const crew = retireFoldToMemory({ messages, owner, epoch: 4, records: messages.length, dir, sessions: [], agent: 'crew-1' })
  check('a crewmate fold writes no project memory and says so', crew.state === 'failed' && 'reason' in crew && crew.reason.startsWith('a crewmate fold writes no project memory') && pendingRows(dir).length === 1, JSON.stringify(crew).slice(0, 200))
  _resetMemoryVerbSessionStateForTesting()
  const crewClaim = retainItems([{ content: 'crewmate observation: the harbour census passed twice' }], { session: 'fold-session', source: 'fold s:fold-ses e:4 a:crew-1', agent: 'crew-1' }, dir)
  const crewPointer = crewClaim[0]?.status === 'stored' ? memoryPointerForId(crewClaim[0].id, { dir, sessions: [] }) : null
  check("a crewmate's retained claim stays a crewmate note after storage", crewPointer !== null && /\[pending · unconfirmed · crewmate note · cited (?:\d+|unknown)\]/.test(renderPointerLine(crewPointer)), crewPointer ? renderPointerLine(crewPointer) : JSON.stringify(crewClaim))
  const landed = maybeConsolidate({ force: true, dir, now: new Date('2026-01-01T00:00:00Z') })
  const after = consolidatedIdOf(committed.pointer.id, dir)
  check('after consolidation the pending id resolves to its seq id and the stored text reads back whole', landed.consolidated && after !== null && stored !== null && (readMemoryRecord(after, dir, { sessions: [] }).content ?? '').includes(stored.text), JSON.stringify({ landed: landed.consolidated, after }))
  check('the consolidated pointer is graded as an unverified fact, not a pin', after !== null && /\[fact · cited (?:\d+|unknown) · unverified\]/.test(renderPointerLine(memoryPointerForId(after, { dir, sessions: [] })!)) && readPins(dir).length === 0, after ? renderPointerLine(memoryPointerForId(after, { dir, sessions: [] })!) : 'no id')
  const again = retireFoldToMemory({ messages, owner, epoch: 5, records: messages.length, dir, sessions: [] })
  check('a repeated fold of the same run state advertises the consolidated record instead of writing a second copy', again.state === 'committed' && 'pointer' in again && again.pointer.id === after && pendingRows(dir).length === 0, JSON.stringify(again).slice(0, 200))
  _resetMemoryVerbSessionStateForTesting()
  const twinText = 'The twin library keeps the same words.'
  retainItems([{ content: twinText, topic: 'project' }], { session: 'twin', source: 'fold s:twin e:1' }, twin)
  retainItems([{ content: twinText, topic: 'project' }], { session: 'twin', source: 'fold s:twin e:1' }, dir)
  const twinId = `pending:${pendingRows(twin)[0]!.ts}`
  const here = memoryPointerForId(twinId, { dir, sessions: [] })
  const there = memoryPointerForId(twinId, { dir: twin, sessions: [] })
  check('identical ids in separate libraries resolve only through their own library', there !== null && readBackStoredRow(twinId, twin) !== null && (here === null || here.source?.library !== there.source?.library), JSON.stringify({ here: here?.source?.library, there: there?.source?.library }))
  assert.equal(failures, 0, `${failures} fold read-back checks failed`)
  console.log('PASS memory fold read-back through the shared builders: committed pointers resolve and match; a secret is a failed envelope with nothing stored; no pin; crewmate claims stay crewmate notes; one copy across repeated folds; ids resolve per library')
} finally {
  rmSync(home, { recursive: true, force: true })
}
