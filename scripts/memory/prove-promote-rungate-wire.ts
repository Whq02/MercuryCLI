#!/usr/bin/env bun
// scripts/memory/prove-promote-rungate-wire.ts — the MERCURY_CARD_PROMOTE_RUNGATE
// wire, RED→GREEN, live through the REAL promote path.
//
// The guarded class: a rungate existing as machinery + flag + proofs with NO
// caller (a severed loop — flipping the flag does nothing;
// promoteRungate.ts unreachable from the entrypoints).
// The live wire is promoteScribeCandidate per the flag-registry
// contract: refuse approved:true on a non-zero gate. This proof drives the
// real promote path under both arms + the flag-off default.
//
// Run: ~/.bun/bin/bun run scripts/memory/prove-promote-rungate-wire.ts
;(globalThis as Record<string, unknown>)['MACRO'] = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { promoteScribeCandidate } = await import('../../src/memdir/scribePromote.ts')

let failures = 0
function check(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}`)
}
const mkCandidate = (scribe: string) =>
  writeFileSync(join(scribe, 'c.md'), '---\nname: c\napproved: false\n---\nbody')

console.log('============================================================')
console.log(' promote-rungate wire — RED→GREEN through the real ratify path')
console.log('============================================================')

// RED: armed flag + failing gate ⇒ refuse, candidate stays staged.
{
  const scribe = mkdtempSync(join(tmpdir(), 'rgw-s-'))
  const root = mkdtempSync(join(tmpdir(), 'rgw-r-'))
  mkCandidate(scribe)
  process.env.MERCURY_CARD_PROMOTE_RUNGATE = '1'
  process.env.MERCURY_CARD_PROMOTE_RUNGATE_CMD = 'exit 1'
  const res = await promoteScribeCandidate('c.md', 'private', { scribeDir: scribe, rootDir: root })
  check('RED gate refuses ratification (reason rungate-red)', !res.ok && res.reason === 'rungate-red')
  check('RED gate leaves the candidate staged (non-destructive)', existsSync(join(scribe, 'c.md')))
  check('RED gate wrote nothing to the destination', !existsSync(join(root, 'c.md')))
}

// GREEN: armed flag + passing gate ⇒ promote.
{
  const scribe = mkdtempSync(join(tmpdir(), 'rgw-s-'))
  const root = mkdtempSync(join(tmpdir(), 'rgw-r-'))
  mkCandidate(scribe)
  process.env.MERCURY_CARD_PROMOTE_RUNGATE = '1'
  process.env.MERCURY_CARD_PROMOTE_RUNGATE_CMD = 'exit 0'
  const res = await promoteScribeCandidate('c.md', 'private', { scribeDir: scribe, rootDir: root })
  check('GREEN gate promotes (ok:true, approved flipped)', res.ok && res.approvedFlipped)
  check('GREEN gate moved the candidate', existsSync(join(root, 'c.md')) && !existsSync(join(scribe, 'c.md')))
}

// TIMEOUT (the ETIMEDOUT sibling class): a SIGTERM-trapping
// gate that hits the ceiling exits 0 — spawnSync reports the timeout ONLY
// via error.code ETIMEDOUT. `status === 0` alone read this as GREEN and
// promoted on an unverified gate.
{
  const { runPromoteRungate } = await import('../../src/memdir/promoteRungate.ts')
  process.env.MERCURY_CARD_PROMOTE_RUNGATE_CMD = 'trap "exit 0" TERM; sleep 30'
  const gate = runPromoteRungate({ stdio: 'ignore', timeoutMs: 800 })
  check('a timed-out TERM-trapping gate NEVER passes (exit 0 + ETIMEDOUT)', gate.pass === false)
  check('the timeout is named on the result (honest refusal wording)', gate.timedOut === true)
}

// OFF (default): flag unset ⇒ never spawns — a poisoned CMD proves no spawn.
{
  const scribe = mkdtempSync(join(tmpdir(), 'rgw-s-'))
  const root = mkdtempSync(join(tmpdir(), 'rgw-r-'))
  mkCandidate(scribe)
  delete process.env.MERCURY_CARD_PROMOTE_RUNGATE
  process.env.MERCURY_CARD_PROMOTE_RUNGATE_CMD = 'exit 1' // would refuse IF spawned
  const res = await promoteScribeCandidate('c.md', 'private', { scribeDir: scribe, rootDir: root })
  check('flag OFF: promote proceeds without spawning the gate', res.ok === true)
}

console.log('\n' + '═'.repeat(60))
if (failures === 0) console.log('✅ PROMOTE-RUNGATE WIRE GREEN')
else console.log(`❌ ${failures} PROMOTE-RUNGATE WIRE FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
