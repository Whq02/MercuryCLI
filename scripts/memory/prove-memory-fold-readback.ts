import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'memory-fold-readback-'))
process.env.MERCURY_CONFIG_DIR = home
delete process.env.MERCURY_HOME
process.env.MERCURY_EMBED_ENGINE = 'off'
const { retainItems, readMemoryRecord, consolidatedIdOf, _resetMemoryVerbSessionStateForTesting } = await import('../../src/mneme/memoryVerbs.ts')
const { memoryPointerForId, renderPointerLine } = await import('../../src/mneme/mnemePointers.ts')
const { pendingRows } = await import('../../src/mneme/mnemeBuffer.ts')
const { maybeConsolidate } = await import('../../src/mneme/mnemeConsolidate.ts')
const { readPins } = await import('../../src/mneme/mnemeUsage.ts')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.ts')

interface Envelope {
  version: 1
  epoch: number
  sessionOrdinal: number | null
  sourceRange: { firstRecordId: string; lastRecordId: string; firstTurn: number; lastTurn: number }
  contentWitness: { algorithm: 'sha256'; digest: string }
  state: 'committed' | 'pending' | 'failed'
  pointerId?: string
  reason?: string
}
const witness = (text: string): string => createHash('sha256').update(text).digest('hex')
const range = { firstRecordId: 'rec-0001', lastRecordId: 'rec-0040', firstTurn: 1, lastTurn: 12 }

function retire(dir: string, content: string, epoch: number, agent?: string): Envelope {
  const base = { version: 1 as const, epoch, sessionOrdinal: 3, sourceRange: range, contentWitness: { algorithm: 'sha256' as const, digest: witness(content) } }
  _resetMemoryVerbSessionStateForTesting()
  const [outcome] = retainItems([{ content, topic: 'project', context: `context epoch ${epoch}; source records rec-0001…rec-0040 (40 records, rounds 1–12)` }], { session: 'fold-session', source: `fold s:fold-ses e:${epoch}`, ...(agent ? { agent } : {}) }, dir)
  if (!outcome || outcome.status !== 'stored') return { ...base, state: 'failed', reason: outcome?.status === 'refused' ? outcome.reason : 'no outcome' }
  const row = pendingRows(dir).find(candidate => `pending:${candidate.ts}` === outcome.id)
  if (!row || !row.text.startsWith(content) || row.pin) return { ...base, state: 'pending', reason: 'the stored row did not read back as written' }
  const pointer = memoryPointerForId(outcome.id, { dir, sessions: [] })
  if (!pointer) return { ...base, state: 'pending', reason: 'no pointer resolves' }
  return { ...base, state: 'committed', pointerId: pointer.id, contentWitness: { algorithm: 'sha256', digest: witness(row.text) } }
}

const dir = mnemeLibraryDir()
mkdirSync(dir, { recursive: true })
const twin = join(home, 'twin-library')
mkdirSync(twin, { recursive: true })
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${!ok && detail ? ` — ${detail}` : ''}`); if (!ok) failures++ }
try {
  const pinsBefore = ((): string | null => { try { return readFileSync(join(dir, 'pins.json'), 'utf8') } catch { return null } })()
  const state = 'The quartz release page waits on the signed manifest; next action: run the harbour census, then tag.'
  const committed = retire(dir, state, 2)
  check('a successful write commits: the envelope carries a resolvable pointer and the sha256 of the stored row', committed.state === 'committed' && committed.pointerId?.startsWith('pending:') === true && committed.contentWitness.digest === witness(pendingRows(dir)[0]!.text), JSON.stringify(committed))
  const stored = readMemoryRecord(committed.pointerId!, dir, { sessions: [] })
  check('the full read of the advertised pointer returns the exact stored text, whose witness matches the envelope', stored.found && typeof stored.content === 'string' && stored.content.startsWith(state) && witness(pendingRows(dir)[0]!.text) === committed.contentWitness.digest && stored.content.includes(state), JSON.stringify(stored).slice(0, 300))
  const pointer = memoryPointerForId(committed.pointerId!, { dir, sessions: [] })!
  check('the pointer is graded as an unconfirmed pending record — never an owner ruling', /\[pending · unconfirmed · cited (?:\d+|unknown)\]/.test(renderPointerLine(pointer)) && pointer.kind === 'fact', renderPointerLine(pointer))
  check('no pin was written by the fold', readPins(dir).length === 0 && (pinsBefore === null ? ((): boolean => { try { readFileSync(join(dir, 'pins.json'), 'utf8'); return false } catch { return true } })() : readFileSync(join(dir, 'pins.json'), 'utf8') === pinsBefore))
  const secret = retire(dir, 'the deploy token is ghp_abcdefghijklmnopqrstuvwxyz0123456789', 3)
  check('a refused write (a secret) is a failed envelope with the refusal named and nothing stored', secret.state === 'failed' && /secret|token|key|credential/i.test(secret.reason ?? '') && pendingRows(dir).length === 1, JSON.stringify(secret))
  const crew = retainItems([{ content: 'crewmate observation: the harbour census passed twice' }], { session: 'fold-session', source: 'fold s:fold-ses e:4 a:crew-1', agent: 'crew-1' }, dir)
  const crewPointer = crew[0]?.status === 'stored' ? memoryPointerForId(crew[0].id, { dir, sessions: [] }) : null
  check("a crewmate's retired claim stays a crewmate note after storage", crewPointer !== null && /\[pending · unconfirmed · crewmate note · cited (?:\d+|unknown)\]/.test(renderPointerLine(crewPointer)), crewPointer ? renderPointerLine(crewPointer) : JSON.stringify(crew))
  const landed = maybeConsolidate({ force: true, dir, now: new Date('2026-01-01T00:00:00Z') })
  const after = consolidatedIdOf(committed.pointerId!, dir)
  check('after consolidation the pending id resolves to its seq id and the same text reads back whole', landed.consolidated && after !== null && (readMemoryRecord(after, dir, { sessions: [] }).content ?? '').includes(state), JSON.stringify({ landed: landed.consolidated, after }))
  check('the consolidated pointer is graded as an unverified fact, not a pin', after !== null && /\[fact · cited (?:\d+|unknown) · unverified\]/.test(renderPointerLine(memoryPointerForId(after, { dir, sessions: [] })!)) && readPins(dir).length === 0, after ? renderPointerLine(memoryPointerForId(after, { dir, sessions: [] })!) : 'no id')
  const second = retire(dir, state, 5)
  check('a repeated fold of the same state deduplicates to the existing record instead of a second copy', second.state !== 'committed' || pendingRows(dir).filter(row => row.text.startsWith(state)).length <= 1, JSON.stringify(second))
  _resetMemoryVerbSessionStateForTesting()
  const twinState = 'The twin library keeps the same words.'
  retainItems([{ content: twinState, topic: 'project' }], { session: 'twin', source: 'fold s:twin e:1' }, twin)
  retainItems([{ content: twinState, topic: 'project' }], { session: 'twin', source: 'fold s:twin e:1' }, dir)
  const twinId = `pending:${pendingRows(twin)[0]!.ts}`
  const here = memoryPointerForId(twinId, { dir, sessions: [] })
  const there = memoryPointerForId(twinId, { dir: twin, sessions: [] })
  check('identical ids in separate libraries resolve only through their own library', there !== null && (here === null || here.source?.library !== there.source?.library), JSON.stringify({ here: here?.source?.library, there: there?.source?.library }))
  writeFileSync(join(home, 'readback-receipt.json'), JSON.stringify({ committed, secret, after }, null, 1))
  assert.equal(failures, 0, `${failures} fold read-back checks failed`)
  console.log('PASS memory fold read-back: committed pointers resolve and match; refused writes never read as saved; no pin; crewmate claims stay crewmate notes')
} finally {
  rmSync(home, { recursive: true, force: true })
}
