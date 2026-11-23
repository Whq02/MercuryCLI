#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const HARNESS = join(import.meta.dir, 'daemonRunScenarios.ts')
const SELF = 'scripts/daemon/prove-daemon-second-while-first-leaves.ts'
const SCENARIO = 'second-while-first-leaves'
const args = process.argv.slice(2)
const after = (flag: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
const dist = resolve(after('--dist') ?? join(ROOT, 'dist'))
const runs = Math.max(1, Number(after('--runs') ?? 1))

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))

if (process.platform === 'win32') {
  console.log(`${SELF}: the scenario holds a daemon on its way out with a POSIX signal and reads a socket file: not run on Windows`)
  process.exit(0)
}
if (!existsSync(join(dist, 'mercury.mjs'))) {
  console.log(`${SELF}: no built product at ${dist} — run \`bun run build.ts\`, or name one with --dist`)
  process.exit(1)
}

const out = mkdtempSync(join(tmpdir(), 'dmr-second-while-first-leaves-'))
let got = 0
for (let run = 1; run <= runs; run++) {
  section(`run ${run} of ${runs}: a second daemon and a window while the first daemon is on its way out, in a scratch home (the build at ${dist})`)
  const file = join(out, `recording.${run}.txt`)
  const ran = spawnSync(process.execPath, [HARNESS, SCENARIO, '--dist', dist, '--out', file], { cwd: ROOT, env: process.env, stdio: ['ignore', 'ignore', 'inherit'], timeout: 280_000 })
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const lines = text.split('\n')
  const at = (words: string, from = 0): number => lines.findIndex((line, i) => i >= from && line.includes(words))
  const held = at('clock: held at unlink daemon.json')
  const stopping = lines.find(line => line.startsWith('@ the first is leaving daemon.json: ')) ?? ''
  const refused = lines.findIndex(line => line.includes('pid <pid:d1> serves this config home') && line.includes('refusing to start so the live one is not clobbered'))
  const second = lines.find(line => line.startsWith('= d2 left: ')) ?? ''
  const waiting = lines.find(line => line.startsWith('# what the window has said while the first holds the plane: ')) ?? ''
  const stillFirst = lines.find(line => line.startsWith('@ the window waits daemon.json: ')) ?? ''
  const firstLeft = lines.find(line => line.startsWith('= d1 left: ')) ?? ''
  const usable = lines.find(line => line.startsWith('# what the window says once the first has left: ')) ?? ''
  const helloAt = at('> hello of the daemon the window started')
  const hello = lines[helloAt + 1] ?? ''
  const served = lines.find(line => line.startsWith('@ the window has its daemon daemon.json: ')) ?? ''
  const unreached = lines.filter(line => line.startsWith('! '))

  check('the first daemon is held on its way out with its record still there, marked stopping', text !== '' && held >= 0 && stopping.includes('"state": "stopping"') && stopping.includes('<pid:d1>'), text === '' ? `the harness wrote no recording (exit ${ran.status})` : stopping || 'no record was read')
  check('a second daemon started by hand meanwhile is refused, exit 1, by the line that names the first', refused >= 0 && second === '= d2 left: code 1 signal null', `${second || 'the second daemon was not seen to leave'} — a daemon started while another serves the home must print the refusal "refusing to start so the live one is not clobbered" and exit 1: see that refusal in src/daemon/control/main.ts`)
  check('a window that opens meanwhile asks for its daemon and has started none: the record still names the first', waiting.endsWith('the window asks for its daemon') && stillFirst.includes('<pid:d1>') && stillFirst.includes('"state": "stopping"'), `${waiting} · ${stillFirst}`)
  check('the first daemon leaves, exit 0, once it is held no longer', firstLeft === '= d1 left: code 0 signal null', firstLeft)
  const own = usable.endsWith('the daemon of the window is usable: true') && hello.includes('"ok":true') && hello.includes('"ready":true') && !hello.includes('<pid:d1>') && served.includes('"ownerPid": <pid:window>')
  check(
    'the window then has a daemon of its own: usable, ready, under another pid, owned by the window',
    own,
    `${usable || 'the window said nothing more'} · ${hello.slice(0, 160)} — a window that opens while a daemon leaves waits for the plane to clear and then starts its own (awaitDeparture in src/daemon/switchboard/ensureDaemon.ts): if it is left with no daemon, a daemon that finds the home's record marked stopping has to wait for that process to end and then serve`,
  )
  check('every wait of the scenario was reached', unreached.length === 0 && ran.status === 0, unreached.join(' | ') || `the harness exit ${ran.status}`)
  if (own) got++
}
rmSync(out, { recursive: true, force: true })

console.log(`\nprove-daemon-second-while-first-leaves: ${failures === 0 ? 'green' : `${failures} failed`} · the window had its daemon in ${got} of ${runs} run${runs === 1 ? '' : 's'}`)
process.exit(failures === 0 ? 0 : 1)
