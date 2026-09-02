#!/usr/bin/env bun
// ============================================================================
//  scripts/notifications/prove-session-drafts.ts — R4
//  (INPUT-ISOLATION): the attached-session composer drafts are
//  isolated per SESSION across projects, durable across process boundaries
//  (a fresh store read = a fresh mount), independent of the new-session
//  draft and the root composer, and BOUNDED (the cap sheds oldest first).
//  Pure store legs over the ONE durable owner (concourseSnapshot draft
//  store) — the PTY journey (prove-session-attach) drives the surface.
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'
import {
  readConcourseDraft,
  readConcourseSessionDraft,
  readConcourseSessionDraftState,
  readCoordinatorComposerDraft,
  writeConcourseDraft,
  writeConcourseSessionDraft,
  writeCoordinatorComposerDraft,
} from '../../src/services/concourse/concourseSnapshot.ts'

const t = checker()
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'session-drafts-')))

t.section('§1 — five sessions, two projects: every draft its own key')
{
  // Session ids as the daemon mints them — two "projects" appear only in the
  // ids here because the STORE keys by sessionId alone (project separation
  // rides the session identity; the same store file serves both).
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
  // A fresh read IS the fresh-mount path (the store re-reads the file).
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
  // A caret-less legacy write resolves end-of-text (the pre-caret law).
  await writeConcourseSessionDraft('caret-legacy', 'old shape', dir)
  const legacy = await readConcourseSessionDraftState('caret-legacy', dir)
  t.check('a caret-less write reads back at end-of-text', legacy.text === 'old shape' && legacy.caret === 9, `${JSON.stringify(legacy)}`)
  // Clearing the text sheds its caret with it (carets shadow the draft keys).
  await writeConcourseSessionDraft('caret-session', '', dir)
  const cleared = await readConcourseSessionDraftState('caret-session', dir)
  t.check('an empty write clears text AND caret', cleared.text === '' && cleared.caret === 0, `${JSON.stringify(cleared)}`)
}

t.section('§6 — CU-05: the coordinator composer draft is durable, isolated, clear-on-empty')
{
  await writeCoordinatorComposerDraft('ask the board something', 7, dir)
  const d = await readCoordinatorComposerDraft(dir)
  t.check('the coordinator draft round-trips text + caret', d.text === 'ask the board something' && d.caret === 7, `${JSON.stringify(d)}`)
  t.check('it never bleeds into the new-session strip draft', (await readConcourseDraft(dir)) === 'the new-session strip draft')
  t.check('it never bleeds into a session draft', (await readConcourseSessionDraft('caret-legacy', dir)) === 'old shape')
  await writeCoordinatorComposerDraft('', 0, dir)
  const cleared = await readCoordinatorComposerDraft(dir)
  t.check('the accepted-send clear empties it', cleared.text === '' && cleared.caret === 0, `${JSON.stringify(cleared)}`)
}

rmSync(dir, { recursive: true, force: true })
t.finish('prove-session-drafts')
