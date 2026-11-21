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
import { daemonSnapshot } from '../../src/services/cockpit/daemonSnapshot.js'
import { thisMercuryCommand } from '../../src/services/privateChannel/installPath.js'
import { daemonStatePath } from '../../src/daemon/controlSocket.js'

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  const shown = !cond && hint ? (detail ? detail + ' — ' : '') + hint : detail
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ' — ' + shown : ''}`)
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
  check('state === off', s.state === 'off', `state='${s.state}'`, 'fix the missing-record branch of daemonSnapshot in src/services/cockpit/daemonSnapshot.ts so an absent daemon state file reads off')
  check("reason carries the opt-in start path, spelled as this install's own command", (s.reason ?? '').startsWith(`opt-in: run \`${thisMercuryCommand()} daemon\``), s.reason ?? '', 'the off reason in daemonSnapshot (src/services/cockpit/daemonSnapshot.ts) must start with opt-in: run followed by thisMercuryCommand() and daemon')
}

section('record present + pid alive ⇒ live')
{
  writeRec(process.pid)
  const s = daemonSnapshot()
  check('state === live', s.state === 'live', `state='${s.state}'`, 'fix the live-pid branch of daemonSnapshot in src/services/cockpit/daemonSnapshot.ts (pidAlive or the record read)')
  check('reason reports running + pid + version', /running · pid \d+ · v/.test(s.reason ?? ''), s.reason ?? '', 'the live reason in daemonSnapshot (src/services/cockpit/daemonSnapshot.ts) must start with running · pid N · vVERSION')
  check('reason includes an uptime', /up \d+s/.test(s.reason ?? ''), s.reason ?? '', 'daemonSnapshot (src/services/cockpit/daemonSnapshot.ts) must add (up Ns) when the record has a startedAt')
}

section('record present + pid dead ⇒ unavailable (orphaned record)')
{
  writeRec(2147483646)
  const s = daemonSnapshot()
  check('state === unavailable', s.state === 'unavailable', `state='${s.state}'`, 'fix the dead-pid branch of daemonSnapshot in src/services/cockpit/daemonSnapshot.ts so an orphaned record reads unavailable')
  check('reason flags the stale record', /stale record · pid \d+ not running/.test(s.reason ?? ''), s.reason ?? '', 'the dead-pid reason in daemonSnapshot (src/services/cockpit/daemonSnapshot.ts) must read stale record · pid N not running')
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
  check('did not throw', !threw, '', 'daemonSnapshot in src/services/cockpit/daemonSnapshot.ts must catch every read or parse failure and return a Snapshot')
  check('falls back to off on an unparseable record', s?.state === 'off', `state='${s?.state}'`, 'the record read in daemonSnapshot (src/services/cockpit/daemonSnapshot.ts) must treat a SyntaxError as no record')
}

console.log('\n' + '═'.repeat(76))
if (failures === 0) console.log('✅ ALL DAEMON-SNAPSHOT PROOFS PASS')
else console.log(`❌ ${failures} DAEMON-SNAPSHOT PROOF(S) FAILED`)
console.log('═'.repeat(76))
process.exit(failures === 0 ? 0 : 1)
