#!/usr/bin/env bun
// ============================================================================
//  scripts/seat-slots/prove-seat-retarget.ts
//  PROOF: the seat-target parser + reconfigure caller for the two surviving
//  roles (the party seats retired with the multiplayer estate's C10
//  residue). Token table both polarities (the scribe pair gated on scribe
//  mode/feature — a plain session treats seat tokens as ordinary args), the
//  local-vs-daemon discriminator (scribe = foreground pin), and the command
//  wiring (structural).
//  Run:  ~/.bun/bin/bun run scripts/seat-slots/prove-seat-retarget.ts
// ============================================================================
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void { console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76)) }
const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')

console.log('============================================================')
console.log(' Seat retargeting — proof')
console.log('============================================================')

// Hermetic config home: reconfigureSeat PERSISTS an operator reslot before
// the RPC — the proof must never write the real seat-slots.json, and the
// control socket must deterministically not exist.
const ENV_KEYS = ['MERCURY_CONFIG_DIR', 'MERCURY_HOME'] as const
const stash: Record<string, string | undefined> = {}
for (const k of ENV_KEYS) { stash[k] = process.env[k]; delete process.env[k] }
process.env.MERCURY_CONFIG_DIR = `/tmp/hermes-prove-seat-retarget-${process.pid}`

const ri = (await import('../../src/utils/scribe/reconfigureImplementer.js')) as typeof import('../../src/utils/scribe/reconfigureImplementer.js')

section('parseSeatTargetArg — token table (gating both polarities)')
const scribeOn = { scribeOn: true }
const featureOnly = { scribeOn: false, scribeFeatureOn: true }
const neither = { scribeOn: false }

const t1 = ri.parseSeatTargetArg('implementer sonnet5', scribeOn)
check("'implementer sonnet5' ⇒ daemon implementer, rest='sonnet5'", t1.seat?.target === 'implementer' && t1.seat?.kind === 'daemon' && t1.rest === 'sonnet5')
const t2 = ri.parseSeatTargetArg('scribe opus', scribeOn)
check("'scribe opus' ⇒ LOCAL scribe (foreground pin)", t2.seat?.target === 'scribe' && t2.seat?.kind === 'local' && t2.rest === 'opus')
check('case-folded (IMPLEMENTER ⇒ implementer)', ri.parseSeatTargetArg('IMPLEMENTER opus', scribeOn).seat?.target === 'implementer')

section('gating — tokens only parse when their mode/feature is on')
check('L-6: the implementer token parses on the FEATURE alone (durable slot intent)', ri.parseSeatTargetArg('implementer x', featureOnly).seat?.target === 'implementer')
check('the scribe token needs the ENGAGEMENT (a foreground pin is session state)', ri.parseSeatTargetArg('scribe x', featureOnly).seat === null)
check('neither ⇒ everything is ordinary args', ri.parseSeatTargetArg('implementer x', neither).seat === null && ri.parseSeatTargetArg('scribe x', neither).seat === null)
check('non-seat text ⇒ null + text preserved', ri.parseSeatTargetArg('opus[1m]', scribeOn).seat === null && ri.parseSeatTargetArg('opus[1m]', scribeOn).rest === 'opus[1m]')
check("a RETIRED seat token is ordinary args ('tank' parses as nothing)", ri.parseSeatTargetArg('tank fable', scribeOn).seat === null && ri.parseSeatTargetArg('dps2 x', scribeOn).seat === null)

section('reconfigureSeat — the generalized caller (unreachable-daemon honesty)')
const msg = await ri.reconfigureSeat('implementer', { model: 'fable' })
check('implementer retarget degrades honestly with no daemon', /not reachable|failed|error/i.test(msg), msg)
check('message names the seat label', /Implementer/.test(msg), msg)
check('unreachable-daemon reslot still SAVES the slot (applies at next engage)', /Slot saved — applies at the next engage/.test(msg), msg)
const impl = await ri.reconfigureImplementer({ model: 'sonnet5' })
check('reconfigureImplementer alias still works (Implementer label)', /Implementer/.test(impl), impl)

section('muster persist-first: refusals short-circuit BEFORE the RPC')
const junkRefusal = await ri.reconfigureSeat('implementer', { model: 'haiku' })
check('haiku refused with the honest note (never RPCs)', /Refused: .*Haiku-tier/.test(junkRefusal) && !/not reachable/.test(junkRefusal), junkRefusal)
{
  const ss = (await import('../../src/utils/model/seatSlots.js')) as typeof import('../../src/utils/model/seatSlots.js')
  const slots = ss.readPersistedSeatSlots()
  check('the sonnet5 implementer reslot persisted; the refusal did not', slots.implementer?.model === 'claude-sonnet-5', JSON.stringify(slots))
}

section('command wiring (structural) — /model + /effort route seat tokens')
const hm = src('commands', 'model', 'mercuryModel.tsx')
check('/model uses parseSeatTargetArg with the scribe gates', /parseSeatTargetArg\(trimmed, \{\s*\n?\s*scribeOn: isScribeModeOn\(\),\s*\n?\s*scribeFeatureOn: scribeModeEnabled\(\),/.test(hm))
check('/model daemon seats route through ApplySeatModelReconfigure', /ApplySeatModelReconfigure short=\{seat\.target/.test(hm))
const ef = src('commands', 'effort', 'effort.tsx')
check('/effort uses parseSeatTargetArg with the scribe gates', /parseSeatTargetArg\(trimmed, \{\s*\n?\s*scribeOn: isScribeModeOn\(\),\s*\n?\s*scribeFeatureOn: scribeModeEnabled\(\),/.test(ef))
check('/effort daemon seats route through SeatReconfigure on the parsed seat', /<SeatReconfigure\s*\n?\s*seat=\{seat\.target as ReconfigurableSeat\}/.test(ef))

section('never-Haiku hole on the LOCAL seat closed at the ONE owner')
// '/model scribe <m>' no longer strips-and-falls-through to the base
// foreground set (which accepts haiku AND — since the typed-path mode-exit
// parity — would EXIT the very mode the seat belongs to). The local seat
// routes through ApplyLocalSeatReslot → applyOperatorReslot →
// setOperatorSeatSlot: the same validated fail-closed law (never-Haiku, the
// seat families) every other reslot surface consults — the F2 text-path
// bypass closes at the owner, not a local pre-check.
const hmv = src('commands', 'model', 'mercuryModel.tsx')
check("local seat + a model arg ⇒ ApplyLocalSeatReslot (never the legacy fall-through)", /seat\.kind === 'local'[\s\S]{0,900}ApplyLocalSeatReslot role=\{seat\.t/.test(hmv))
check('ApplyLocalSeatReslot rides the ONE reslot seam (applyOperatorReslot)', /function ApplyLocalSeatReslot[\s\S]{0,700}applyOperatorReslot\(role, \{ model \}/.test(hmv))
check('the bare local token still falls through to the picker (no empty-model reslot)', /effectiveArgs = rest \/\/ bare seat token/.test(hmv))

// restore env + scrub the temp home
{
  const { rmSync } = await import('node:fs')
  rmSync(process.env.MERCURY_CONFIG_DIR!, { recursive: true, force: true })
}
for (const k of ENV_KEYS) { if (stash[k] !== undefined) process.env[k] = stash[k]; else delete process.env[k] }

console.log('\n' + '='.repeat(60))
if (failures > 0) { console.log(` FAIL — ${failures} check(s) failed`); process.exit(1) }
console.log(' ALL SEAT-RETARGET PROOFS PASS')
