#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'newborn-ready-'))

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  const shown = cond ? detail : [detail, 'change the state precedence of concourseRecordState (exported by src/daemon/concourse-workers/concourseWorkers.ts) so a born-blank record reads this state'].filter(Boolean).join(' — ')
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
}

const { concourseRecordState } = await import('../../src/daemon/concourse-workers/concourseWorkers.ts')
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


console.log(failures === 0 ? '\nprove-newborn-ready-state: ALL LAWS HOLD' : `\nprove-newborn-ready-state: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
