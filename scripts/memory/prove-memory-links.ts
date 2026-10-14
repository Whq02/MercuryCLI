#!/usr/bin/env bun
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'memory-links-')))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.NODE_ENV = 'test'
process.env.MERCURY_DESKTOP_DRIVER = 'none'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(ROOT)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
  if (!cond) failures++
}

const links = await import('../../src/mneme/mnemeLinks.js')
const docs = await import('../../src/mneme/mnemeTopicDocs.js')
const usage = await import('../../src/mneme/mnemeUsage.js')
const footnotes = await import('../../src/mneme/mnemeFootnotes.js')
const ledger = await import('../../src/mneme/ledger.js')
const { mnemeProjectKey } = await import('../../src/mneme/paths.js')
const { mnemeLibraryDir } = await import('../../src/mneme/mnemeGates.js')
const { recallQuery } = await import('../../src/mneme/memoryVerbs.js')
const { candidates } = await import('../../src/mneme/mnemeLookup.js')
const { getSessionId } = await import('../../src/bootstrap/state.js')
const { appendObservation } = await import('../../src/mneme/mnemeBuffer.js')

console.log('\n[L] the lift is bounded: two places at most, never past another linked fact, ids only')
{
  const order = ['a', 'b', 'c', 'd', 'e']
  check('a linked fact five deep rises exactly two places', JSON.stringify(links.liftLinked(order, new Set(['e']))) === JSON.stringify(['a', 'b', 'e', 'c', 'd']), JSON.stringify(links.liftLinked(order, new Set(['e']))))
  check('the bound is the exported constant, two', links.RULING_LIFT_PLACES === 2)
  check('a linked fact never passes another linked fact', JSON.stringify(links.liftLinked(['a', 'x', 'y'], new Set(['x', 'y']))) === JSON.stringify(['x', 'y', 'a']), JSON.stringify(links.liftLinked(['a', 'x', 'y'], new Set(['x', 'y']))))
  check('the top fact stays where it is when linked', JSON.stringify(links.liftLinked(['x', 'a', 'b'], new Set(['x']))) === JSON.stringify(['x', 'a', 'b']))
  check('no link, no movement', JSON.stringify(links.liftLinked(order, new Set())) === JSON.stringify(order))
  const moved = links.liftLinked(order, new Set(['c', 'e']))
  check('every id survives the lift, none added or dropped', moved.length === order.length && [...moved].sort().join() === [...order].sort().join(), JSON.stringify(moved))
  check('the unlinked facts keep their order among themselves', JSON.stringify(moved.filter(id => id !== 'c' && id !== 'e')) === JSON.stringify(['a', 'b', 'd']), JSON.stringify(moved))
}

const dir = mnemeLibraryDir()
mkdirSync(dir, { recursive: true })
const key = mnemeProjectKey()
const current = String(getSessionId())
const ONE = 'link-session-one-0000-4000-8000-000000000001'
const at = (minute: number): string => `2026-10-13T09:${String(minute).padStart(2, '0')}:00.000Z`
const deploy = docs.emptyDoc('deploy', 'deploy facts', at(0))
deploy.sections.push({ heading: 'gates', entries: [
  { text: 'The deploy gate waits for the smoke suite before any rollout.', seq: 1, time: at(1), source: `tool:Retain s:${ONE.slice(0, 8)}` },
  { text: 'The gate opens the rollout window at nine once the smoke suite is green.', seq: 2, time: at(2), source: `tool:Retain s:${ONE.slice(0, 8)}` },
  { text: 'The gate.', seq: 3, time: at(3), source: 'tool:Retain s:elsewhere' },
  { text: 'A gate check.', seq: 4, time: at(4), source: 'tool:Retain s:elsewhere' },
  { text: 'The release gate rule: every rollout names its owner before it starts.', seq: 5, time: at(10), source: `tool:Retain s:${current.slice(0, 8)}` },
  { text: 'The gate pager rotates weekly among the release crew, and the crew writes the rotation into the release notes before the gate opens for the week.', seq: 6, time: at(12), source: `tool:Retain s:${current.slice(0, 8)}` },
  { text: 'The gate closes for freezes.', seq: 7, time: at(13), source: 'tool:Retain s:elsewhere' },
  { text: 'The gate keeper.', seq: 8, time: at(14), source: 'tool:Retain s:elsewhere' },
  { text: 'Pager gate.', seq: 9, time: at(15), source: 'tool:Retain s:elsewhere' },
] })
deploy.history.push({ text: 'The rollout notes live in the wiki.', seq: 10, time: at(5), source: 'tool:Retain s:elsewhere', supersededBy: 11 })
deploy.history.push({ text: 'The rollout notes live in the handbook.', seq: 11, time: at(6), source: 'tool:Retain s:elsewhere', supersedes: '10', supersededBy: 12 })
deploy.sections.push({ heading: 'notes', entries: [{ text: 'The rollout notes live in the release folder.', seq: 12, time: at(7), source: 'tool:Retain s:elsewhere', supersedes: '11' }] })
writeFileSync(join(dir, docs.docFileName('deploy')), docs.serializeTopicDoc(deploy))
writeFileSync(usage.usagePath(dir), JSON.stringify({ version: 1, rows: { '10': { last: at(20), count: 3 }, '11': { last: at(21), count: 2 }, '12': { last: at(19), count: 1 }, '2': { last: at(18), count: 4 } } }))
appendObservation({ text: 'The gate needs a second reviewer during freezes.', source: `tool:Retain s:${current.slice(0, 8)}` }, dir)

console.log('\n[U] a superseded fact\'s usage weight flows to its replacement, read-only')
{
  const before = readFileSync(usage.usagePath(dir), 'utf8')
  const flowed = links.recallUsage(dir)
  check('the live replacement carries the whole chain\'s opens (1 + 2 + 3)', flowed['12']?.count === 6, JSON.stringify(flowed['12']))
  check('…and the newest use of the chain', flowed['12']?.last === at(21), JSON.stringify(flowed['12']))
  check('a fact with no history keeps its own count', flowed['2']?.count === 4 && flowed['2']?.last === at(18), JSON.stringify(flowed['2']))
  check('history rows keep their own counts (nothing moves out of them)', flowed['10']?.count === 3 && flowed['11']?.count === 2, JSON.stringify([flowed['10'], flowed['11']]))
  check('the usage file is read, never written', readFileSync(usage.usagePath(dir), 'utf8') === before)
}

const now = new Date()
const recallIds = (): string[] => recallQuery('gate', { dir, now, limit: 20 }).hits.map(h => h.id)
const plain = recallIds()

console.log('\n[R] the ruling the work is under comes from the ledger: the current session\'s newest, else the newest standing one')
{
  check('no ruling anywhere, no context', links.currentRuling(footnotes.footnoteContext(dir, ledger.readLedger(key)), current) === undefined)
  check('…and Recall with no ruling in view is the fused order, untouched', JSON.stringify(links.liftRulingLinks(plain, candidates(dir), dir)) === JSON.stringify(plain))
  ledger.openEntry(key, { sessionId: ONE, model: 'engine-one' })
  ledger.recordRuling(key, ONE, 'seq:1')
  ledger.closeEntry(key, ONE, { outcome: 'completed' })
  check('a session that made no ruling works under the newest standing ruling', links.currentRuling(footnotes.footnoteContext(dir, ledger.readLedger(key)), current) === 'seq:1', String(links.currentRuling(footnotes.footnoteContext(dir, ledger.readLedger(key)), current)))
  ledger.openEntry(key, { sessionId: current, model: 'engine-two' })
  ledger.recordRuling(key, current, 'seq:5')
  const ctx = footnotes.footnoteContext(dir, ledger.readLedger(key))
  check('the current session\'s own newest ruling wins', links.currentRuling(ctx, current) === 'seq:5', String(links.currentRuling(ctx, current)))
  check('another session reads its own newest ruling', links.currentRuling(ctx, ONE) === 'seq:1', String(links.currentRuling(ctx, ONE)))
  const pinned = join(SCRATCH, 'pinned-library')
  mkdirSync(pinned, { recursive: true })
  const one = docs.emptyDoc('rules', 'rules', at(0))
  one.sections.push({ heading: 'rules', entries: [{ text: 'Every rollout names its owner.', seq: 1, time: at(1), source: 'tool:Retain s:elsewhere' }] })
  writeFileSync(join(pinned, docs.docFileName('rules')), docs.serializeTopicDoc(one))
  usage.writePins([{ seq: 1, at: at(1) }], pinned)
  check('a pinned rule is a standing ruling with no ledger at all', links.currentRuling(footnotes.footnoteContext(pinned, []), current) === 'seq:1')
}

console.log('\n[F] the footnotes are the source: a fact is linked when its own footnote names the ruling')
{
  const ctx = footnotes.footnoteContext(dir, ledger.readLedger(key))
  const pool = candidates(dir)
  const under5 = links.rulingLinkedIds(pool, 'seq:5', ctx, dir)
  const under1 = links.rulingLinkedIds(pool, 'seq:1', ctx, dir)
  const pendingId = pool.find(c => c.pending)?.id ?? ''
  check('the fact made after the current ruling in its session is linked', under5.has('seq:6'), JSON.stringify([...under5]))
  check('a pending row retained in that session after the ruling is linked too', pendingId !== '' && under5.has(pendingId), JSON.stringify({ pendingId, under5: [...under5] }))
  check('facts of other sessions are not linked to it', !under5.has('seq:2') && !under5.has('seq:3') && !under5.has('seq:7'), JSON.stringify([...under5]))
  check('the earlier ruling links the fact made under it in its own session', under1.has('seq:2') && !under1.has('seq:6'), JSON.stringify([...under1]))
  check('a ruling is not made under itself', !under5.has('seq:5') && !under1.has('seq:1'))
  const six = deploy.sections[0]!.entries.find(e => e.seq === 6)!
  check('seq:6\'s footnote names seq:5, the same footnote Recall prints', footnotes.footnotesOf(six, ctx).ruling === 'seq:5', JSON.stringify(footnotes.footnotesOf(six, ctx)))
}

console.log('\n[Q] Recall lifts what the current ruling governs, by two places at most, and nothing else moves')
{
  const pageBefore = readFileSync(join(dir, docs.docFileName('deploy')), 'utf8')
  const usageBefore = readFileSync(usage.usagePath(dir), 'utf8')
  const lifted = recallIds()
  const ctx = footnotes.footnoteContext(dir, ledger.readLedger(key))
  const linked = links.rulingLinkedIds(candidates(dir), 'seq:5', ctx, dir)
  const governed = plain.filter(id => linked.has(id))
  check('the governed facts are among the hits', governed.length >= 1 && governed.every(id => lifted.includes(id)), JSON.stringify({ governed, plain }))
  check('Recall is exactly the fused order with the governed facts lifted', JSON.stringify(lifted) === JSON.stringify(links.liftLinked(plain, linked)), JSON.stringify({ plain, lifted }))
  for (const id of governed) check(`${id} rises at most two places`, plain.indexOf(id) - lifted.indexOf(id) >= 0 && plain.indexOf(id) - lifted.indexOf(id) <= 2, JSON.stringify({ from: plain.indexOf(id), to: lifted.indexOf(id) }))
  check('the facts the ruling does not govern keep their order among themselves', JSON.stringify(lifted.filter(id => !linked.has(id))) === JSON.stringify(plain.filter(id => !linked.has(id))))
  check('Recall wrote nothing: the page and the usage file are byte for byte the same', readFileSync(join(dir, docs.docFileName('deploy')), 'utf8') === pageBefore && readFileSync(usage.usagePath(dir), 'utf8') === usageBefore)
  check('the ruling\'s own words are verbatim in its page', pageBefore.includes('The release gate rule: every rollout names its owner before it starts.'))
  check('no derived file appears in the library', !existsSync(join(dir, '.index')))
}

console.log('\n[S] the call site is one line: Recall takes the fused order through the lift and the flowed usage')
{
  const verbs = readFileSync(join(ROOT, 'src/mneme/memoryVerbs.ts'), 'utf8')
  const callers = verbs.split('\n').filter(line => line.includes('liftRulingLinks(') || line.includes('recallUsage('))
  check('one line of memoryVerbs.ts calls the links', callers.length === 1 && callers[0]!.includes('fuseRecallRankings('), JSON.stringify(callers))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures > 0 ? `\nprove-memory-links: RED (${failures})` : '\nprove-memory-links: green')
process.exit(failures > 0 ? 1 : 0)
