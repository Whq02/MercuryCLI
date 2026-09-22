#!/usr/bin/env bun
import { execFileSync, spawn } from 'node:child_process'
import { rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, NODE, childEnv, makeTally, requireDist, scratchWorld, seedScratchHome, sleep, startScriptedFixture, textScript } from '../lib/scratchSeat.ts'

requireDist()
const tally = makeTally('prove-settings-fifo')
const DEADLINE_MS = 60_000
const fixture = await startScriptedFixture(textScript('settings probe answered'))
const port = Number(new URL(fixture.base).port)

async function bootExits(label: string, runHome: string, cwd: string): Promise<{ exited: boolean; code: number | null; ms: number; stdout: string }> {
  const proc = spawn(NODE, [DIST, '-p', 'settings probe', '--output-format', 'json', '--model', 'claude-opus-4-8'], {
    cwd,
    env: childEnv(runHome, port),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  proc.stdout!.on('data', (c: Buffer) => { stdout += c.toString('utf8') })
  proc.stderr!.on('data', () => {})
  let code: number | null = null
  let exited = false
  proc.on('exit', c => { exited = true; code = c })
  const started = Date.now()
  while (!exited && Date.now() - started < DEADLINE_MS) await sleep(250)
  const ms = Date.now() - started
  if (!exited) {
    console.log(`  [${label}] still running after ${DEADLINE_MS} ms — killed`)
    try { proc.kill('SIGKILL') } catch {}
  }
  return { exited, code, ms, stdout }
}

tally.section('control: a regular settings.json boots, answers and exits')
const control = scratchWorld('settings-fifo-control')
seedScratchHome(control.runHome, control.cwd)
writeFileSync(join(control.runHome, 'settings.json'), '{}')
const c = await bootExits('control', control.runHome, control.cwd)
tally.check('the control boot exits well inside the deadline', c.exited && c.ms < DEADLINE_MS / 2, `code ${c.code} after ${c.ms} ms`)
tally.check('and it answered the turn', c.stdout.includes('settings probe answered'))

const specials: Array<{ name: string; make: (settings: string) => void }> = [
  { name: 'a named pipe (no writer)', make: settings => execFileSync('mkfifo', [settings]) },
  { name: 'a socket', make: settings => execFileSync('python3', ['-c', 'import socket, sys; s = socket.socket(socket.AF_UNIX); s.bind(sys.argv[1])', settings]) },
  { name: 'a device (a link to /dev/null)', make: settings => symlinkSync('/dev/null', settings) },
]
for (const special of specials) {
  tally.section(`the defect: settings.json replaced by ${special.name} while the seat boots`)
  const world = scratchWorld('settings-special')
  seedScratchHome(world.runHome, world.cwd)
  const settings = join(world.runHome, 'settings.json')
  rmSync(settings)
  special.make(settings)
  const f = await bootExits(special.name, world.runHome, world.cwd)
  tally.check(`the seat exits (refusing ${special.name}) instead of blocking forever on it`, f.exited, f.exited ? `code ${f.code} after ${f.ms} ms` : `hung past ${DEADLINE_MS} ms (the control took ${c.ms} ms)`)
  tally.check('and it still answered the turn', f.stdout.includes('settings probe answered'), `code ${f.code}; stdout ${f.stdout.slice(0, 160)}`)
}
await fixture.close()
tally.finish()
