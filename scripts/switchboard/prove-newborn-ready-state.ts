#!/usr/bin/env bun
// ============================================================================
//  prove-newborn-ready-state — a session born BLANK and never handed a word
//  is READY on every view, never "working / thinking".
//
//  The real-boot finding: New Session ↵ (and the chat
//  /clear births) painted "◐ working" under WORKING on the board and
//  "thinking" in the mirror while the chat's own band said "new session ·
//  <project> · ready" — the record→state ladder (concourseRecordState) read
//  "alive and unsettled" as a turn in flight, which was true when every
//  birth carried a prompt and false since the one door's born-blank births.
//  The request dump proved nothing ran. Law 9 / L16 stage 1: one fact, one
//  word on the board, the mirror and the chat.
//
//  POISON: the pre-fix ladder — a wordless bornBlankAt record answers
//  'working'; the mirror's empty-transcript sentence spoke of a session
//  "starting" for a chat that is simply waiting for words.
// ============================================================================
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'newborn-ready-'))

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { concourseRecordState } = await import('../../src/services/concourse/concourseSnapshot.ts')
const alive = { needsYou: false, alive: true }
const now = Date.now()

// §1 the wordless newborn is READY (the ready-class state), alive or not
//    yet (a warm claim in flight still answers starting — the runner is the
//    fact there).
check('§1 born blank + alive + no words ⇒ ready-to-review', concourseRecordState({ bornBlankAt: now }, alive) === 'ready-to-review')
check('§1 born blank + not alive ⇒ starting (the runner is still the fact)', concourseRecordState({ bornBlankAt: now }, { needsYou: false, alive: false }) === 'starting')

// §2 the first words end the grace: delivered and unsettled ⇒ working; then
//    settled at/after the delivery ⇒ ready-to-review again.
check('§2 born blank + first words delivered, unsettled ⇒ working', concourseRecordState({ bornBlankAt: now, lastDeliveryAt: now + 10 }, alive) === 'working')
check('§2 …settled after the delivery ⇒ ready-to-review', concourseRecordState({ bornBlankAt: now, lastDeliveryAt: now + 10, lastTurnSettledAt: now + 500 }, alive) === 'ready-to-review')

// §3 POISON — the prompt-born world keeps its meaning: no bornBlankAt and no
//    settle stamp is a turn in flight.
check('§3 POISON: a prompt-born record (no bornBlankAt), alive and unsettled ⇒ working', concourseRecordState({}, alive) === 'working')
check('§3 POISON: a prompt-born record, delivered and unsettled ⇒ working', concourseRecordState({ lastDeliveryAt: now }, alive) === 'working')

// §4 the operator's own states still outrank the newborn rung.
check('§4 parked outranks born-blank', concourseRecordState({ bornBlankAt: now, parkedAt: now + 1 }, alive) === 'parked')
check('§4 a crash fact outranks born-blank', concourseRecordState({ bornBlankAt: now, crash: { at: now, reason: 'died' } as never }, alive) === 'needs-you')
check('§4 needs-you liveness outranks born-blank', concourseRecordState({ bornBlankAt: now }, { needsYou: true, alive: true }) === 'needs-you')
check('§4 attached outranks born-blank', concourseRecordState({ bornBlankAt: now, attachedAt: now }, alive) === 'attached')

// §5 the mirror's empty-transcript sentence follows the same fact (source
//    pin: the ready-class newborn is waiting for words, not starting; the
//    working state paints its ACTIVITY, never a claimed phase —
//    wording follows facts, and the fix retired the bare 'thinking'
//    fallback: the row fact is "a turn is live", not which phase.
const { readFileSync } = await import('node:fs')
const mirror = readFileSync(new URL('../../src/components/concourse/SessionMirror.tsx', import.meta.url), 'utf8')
check("§5 the mirror's empty chat names the ready newborn's truth (waiting for words, ↵ enters)", mirror.includes("state === 'ready-to-review'") && mirror.includes('ready for your first words'))
check("§5 the working state paints its activity (glyph + now label), never a claimed phase", /state === 'working' \? \(/.test(mirror) && /state === 'working'\n\s*\? nowLabel/.test(mirror.replace(/\r\n/g, '\n')) && mirror.includes("'working…'"))
check("§5 the bare 'thinking' fallback STAYS retired (a phase claim without the fact re-lies)", !mirror.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*(?:\/\/|\*)/.test(l)).join('\n').includes("'thinking'"))

console.log(failures === 0 ? '\nprove-newborn-ready-state: ALL LAWS HOLD' : `\nprove-newborn-ready-state: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
