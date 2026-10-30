#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { SCRATCH_ROOT, childEnv } from '../daemon/dupline-world.ts'
import { hostRunner } from '../lib/runnerHost.ts'
import { DIST, NODE, makeTally, seedScratchHome, startScriptedFixture, textScript } from '../lib/scratchSeat.ts'
import { describeSeat, seatRuntime, type SeatRuntime } from '../lib/seatLauncher.ts'

const tally = makeTally('prove-settings-watch-beside-a-named-pipe')
const DEADLINE_MS = 60_000
const fixture = await startScriptedFixture(textScript('answered'))
const port = Number(new URL(fixture.base).port)
const root = mkdtempSync(join(SCRATCH_ROOT, 'settings-beside-pipe-'))
const runHome = join(root, 'home')
const cwd = join(runHome, 'work')
seedScratchHome(runHome, cwd)
execFileSync('mkfifo', [join(root, 'beside.fifo')])
execFileSync('mkfifo', [join(runHome, 'beside.fifo')])

const seats: SeatRuntime[] = [seatRuntime(root, { source: 'required' })]
if (existsSync(DIST)) seats.push({ exe: NODE, script: DIST, runtime: 'node', from: 'the built product' })
else console.log(`  [SKIP] ${DIST} absent — the built product's leg needs a build first`)

for (const seat of seats) {
  tally.section(`${describeSeat(seat)} boots beside a named pipe with no writer in the home and in the cwd's grandparent`)
  const seatLog = join(root, `seat-${seat.runtime}-debug.txt`)
  const host = hostRunner({ node: seat.exe, dist: seat.script, argv: ['--model', 'claude-opus-4-8', '--log-file', seatLog], cwd, env: childEnv(runHome, port) as Record<string, string | undefined>, home: runHome, onRow: () => {} })
  const started = Date.now()
  let answered = false
  let detail = ''
  try {
    const result = await host.initialize({}, DEADLINE_MS)
    answered = typeof result.session_id === 'string'
    detail = `initialize answered after ${Date.now() - started} ms`
  } catch (error) {
    const stderr = host.stderr().trim()
    detail = `${error instanceof Error ? error.message : String(error)} — seat exit ${host.child.exitCode ?? 'pending'}${host.child.signalCode ? `, signal ${host.child.signalCode}` : ''}; its stderr (${stderr.length} bytes, the last 1500): ${JSON.stringify(stderr.slice(-1500))} (a seat still alive has its forensics printed above by the launcher)`
  }
  tally.check(`the seat answers initialize within ${DEADLINE_MS / 1000} s: the settings watcher never opens the pipe`, answered, detail)
  host.end()
  await host.stop(3_000)
}
await fixture.close()
tally.finish()
