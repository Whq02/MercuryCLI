#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUN, REPO, SCRATCH_ROOT, childEnv } from '../daemon/dupline-world.ts'
import { hostRunner } from '../lib/runnerHost.ts'
import { DIST, NODE, makeTally, seedScratchHome, startScriptedFixture, textScript } from '../lib/scratchSeat.ts'
import { seatForensics } from '../lib/seatForensics.ts'

const tally = makeTally('prove-settings-watch-beside-a-named-pipe')
const DEADLINE_MS = 60_000
const j = (value: unknown): string => JSON.stringify(value)
const fixture = await startScriptedFixture(textScript('answered'))
const port = Number(new URL(fixture.base).port)
const root = mkdtempSync(join(SCRATCH_ROOT, 'settings-beside-pipe-'))
const runHome = join(root, 'home')
const cwd = join(runHome, 'work')
seedScratchHome(runHome, cwd)
execFileSync('mkfifo', [join(root, 'beside.fifo')])
execFileSync('mkfifo', [join(runHome, 'beside.fifo')])
const launcher = join(root, 'launcher.ts')
writeFileSync(launcher, `;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }\ndelete process.env.NODE_ENV\nawait import(${j(join(REPO, 'src', 'entrypoints', 'cli.tsx'))})\n`)

const seats: Array<{ label: string; node: string; dist: string }> = [{ label: 'a source seat under bun', node: BUN, dist: launcher }]
if (existsSync(DIST)) seats.push({ label: 'the built product under node', node: NODE, dist: DIST })
else console.log(`  [SKIP] ${DIST} absent — the built product's leg needs a build first`)

for (const seat of seats) {
  tally.section(`${seat.label} boots beside a named pipe with no writer in the home and in the cwd's grandparent`)
  const seatLog = join(root, `seat-${seat.node === BUN ? 'bun' : 'node'}-debug.txt`)
  const host = hostRunner({ node: seat.node, dist: seat.dist, argv: ['--model', 'claude-opus-4-8', '--log-file', seatLog], cwd, env: childEnv(runHome, port) as Record<string, string | undefined>, home: runHome, onRow: () => {} })
  const started = Date.now()
  let answered = false
  let detail = ''
  try {
    const result = await host.initialize({}, DEADLINE_MS)
    answered = typeof result.session_id === 'string'
    detail = `initialize answered after ${Date.now() - started} ms`
  } catch (error) {
    detail = `${error instanceof Error ? error.message : String(error)}`
    if (host.child.pid !== undefined && host.child.exitCode === null) detail += `\n  ${seatForensics(host.child.pid)}`
  }
  tally.check(`the seat answers initialize within ${DEADLINE_MS / 1000} s: the settings watcher never opens the pipe`, answered, detail)
  host.end()
  await host.stop(3_000)
}
await fixture.close()
tally.finish()
