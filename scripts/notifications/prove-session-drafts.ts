#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import {
  readConcourseDraft,
  readConcourseSessionDraft,
  readConcourseSessionDraftState,
  writeConcourseDraft,
  writeConcourseSessionDraft,
} from '../../src/services/concourse/concourseSnapshot.ts'

const t = checker()
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'session-drafts-')))

t.section('§1 — five sessions, two projects: every draft its own key')
{
  const sessions = ['p1-alpha', 'p1-beta', 'p1-gamma', 'p2-delta', 'p2-epsilon']
  for (const [i, s] of sessions.entries()) await writeConcourseSessionDraft(s, `draft for ${s} #${i}`, dir)
  let all = true
  for (const [i, s] of sessions.entries()) {
    const got = await readConcourseSessionDraft(s, dir)
    if (got !== `draft for ${s} #${i}`) all = false
  }
  t.check('each of five sessions reads back exactly its own draft', all)
  await writeConcourseSessionDraft('p1-beta', 'rewritten beta', dir)
  t.check('rewriting one session leaves the others untouched', (await readConcourseSessionDraft('p1-alpha', dir)) === 'draft for p1-alpha #0' && (await readConcourseSessionDraft('p1-beta', dir)) === 'rewritten beta')
}

t.section('§2 — the session drafts never bleed into the new-session draft')
{
  await writeConcourseDraft('the new-session strip draft', dir)
  t.check('the strip draft is its own field', (await readConcourseDraft(dir)) === 'the new-session strip draft')
  t.check('a session draft did not clobber it', (await readConcourseSessionDraft('p1-alpha', dir)) !== (await readConcourseDraft(dir)))
  await writeConcourseSessionDraft('p1-alpha', 'changed alpha', dir)
  t.check('writing a session draft leaves the strip draft alone', (await readConcourseDraft(dir)) === 'the new-session strip draft')
}

t.section('§3 — durability + clear semantics')
{
  t.check('a fresh read returns the durable draft', (await readConcourseSessionDraft('p2-delta', dir)) === 'draft for p2-delta #3')
  await writeConcourseSessionDraft('p2-delta', '', dir)
  t.check('an empty write clears the key (delivery clears the composer)', (await readConcourseSessionDraft('p2-delta', dir)) === '')
}

t.section('§4 — the cap sheds oldest first, never the newest')
{
  for (let i = 0; i < 30; i++) await writeConcourseSessionDraft(`bulk-${i}`, `text ${i}`, dir)
  t.check('the newest survives the cap', (await readConcourseSessionDraft('bulk-29', dir)) === 'text 29')
  t.check('the oldest shed', (await readConcourseSessionDraft('bulk-0', dir)) === '')
}

t.section('§5 — CU-05+AR-11: the caret rides beside the text (never end-of-text resets)')
{
  await writeConcourseSessionDraft('caret-session', 'hello caret', dir, 5)
  const st = await readConcourseSessionDraftState('caret-session', dir)
  t.check('text + caret round-trip exactly', st.text === 'hello caret' && st.caret === 5, `${JSON.stringify(st)}`)
  await writeConcourseSessionDraft('caret-legacy', 'old shape', dir)
  const legacy = await readConcourseSessionDraftState('caret-legacy', dir)
  t.check('a caret-less write reads back at end-of-text', legacy.text === 'old shape' && legacy.caret === 9, `${JSON.stringify(legacy)}`)
  await writeConcourseSessionDraft('caret-session', '', dir)
  const cleared = await readConcourseSessionDraftState('caret-session', dir)
  t.check('an empty write clears text AND caret', cleared.text === '' && cleared.caret === 0, `${JSON.stringify(cleared)}`)
}

t.section('§6 — a draft an earlier version left in its coordinator composer is carried through every write, read by nothing')
{
  const file = join(dir, 'concourse-draft.json')
  const before = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  writeFileSync(file, JSON.stringify({ ...before, coordinatorDraft: 'ask the board something', coordinatorDraftCaret: 7, aFieldNoVersionKnew: 'x' }))
  await new Promise(r => setTimeout(r, 1200))
  await writeConcourseSessionDraft('carry-session', 'a later write of another field', dir, 3)
  const afterSession = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  t.check('a session draft written later leaves the text and its caret in the file', afterSession.coordinatorDraft === 'ask the board something' && afterSession.coordinatorDraftCaret === 7, JSON.stringify({ text: afterSession.coordinatorDraft, caret: afterSession.coordinatorDraftCaret }))
  await writeConcourseDraft('the new-session strip draft', dir)
  const afterStrip = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  t.check('…and so does a write of the new-session draft', afterStrip.coordinatorDraft === 'ask the board something' && afterStrip.coordinatorDraftCaret === 7, JSON.stringify({ text: afterStrip.coordinatorDraft, caret: afterStrip.coordinatorDraftCaret }))
  t.check('the store drops a field its decoder does not name (why the two stay named)', afterSession.aFieldNoVersionKnew === undefined)
  t.check('it never bleeds into the new-session strip draft', (await readConcourseDraft(dir)) === 'the new-session strip draft')
  t.check('it never bleeds into a session draft', (await readConcourseSessionDraft('caret-legacy', dir)) === 'old shape')
  const snapshotSrc = readFileSync(join(import.meta.dir, '..', '..', 'src', 'services', 'concourse', 'concourseSnapshot.ts'), 'utf8')
  t.check('nothing in the store reads or writes the two fields but its decoder', !/file\.coordinatorDraft|value\.coordinatorDraft|coordinatorDraft: clamped|coordinatorDraft: undefined/.test(snapshotSrc))
}

rmSync(dir, { recursive: true, force: true })
t.finish('prove-session-drafts')
