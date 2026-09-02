#!/usr/bin/env bun
// ============================================================================
//  scripts/substrate/prove-daemon-snapshot.ts
//  PROOF: daemonSnapshot() is wired to the real liveness probe — it no longer
//  hard-codes `off`. With a persisted supervisor.json it reports:
//    live        — pid alive
//    unavailable — pid dead (orphaned record)
//    off         — no record (the opt-in start path; byte-identical to before)
//  Exercised against the REAL production snapshot + the canonical supervisor path.
//  color-diff-napi stubbed (Bun.plugin) in case the import graph pulls it.
// ============================================================================

import { plugin } from 'bun'
plugin({
  name: 'stub-color-diff-napi',
  setup(build) {
    build.module('color-diff-napi', () => ({
      loader: 'object',
      exports: { ColorDiff: class {}, ColorFile: class {}, getSyntaxTheme: () => ({}) },
    }))
  },
})
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { daemonSnapshot } from '../../src/utils/cockpit/daemonSnapshot.js'
import { supervisorStatePath } from '../../src/daemon/controlSocket.js'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const cfgDir = mkdtempSync(join(tmpdir(), 'hermes-daemon-snap-'))
process.env.MERCURY_CONFIG_DIR = cfgDir
const recPath = supervisorStatePath()
mkdirSync(join(recPath, '..'), { recursive: true })

function writeRec(pid: number): void {
  writeFileSync(
    recPath,
    JSON.stringify({
      pid,
      version: '1.0.0',
      origin: 'transient',
      startedAt: 1718000000000,
      dir: cfgDir,
      controlSock: join(cfgDir, 'daemon', 'control.sock'),
    }),
  )
}

console.log('============================================================')
console.log(' daemonSnapshot — wired-to-liveness proof')
console.log('============================================================')

// ── off: no record (start path; byte-identical to the old hard-coded off) ─────
section('no supervisor record ⇒ off (opt-in start path)')
{
  rmSync(recPath, { force: true })
  const s = daemonSnapshot()
  check('state === off', s.state === 'off', `state='${s.state}'`)
  check('reason carries the opt-in start path', /opt-in: run `mercury daemon`/.test(s.reason ?? ''))
}

// ── live: record present, pid alive (use our own pid) ─────────────────────────
section('record present + pid alive ⇒ live')
{
  writeRec(process.pid)
  const s = daemonSnapshot()
  check('state === live', s.state === 'live', `state='${s.state}'`)
  check('reason reports running + pid + version', /running · pid \d+ · v/.test(s.reason ?? ''))
  check('reason includes an uptime', /up \d+s/.test(s.reason ?? ''))
}

// ── unavailable: record present but pid dead (orphaned) ───────────────────────
section('record present + pid dead ⇒ unavailable (orphaned record)')
{
  // A pid that is overwhelmingly unlikely to be live (and > 1 so it is probed).
  writeRec(2147483646)
  const s = daemonSnapshot()
  check('state === unavailable', s.state === 'unavailable', `state='${s.state}'`)
  check('reason flags the stale record', /stale record · pid \d+ not running/.test(s.reason ?? ''))
}

// ── never throws (the snapshot contract) on a garbage record ──────────────────
section('garbage record ⇒ off, never throws (honest-state contract)')
{
  writeFileSync(recPath, '{ this is not json')
  let threw = false
  let s: ReturnType<typeof daemonSnapshot> | null = null
  try {
    s = daemonSnapshot()
  } catch {
    threw = true
  }
  check('did not throw', !threw)
  check('falls back to off on an unparseable record', s?.state === 'off', `state='${s?.state}'`)
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL DAEMON-SNAPSHOT PROOFS PASS')
else console.log(`❌ ${failures} DAEMON-SNAPSHOT PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
