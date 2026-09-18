#!/usr/bin/env bun
import { existsSync, mkdtempSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

;(globalThis as any).MACRO = { VERSION: '1.0.0' }

const gates = await import('../../src/utils/tabula/tabulaGates.ts')
const store = await import('../../src/utils/tabula/tabulaStore.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' TABULA store — journal · fold · materialize · isolation')
console.log('============================================================')

const work = mkdtempSync(join(tmpdir(), 'tabula-proof-'))
const prevDir = process.env.MERCURY_TABULA_DIR
const prevTabula = process.env.MERCURY_TABULA

try {
  section('(1) gate shapes')
  delete process.env.MERCURY_TABULA
  process.env.MERCURY_TABULA_DIR = join(work, 'root')
  check('default-ON', gates.isTabulaEnabled() === true)
  process.env.MERCURY_TABULA = '0'
  check('=0 kills', gates.isTabulaEnabled() === false)
  delete process.env.MERCURY_TABULA
  check('dir seam respected', gates.tabulaRoot() === join(work, 'root'))
  const projDir = gates.tabulaProjectDir('/Users/nobody/dev/proj')
  check('project dir keyed by sanitized slug', projDir === join(work, 'root', '-Users-nobody-dev-proj'))

  section('(2) add/edit/pri/done/del fold')
  const dir = gates.tabulaProjectDir('/Users/nobody/dev/proj')
  store.appendEvents(dir, [
    { t: '2026-07-08T10:00:00Z', op: 'add', id: 'aaa111', text: 'ship the relay', pri: 'now' },
    { t: '2026-07-08T10:01:00Z', op: 'add', id: 'bbb222', text: 'refactor the picker' },
    { t: '2026-07-08T10:02:00Z', op: 'add', id: 'ccc333', text: 'write docs', pri: 'later' },
  ])
  let r = store.readNotes(dir)
  check('three notes folded', r.notes.length === 3)
  check('default pri is next', r.notes.find(n => n.id === 'bbb222')?.pri === 'next')
  check('explicit pri kept', r.notes.find(n => n.id === 'aaa111')?.pri === 'now')

  store.appendEvents(dir, [
    { t: '2026-07-08T10:03:00Z', op: 'edit', id: 'bbb222', text: 'refactor the model picker' },
    { t: '2026-07-08T10:04:00Z', op: 'pri', id: 'ccc333', pri: 'now' },
    { t: '2026-07-08T10:05:00Z', op: 'done', id: 'aaa111', done: true },
  ])
  r = store.readNotes(dir)
  check('edit updates text', r.notes.find(n => n.id === 'bbb222')?.text === 'refactor the model picker')
  check('pri moves note', r.notes.find(n => n.id === 'ccc333')?.pri === 'now')
  check('done marks note', r.notes.find(n => n.id === 'aaa111')?.done === true)

  store.appendEvents(dir, [{ t: '2026-07-08T10:06:00Z', op: 'del', id: 'ccc333' }])
  r = store.readNotes(dir)
  check('del removes note', r.notes.length === 2 && !r.notes.some(n => n.id === 'ccc333'))

  store.appendEvents(dir, [
    { t: '2026-07-08T10:07:00Z', op: 'add', id: 'aaa111', text: 'DUPLICATE — must not clobber' },
  ])
  r = store.readNotes(dir)
  check('re-add of live id is a no-op (no clobber)', r.notes.find(n => n.id === 'aaa111')?.text === 'ship the relay')

  section('(3) malformed + partial-tail tolerance')
  appendFileSync(join(dir, 'journal.jsonl'), 'NOT JSON AT ALL\n{"t":"2026-07-08T10:08:00Z","op":"add","id":"ddd4')
  r = store.readNotes(dir)
  check('malformed + partial lines skipped, prior notes intact', r.notes.length === 2)
  store.appendEvents(dir, [{ t: '2026-07-08T10:09:00Z', op: 'add', id: 'eee555', text: 'after the tear' }])
  r = store.readNotes(dir)
  check('appends after a torn tail still fold', r.notes.some(n => n.id === 'eee555'))

  section('(4) leftover curator events (refine · done via:minerva) fold without a crash')
  appendFileSync(
    join(dir, 'journal.jsonl'),
    '{"t":"2026-07-08T10:10:00Z","op":"refine","id":"bbb222","refinedText":"Refactor MercuryModelPicker for the tier rows","baseHash":"abc"}\n' +
      '{"t":"2026-07-08T10:11:00Z","op":"edit","id":"bbb222","text":"refactor the model picker rows"}\n' +
      '{"t":"2026-07-08T10:12:00Z","op":"done","id":"eee555","done":true,"via":"minerva"}\n',
  )
  r = store.readNotes(dir)
  check('the refine event is skipped; the note keeps its operator text', r.notes.find(n => n.id === 'bbb222')?.text === 'refactor the model picker rows' && !('refinedText' in (r.notes.find(n => n.id === 'bbb222') as object)))
  check('a done via:minerva stays done, its provenance dropped at parse', r.notes.find(n => n.id === 'eee555')?.done === true && r.notes.find(n => n.id === 'eee555')?.doneVia === undefined)
  check('nothing else was lost', r.notes.length === 3)
  store.appendEvents(dir, [{ t: '2026-07-08T10:13:00Z', op: 'done', id: 'eee555', done: false }])
  r = store.readNotes(dir)
  check('the leftover-done note reopens like any other', r.notes.find(n => n.id === 'eee555')?.done === false)

  section('(5) order')
  store.appendEvents(dir, [{ t: '2026-07-08T10:14:00Z', op: 'order', ids: ['eee555', 'bbb222'] }])
  r = store.readNotes(dir)
  check('ordered ids lead', r.notes[0]?.id === 'eee555' && r.notes[1]?.id === 'bbb222')
  check('unknown-to-order ids appended, never dropped', r.notes.some(n => n.id === 'aaa111'))

  section('(5b) fire + done-via (the sent→worked→green loop)')
  const fdir = gates.tabulaProjectDir('/Users/nobody/dev/fire-proj')
  store.appendEvents(fdir, [
    { t: '2026-07-09T09:00:00Z', op: 'add', id: 'fff111', text: 'wire the relay board' },
  ])
  store.appendEvents(fdir, [{ t: '2026-07-09T09:01:00Z', op: 'fire', id: 'fff111' }])
  let fr = store.readNotes(fdir)
  check('fire stamps firedAt', fr.notes[0]?.firedAt === '2026-07-09T09:01:00Z')
  store.appendEvents(fdir, [{ t: '2026-07-09T09:02:00Z', op: 'edit', id: 'fff111', text: 'wire the relay board v2' }])
  fr = store.readNotes(fdir)
  check('edit clears firedAt (new words, not sent)', fr.notes[0]?.firedAt === undefined)
  store.appendEvents(fdir, [
    { t: '2026-07-09T09:03:00Z', op: 'fire', id: 'fff111' },
    { t: '2026-07-09T09:04:00Z', op: 'done', id: 'fff111', done: true, via: 'auto' },
  ])
  fr = store.readNotes(fdir)
  check('auto-done lands with provenance', fr.notes[0]?.done === true && fr.notes[0]?.doneVia === 'auto')
  store.appendEvents(fdir, [{ t: '2026-07-09T09:05:00Z', op: 'done', id: 'fff111', done: false }])
  fr = store.readNotes(fdir)
  check('reopen clears doneVia + firedAt', fr.notes[0]?.done === false && fr.notes[0]?.doneVia === undefined && fr.notes[0]?.firedAt === undefined)
  store.appendEvents(fdir, [
    { t: '2026-07-09T09:06:00Z', op: 'done', id: 'fff111', done: true, via: 'auto' },
    { t: '2026-07-09T09:07:00Z', op: 'done', id: 'fff111', done: true },
  ])
  fr = store.readNotes(fdir)
  check('latest closing provenance wins (operator re-mark clears via)', fr.notes[0]?.doneVia === undefined)
  store.appendEvents(fdir, [{ t: '2026-07-09T09:08:00Z', op: 'fire', id: 'zzz-unknown' }])
  check('dangling-id fire tolerated', store.readNotes(fdir).notes.length === 1)
  check('bogus via parsed away, done still folds', (() => {
    appendFileSync(join(fdir, 'journal.jsonl'), '{"t":"2026-07-09T09:09:00Z","op":"done","id":"fff111","done":true,"via":"EVIL"}\n')
    const n = store.readNotes(fdir).notes[0]
    return n?.done === true && n?.doneVia === undefined
  })())

  section('(5c) fireTracker (arm/submit/stop semantics)')
  const tracker = await import('../../src/utils/tabula/fireTracker.ts')
  const tdir = gates.tabulaProjectDir('/Users/nobody/dev/tracker-proj')
  store.appendEvents(tdir, [
    { t: '2026-07-09T10:00:00Z', op: 'add', id: 'ttt111', text: 'benchmark the pooled gate' },
    { t: '2026-07-09T10:00:01Z', op: 'add', id: 'ttt222', text: 'polish the splash card' },
  ])
  tracker.resetTabulaFireTrackerForTest()
  tracker.armNoteFire({ id: 'ttt111', insertedText: 'benchmark the pooled gate', dir: tdir, projectName: 'tracker-proj' })
  tracker.tabulaOnPromptSubmit('please benchmark the pooled gate at 4 slots and report')
  let tr = store.readNotes(tdir)
  check('carried text ⇒ fire event lands', tr.notes.find(n => n.id === 'ttt111')?.firedAt !== undefined)
  check('unarmed sibling untouched', tr.notes.find(n => n.id === 'ttt222')?.firedAt === undefined)
  tracker.tabulaOnTurnStop()
  tr = store.readNotes(tdir)
  check('clean stop settles done via auto', tr.notes.find(n => n.id === 'ttt111')?.done === true && tr.notes.find(n => n.id === 'ttt111')?.doneVia === 'auto')
  check('second stop is a no-op (in-flight consumed)', (() => {
    const bytes = store.readNotes(tdir).journalBytes
    tracker.tabulaOnTurnStop()
    return store.readNotes(tdir).journalBytes === bytes
  })())
  tracker.armNoteFire({ id: 'ttt222', insertedText: 'polish the splash card', dir: tdir, projectName: 'tracker-proj' })
  tracker.tabulaOnPromptSubmit('actually do something completely different')
  tracker.tabulaOnTurnStop()
  tr = store.readNotes(tdir)
  check('rewritten prompt ⇒ no fire, no auto-done', tr.notes.find(n => n.id === 'ttt222')?.done === false && tr.notes.find(n => n.id === 'ttt222')?.firedAt === undefined)
  tracker.tabulaOnPromptSubmit('polish the splash card please')
  tr = store.readNotes(tdir)
  check('still-armed note fires on a later carrying submit', tr.notes.find(n => n.id === 'ttt222')?.firedAt !== undefined)
  tracker.tabulaOnPromptSubmit('a new unrelated turn (the last one aborted)')
  tracker.tabulaOnTurnStop()
  tr = store.readNotes(tdir)
  check('aborted-turn fire expired ⇒ never auto-done by a later turn', tr.notes.find(n => n.id === 'ttt222')?.done === false)

  section('(6) two-writer append')
  const dir2 = gates.tabulaProjectDir('/Users/nobody/dev/concurrent')
  const N = 40
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      Promise.resolve().then(() =>
        store.appendEvents(dir2, [{ t: `2026-07-08T11:00:${String(i % 60).padStart(2, '0')}Z`, op: 'add', id: `id${i}`, text: `note ${i}` }]),
      ),
    ),
  )
  const r2 = store.readNotes(dir2)
  check(`all ${N} concurrent adds survive`, r2.notes.length === N, `got ${r2.notes.length}`)

  section('(7) deterministic notepad.md')
  const md1 = store.materializeNotepad(dir, 'proj')
  const md2 = store.materializeNotepad(dir, 'proj')
  check('byte-identical across runs', md1 === md2)
  check('sections present', md1.includes('## Now') && md1.includes('## Done'))
  check('generated-file footer (the /note pointer)', md1.includes('`/note <text>` captures'))
  check('notepad.md written', existsSync(join(dir, 'notepad.md')))
  check('no wall-clock in output (uses latest event stamp)', md1.includes('2026-07-08T10:14:00Z') || md1.includes('2026-07-08'))

  section('(8) OFF ⇒ no dir creation, empty reads')
  process.env.MERCURY_TABULA = '0'
  const offDir = join(work, 'root', '-off-target')
  store.appendEvents(offDir, [{ t: '2026-07-08T12:00:00Z', op: 'add', id: 'off', text: 'never lands' }])
  check('OFF append is a no-op (no dir)', !existsSync(offDir))
  check('OFF read is empty', store.readNotes(offDir).notes.length === 0)
  delete process.env.MERCURY_TABULA
} finally {
  if (prevDir === undefined) delete process.env.MERCURY_TABULA_DIR
  else process.env.MERCURY_TABULA_DIR = prevDir
  if (prevTabula === undefined) delete process.env.MERCURY_TABULA
  else process.env.MERCURY_TABULA = prevTabula
  rmSync(work, { recursive: true, force: true })
}

console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ' ✅ TABULA STORE PASS' : ` ❌ TABULA STORE — ${failures} failure(s)`)
console.log('='.repeat(60))
process.exit(failures === 0 ? 0 : 1)
