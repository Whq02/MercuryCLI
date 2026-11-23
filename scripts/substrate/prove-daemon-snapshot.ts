#!/usr/bin/env bun

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
import { daemonSnapshot } from '../../src/screen/cockpit-gauges/daemonSnapshot.js'
import { thisMercuryCommand } from '../../src/platform/update-channel/installPath.js'
import { daemonStatePath } from '../../src/daemon/control/controlSocket.js'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}${!cond && hint ? ' — ' + hint : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t)
}

const cfgDir = mkdtempSync(join(tmpdir(), 'mercury-daemon-snap-'))
process.env.MERCURY_CONFIG_DIR = cfgDir
const recPath = daemonStatePath()
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

section('no daemon record ⇒ off (opt-in start path)')
{
  rmSync(recPath, { force: true })
  const s = daemonSnapshot()
  check('state === off', s.state === 'off', `state='${s.state}'`, 'fix the no-record branch at the end of daemonSnapshot in src/screen/cockpit-gauges/daemonSnapshot.ts: with no daemon state file it must return state off')
  check("reason carries the opt-in start path, spelled as this install's own command", (s.reason ?? '').startsWith(`opt-in: run \`${thisMercuryCommand()} daemon\``), s.reason ?? '', 'fix the reason of the off state in daemonSnapshot (src/screen/cockpit-gauges/daemonSnapshot.ts): it must start with opt-in: run, then the command from thisMercuryCommand, then daemon')
}

section('record present + pid alive ⇒ live')
{
  writeRec(process.pid)
  const s = daemonSnapshot()
  check('state === live', s.state === 'live', `state='${s.state}'`, 'fix the alive-pid branch of daemonSnapshot in src/screen/cockpit-gauges/daemonSnapshot.ts: a record whose pid is alive must return state live')
  check('reason reports running + pid + version', /running · pid \d+ · v/.test(s.reason ?? ''), '', 'fix the live reason text in daemonSnapshot (src/screen/cockpit-gauges/daemonSnapshot.ts): it must read running · pid N · vVERSION; the reason was ' + (s.reason ?? ''))
  check('reason includes an uptime', /up \d+s/.test(s.reason ?? ''), '', 'fix the live reason text in daemonSnapshot (src/screen/cockpit-gauges/daemonSnapshot.ts): with a startedAt in the record it must add (up Ns); the reason was ' + (s.reason ?? ''))
}

section('record present + pid dead ⇒ unavailable (orphaned record)')
{
  writeRec(2147483646)
  const s = daemonSnapshot()
  check('state === unavailable', s.state === 'unavailable', `state='${s.state}'`, 'fix the dead-pid branch of daemonSnapshot in src/screen/cockpit-gauges/daemonSnapshot.ts: a record whose pid is not running must return state unavailable')
  check('reason flags the stale record', /stale record · pid \d+ not running/.test(s.reason ?? ''), '', 'fix the dead-pid reason in daemonSnapshot (src/screen/cockpit-gauges/daemonSnapshot.ts): it must read stale record · pid N not running; the reason was ' + (s.reason ?? ''))
}

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
  check('did not throw', !threw, '', 'daemonSnapshot in src/screen/cockpit-gauges/daemonSnapshot.ts must catch an unparseable state file and return a state, never throw')
  check('falls back to off on an unparseable record', s?.state === 'off', `state='${s?.state}'`, 'fix the state-file read in daemonSnapshot (src/screen/cockpit-gauges/daemonSnapshot.ts): a SyntaxError from JSON.parse must leave the record empty so the state is off')
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL DAEMON-SNAPSHOT PROOFS PASS')
else console.log(`❌ ${failures} DAEMON-SNAPSHOT PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
