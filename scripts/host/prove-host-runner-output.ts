import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { proofHome } from '../lib/hermetic.ts'

process.argv.push('--log-stderr')
const { hostRunner } = await import('../../src/models/hosting/ssh.ts')

const scratch = join(proofHome, 'runner-output')
mkdirSync(scratch)
const signal = new AbortController().signal
const gates: string[] = []
const said: string[] = []
const stderrWrite = process.stderr.write
let checks = 0
const check = (name: string, truth: unknown, detail = ''): void => { assert.ok(truth, name + (detail ? ': ' + detail : '')); checks++; console.log('PASS ' + name) }
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const until = async (what: string, test: () => boolean): Promise<void> => { for (let turn = 0; turn < 4000; turn++) { if (test()) return; await pause(5) } throw new Error('never came: ' + what + ' (waited 20 s; the stand-in child of scripts/host/prove-host-runner-output.ts did not reach that state, so look at hostRunner.run in src/models/hosting/ssh.ts)') }

type End = { output?: string; error?: string }
const WAIT = 'held() { n=0; while [ ! -e "$1" ] && [ "$n" -lt 6000 ]; do sleep 0.01; n=$((n+1)); done; }; '
function start(name: string, first: string, late: string, keepsPipe: boolean) {
  const [gate, pids, last] = ['gate', 'pids', 'last'].map(part => join(scratch, name + '.' + part)) as [string, string, string]
  gates.push(gate, last)
  const script = WAIT + 'echo ' + first + '; ( held "$1"; echo ' + late + (keepsPipe ? '; held "$3"' : '') + ' ) & echo "$$ $!" > "$2.part"; mv "$2.part" "$2"'
  let settled = false
  const end: Promise<End> = hostRunner.run('/bin/sh', ['-c', script, 'sh', gate, pids, last], signal, 20_000).then(output => { settled = true; return { output } }, (error: Error) => { settled = true; return { error: error.message } })
  const exited = async (): Promise<number> => {
    await until('the pids of the child that ' + name, () => existsSync(pids))
    const [child, descendant] = readFileSync(pids, 'utf8').trim().split(' ').map(Number) as [number, number]
    await until('the exit of the child that ' + name, () => !alive(child))
    return descendant
  }
  return { end, exited, release: () => writeFileSync(gate, ''), settled: () => settled }
}

try {
  process.stderr.write = ((chunk: unknown) => { said.push(String(chunk)); return true }) as typeof process.stderr.write
  const ends = start('ends', 'early', 'late', false)
  await ends.exited()
  ends.release()
  const whole = await ends.end
  check('a child whose output is delivered after its exit is read whole', whole.output === 'early\nlate\n', JSON.stringify(whole) + ' — expected early then late; change the exit and close handling of hostRunner.run in src/models/hosting/ssh.ts so output delivered after the child exits is still read')

  const holds = start('holds', 'before', 'after', true)
  const holder = await holds.exited()
  holds.release()
  const clean = await hostRunner.run('/bin/sh', ['-c', 'echo clean'], signal, 20_000)
  check('a child that ends cleanly settles at once: a held child that exited before it began is still in its grace', clean === 'clean\n' && !holds.settled(), JSON.stringify({ clean, heldSettled: holds.settled() }) + ' — change the exit handling of hostRunner.run in src/models/hosting/ssh.ts so a cleanly ended child settles at once while a held child stays inside EXIT_OUTPUT_GRACE_MS')
  const atGrace = await holds.end
  const lines = said.filter(line => line.includes('/bin/sh exited and its output had not ended'))
  check('a child whose descendant keeps the pipe open settles at the grace with everything written before it, not at the run\'s timeout, and the debug log says so once', atGrace.output === 'before\nafter\n' && alive(holder) && lines.length === 1, JSON.stringify({ atGrace, holderAlive: alive(holder), lines }) + ' — change the exit handler of hostRunner.run in src/models/hosting/ssh.ts so it settles at EXIT_OUTPUT_GRACE_MS with the output read so far and logs the exited-and-output-had-not-ended line once')
  console.log('HOST RUNNER OUTPUT GREEN — ' + checks + ' checks; three stand-in children through hostRunner.run, their late output released by the proof')
} finally {
  process.stderr.write = stderrWrite
  for (const gate of gates) writeFileSync(gate, '')
}
