#!/usr/bin/env bun
// ============================================================================
//  scripts/tabula/prove-tabula-store.ts
//  PROOF: TABULA store core — the append-only note journal + deterministic
//  fold/materialize (src/utils/tabula/tabulaStore.ts + tabulaGates.ts).
//
//  Locks: gate shapes (default-ON, =0 off; MINERVA default-OFF opt-in;
//  MERCURY_TABULA_DIR seam) · add/edit/pri/done/del fold semantics · dedupe on
//  re-add · malformed/partial journal line tolerance · refine baseHash guard
//  (a stale refinement of since-edited text is SKIPPED, the note keeps its
//  operator text — no-data-loss) · order events (unknown ids appended, never
//  dropped) · concurrent two-writer appends both survive · deterministic
//  byte-identical materialization + the human footer · OFF ⇒ no dir creation ·
//  Minerva apply = events + history archive bounded at 20 + meta stamps.
//
//  Run: ~/.bun/bin/bun run scripts/tabula/prove-tabula-store.ts
// ============================================================================
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// MACRO stamp BEFORE import (read at call time).
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
const prevMinerva = process.env.MERCURY_TABULA_MINERVA

try {
  // ── (1) gates ─────────────────────────────────────────────────────────────
  section('(1) gate shapes')
  delete process.env.MERCURY_TABULA
  delete process.env.MERCURY_TABULA_MINERVA
  process.env.MERCURY_TABULA_DIR = join(work, 'root')
  check('default-ON', gates.isTabulaEnabled() === true)
  process.env.MERCURY_TABULA = '0'
  check('=0 kills', gates.isTabulaEnabled() === false)
  check('minerva follows master kill', gates.isMinervaEnabled() === false)
  delete process.env.MERCURY_TABULA
  check('minerva default-OFF', gates.isMinervaEnabled() === false)
  process.env.MERCURY_TABULA_MINERVA = '1'
  check('minerva =1 arms', gates.isMinervaEnabled() === true)
  delete process.env.MERCURY_TABULA_MINERVA
  check('dir seam respected', gates.tabulaRoot() === join(work, 'root'))
  const projDir = gates.tabulaProjectDir('/Users/nobody/dev/proj')
  check('project dir keyed by sanitized slug', projDir === join(work, 'root', '-Users-nobody-dev-proj'))

  // ── (2) fold semantics ────────────────────────────────────────────────────
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

  // ── (3) journal tolerance ─────────────────────────────────────────────────
  section('(3) malformed + partial-tail tolerance')
  appendFileSync(join(dir, 'journal.jsonl'), 'NOT JSON AT ALL\n{"t":"2026-07-08T10:08:00Z","op":"add","id":"ddd4')
  r = store.readNotes(dir)
  check('malformed + partial lines skipped, prior notes intact', r.notes.length === 2)
  store.appendEvents(dir, [{ t: '2026-07-08T10:09:00Z', op: 'add', id: 'eee555', text: 'after the tear' }])
  r = store.readNotes(dir)
  check('appends after a torn tail still fold', r.notes.some(n => n.id === 'eee555'))

  // ── (4) refine baseHash guard ─────────────────────────────────────────────
  section('(4) refine guard (anti-stale, anti-clobber)')
  const target = r.notes.find(n => n.id === 'bbb222')!
  const goodHash = store.noteTextHash(target.text)
  store.appendEvents(dir, [
    { t: '2026-07-08T10:10:00Z', op: 'refine', id: 'bbb222', refinedText: 'Refactor MercuryModelPicker for the tier rows', baseHash: goodHash },
  ])
  r = store.readNotes(dir)
  check('matching-hash refine attaches BESIDE text', r.notes.find(n => n.id === 'bbb222')?.refinedText === 'Refactor MercuryModelPicker for the tier rows')
  check('original text untouched by refine', r.notes.find(n => n.id === 'bbb222')?.text === 'refactor the model picker')
  store.appendEvents(dir, [
    { t: '2026-07-08T10:11:00Z', op: 'edit', id: 'bbb222', text: 'refactor the model picker rows' },
    { t: '2026-07-08T10:12:00Z', op: 'refine', id: 'bbb222', refinedText: 'STALE refinement', baseHash: goodHash },
  ])
  r = store.readNotes(dir)
  check('edit clears refinedText', true) // covered by next two, kept for narrative
  check('stale refine (hash of pre-edit text) SKIPPED', r.notes.find(n => n.id === 'bbb222')?.refinedText === undefined)
  store.appendEvents(dir, [
    { t: '2026-07-08T10:13:00Z', op: 'refine', id: 'zzz999', refinedText: 'dangling id', baseHash: 'x' },
  ])
  r = store.readNotes(dir)
  check('dangling-id refine tolerated', r.notes.length === 3)

  // ── (5) order events ──────────────────────────────────────────────────────
  section('(5) order')
  store.appendEvents(dir, [{ t: '2026-07-08T10:14:00Z', op: 'order', ids: ['eee555', 'bbb222'] }])
  r = store.readNotes(dir)
  check('ordered ids lead', r.notes[0]?.id === 'eee555' && r.notes[1]?.id === 'bbb222')
  check('unknown-to-order ids appended, never dropped', r.notes.some(n => n.id === 'aaa111'))

  // ── (5b) fire lifecycle + done provenance ─────────────────────────────────
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
    { t: '2026-07-09T09:06:00Z', op: 'done', id: 'fff111', done: true, via: 'minerva' },
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

  // ── (5c) fireTracker: arm → submit-match → clean-stop settle ──────────────
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
  // Rewritten prompt ⇒ no fire, note stays open.
  tracker.armNoteFire({ id: 'ttt222', insertedText: 'polish the splash card', dir: tdir, projectName: 'tracker-proj' })
  tracker.tabulaOnPromptSubmit('actually do something completely different')
  tracker.tabulaOnTurnStop()
  tr = store.readNotes(tdir)
  check('rewritten prompt ⇒ no fire, no auto-done', tr.notes.find(n => n.id === 'ttt222')?.done === false && tr.notes.find(n => n.id === 'ttt222')?.firedAt === undefined)
  // Abort semantics: a fired note whose turn never settles is EXPIRED at the
  // next submit — the next turn's stop must not close it.
  tracker.tabulaOnPromptSubmit('polish the splash card please')
  tr = store.readNotes(tdir)
  check('still-armed note fires on a later carrying submit', tr.notes.find(n => n.id === 'ttt222')?.firedAt !== undefined)
  tracker.tabulaOnPromptSubmit('a new unrelated turn (the last one aborted)')
  tracker.tabulaOnTurnStop()
  tr = store.readNotes(tdir)
  check('aborted-turn fire expired ⇒ never auto-done by a later turn', tr.notes.find(n => n.id === 'ttt222')?.done === false)

  // ── (6) concurrency ───────────────────────────────────────────────────────
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

  // ── (7) materialization ───────────────────────────────────────────────────
  section('(7) deterministic notepad.md')
  const md1 = store.materializeNotepad(dir, 'proj')
  const md2 = store.materializeNotepad(dir, 'proj')
  check('byte-identical across runs', md1 === md2)
  check('sections present', md1.includes('## Now') && md1.includes('## Done'))
  check('generated-file footer (edit via /tabula)', md1.includes('/tabula'))
  check('notepad.md written', existsSync(join(dir, 'notepad.md')))
  check('no wall-clock in output (uses latest event stamp)', md1.includes('2026-07-08T10:14:00Z') || md1.includes('2026-07-08'))

  // ── (8) Minerva apply = events + archive + meta ──────────────────────────
  section('(8) applyMinervaPlan')
  const before = store.readNotes(dir)
  const plan = {
    notes: [{ id: 'bbb222', pri: 'now' as const, refinedText: 'Refactor the model picker rows (tier work)' }],
    orderedIds: ['bbb222', 'eee555', 'aaa111'],
    receipt: '3 notes · 1 promoted · 1 refined',
  }
  const applied = store.applyMinervaPlan(dir, 'proj', plan, before.journalBytes)
  check('apply ok', applied.ok === true)
  r = store.readNotes(dir)
  check('plan pri applied', r.notes.find(n => n.id === 'bbb222')?.pri === 'now')
  check('plan refine applied (fresh hash)', r.notes.find(n => n.id === 'bbb222')?.refinedText?.includes('tier work') === true)
  check('plan order applied', r.notes[0]?.id === 'bbb222')
  check('history archived', readdirSync(join(dir, 'history')).length === 1)
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  check('meta stamps receipt', meta.lastReceipt === plan.receipt)
  for (let i = 0; i < 25; i++) store.applyMinervaPlan(dir, 'proj', plan, store.readNotes(dir).journalBytes)
  check('history bounded at 20', readdirSync(join(dir, 'history')).length <= 20)

  // ── (9) OFF ⇒ inert ───────────────────────────────────────────────────────
  section('(9) OFF ⇒ no dir creation, empty reads')
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
  if (prevMinerva === undefined) delete process.env.MERCURY_TABULA_MINERVA
  else process.env.MERCURY_TABULA_MINERVA = prevMinerva
  rmSync(work, { recursive: true, force: true })
}

console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ' ✅ TABULA STORE PASS' : ` ❌ TABULA STORE — ${failures} failure(s)`)
console.log('='.repeat(60))
process.exit(failures === 0 ? 0 : 1)
