#!/usr/bin/env bun
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

check('§1 born blank + alive + no words ⇒ ready-to-review', concourseRecordState({ bornBlankAt: now }, alive) === 'ready-to-review')
check('§1 born blank + not alive ⇒ starting (the runner is still the fact)', concourseRecordState({ bornBlankAt: now }, { needsYou: false, alive: false }) === 'starting')

check('§2 born blank + first words delivered, unsettled ⇒ working', concourseRecordState({ bornBlankAt: now, lastDeliveryAt: now + 10 }, alive) === 'working')
check('§2 …settled after the delivery ⇒ ready-to-review', concourseRecordState({ bornBlankAt: now, lastDeliveryAt: now + 10, lastTurnSettledAt: now + 500 }, alive) === 'ready-to-review')

check('§3 POISON: a prompt-born record (no bornBlankAt), alive and unsettled ⇒ working', concourseRecordState({}, alive) === 'working')
check('§3 POISON: a prompt-born record, delivered and unsettled ⇒ working', concourseRecordState({ lastDeliveryAt: now }, alive) === 'working')

check('§4 parked outranks born-blank', concourseRecordState({ bornBlankAt: now, parkedAt: now + 1 }, alive) === 'parked')
check('§4 a crash fact outranks born-blank', concourseRecordState({ bornBlankAt: now, crash: { at: now, reason: 'died' } as never }, alive) === 'needs-you')
check('§4 needs-you liveness outranks born-blank', concourseRecordState({ bornBlankAt: now }, { needsYou: true, alive: true }) === 'needs-you')
check('§4 attached outranks born-blank', concourseRecordState({ bornBlankAt: now, attachedAt: now }, alive) === 'attached')

const { readFileSync } = await import('node:fs')
const mirror = readFileSync(new URL('../../src/components/concourse/SessionMirror.tsx', import.meta.url), 'utf8')
check("§5 the mirror's empty chat names the ready newborn's truth (waiting for words, ↵ enters)", mirror.includes("state === 'ready-to-review'") && mirror.includes('ready for your first words'))
check("§5 the working state paints its activity (glyph + now label), never a claimed phase", /state === 'working' \? \(/.test(mirror) && /state === 'working'\n\s*\? nowLabel/.test(mirror.replace(/\r\n/g, '\n')) && mirror.includes("'working…'"))
check("§5 the bare 'thinking' fallback STAYS retired (a phase claim without the fact re-lies)", !mirror.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !/^\s*(?:\/\/|\*)/.test(l)).join('\n').includes("'thinking'"))

console.log(failures === 0 ? '\nprove-newborn-ready-state: ALL LAWS HOLD' : `\nprove-newborn-ready-state: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
