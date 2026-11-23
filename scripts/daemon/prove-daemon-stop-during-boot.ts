#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const HARNESS = join(import.meta.dir, 'daemonRunScenarios.ts')
const SELF = 'scripts/daemon/prove-daemon-stop-during-boot.ts'
const SCENARIO = 'stop-during-boot'
const args = process.argv.slice(2)
const dist = resolve(args.includes('--dist') ? args[args.indexOf('--dist') + 1]! : join(ROOT, 'dist'))

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

if (process.platform === 'win32') {
  console.log(`${SELF}: the scenario holds a daemon's boot with a POSIX signal and reads a socket file: not run on Windows`)
  process.exit(0)
}
if (!existsSync(join(dist, 'mercury.mjs'))) {
  console.log(`${SELF}: no built product at ${dist} — run \`bun run build.ts\`, or name one with --dist`)
  process.exit(1)
}

section(`a stop that reaches a daemon while it boots, on a real daemon in a scratch home (the build at ${dist})`)
const out = mkdtempSync(join(tmpdir(), 'dmr-stop-during-boot-'))
const file = join(out, 'recording.txt')
const ran = spawnSync(process.execPath, [HARNESS, SCENARIO, '--dist', dist, '--out', file], { cwd: ROOT, env: process.env, stdio: ['ignore', 'ignore', 'inherit'], timeout: 240_000 })
const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
rmSync(out, { recursive: true, force: true })
const lines = text.split('\n')
const at = (words: string): number => lines.findIndex(line => line.includes(words))
const held = at('clock: held at rename control.sock')
const asked = at('> shutdown while the boot is held')
const answered = lines[asked + 1] ?? ''
const wentOn = at('clock: held no longer')
const up = at('[daemon] control socket up')
const leaving = at('[daemon] control:shutdown — shutting down')
const left = lines.find(line => line.startsWith('= d1 left: ')) ?? ''
const unreached = lines.filter(line => line.startsWith('! '))

check('the scenario ran: a daemon was started and its boot was held where the control server listens and the way out is not yet bound', text !== '' && held >= 0 && up > held, text === '' ? `the harness wrote no recording (exit ${ran.status})` : `the boot was not held: ${lines.slice(0, 6).join(' | ')} — see the 'stop-during-boot' scenario in scripts/daemon/daemonRunScenarios.ts, which holds the boot at the rename of control.sock; run \`bun run build.ts\` if the build at ${dist} is stale`)
check('the stop sent while the boot is held is acknowledged', asked >= 0 && answered.includes('"ok":true') && answered.includes('"op":"shutdown"'), `${answered || 'no answer was recorded'} — the daemon must answer a shutdown sent while its boot is held with ok true and op shutdown; the 'stop-during-boot' scenario in scripts/daemon/daemonRunScenarios.ts sends it`)
check('the boot goes on to its end after the stop: the daemon says its control socket is up', wentOn > asked && up > wentOn, `held ${held}, asked ${asked}, went on ${wentOn}, up ${up}`)
check(
  'the stop is taken once the way out is bound: the daemon leaves by control:shutdown, exit 0',
  leaving > up && left === '= d1 left: code 0 signal null',
  `${left || 'the daemon was not seen to leave'}${unreached.length > 0 ? ` (${unreached.join(' | ')})` : ''} — the stop was acknowledged and then lost: a stop asked before the way out is bound is kept in the state (askedToLeave) by the first value of requestShutdown in src/daemon/control/main.ts and taken by bindWayOut of src/daemon/run/shutdown.ts where the boot binds the way out; put both back`,
)
check('every wait of the scenario was reached and nothing was left running', unreached.length === 0 && ran.status === 0, unreached.join(' | ') || `the harness exit ${ran.status}`)

console.log(`\nprove-daemon-stop-during-boot: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
