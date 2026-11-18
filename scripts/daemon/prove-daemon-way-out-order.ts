#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'daemon-way-out-'))
process.env.MERCURY_CONFIG_DIR = home
process.env.MERCURY_DAEMON_DIR = join(home, 'daemon')
mkdirSync(process.env.MERCURY_DAEMON_DIR, { recursive: true })
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const SELF = 'scripts/daemon/prove-daemon-way-out-order.ts'
const PART = 'src/daemon/run/shutdown.ts'
const AT_ONCE = [
  'stop the plane heal',
  'stop the armed-restart beat',
  'stop the handover lock beat',
  'stop the sessionless beat',
  'stop the Saturn ticker',
  'stop the host job sweep',
  'yield the restart to a daemon that already serves',
  'mark the record stopping',
  'say it is leaving',
  'stop the owner watch',
  'close the owner pipe',
  'reap every rostered worker',
]
const THEN = [
  'close the control server',
  'clear the control key',
  'clear the daemon record',
  'write the exit in the spawn ledger',
  'mark the teardown complete',
  'release the held reading',
  'spawn the successor when the restart stands',
  'release the daemon lock',
  'wait for the runners that were asked to end',
  'let the event loop go',
  'resolve the run',
  'exit in 250 ms',
]

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

function moved(list: string, held: readonly string[], runs: readonly string[]): string {
  const lines: string[] = []
  for (const name of runs) if (!held.includes(name)) lines.push(`${list} runs a step this proof does not hold: "${name}" — a step was added: add its name to ${list} in ${SELF}, at the place it runs`)
  for (const name of held) if (!runs.includes(name)) lines.push(`${list} no longer runs "${name}" — a step was dropped: if the daemon is meant to stop doing it on its way out, take the name out of ${list} in ${SELF}; if not, put the step back in ${PART}`)
  if (lines.length === 0) {
    const at = runs.findIndex((name, i) => name !== held[i])
    if (at >= 0) lines.push(`${list} runs "${runs[at]}" at place ${at + 1} where this proof holds "${held[at]}" — two steps changed places: the order the daemon lets go in is behaviour; put the steps of ${PART} back in the order of ${SELF}, or move both lists in one commit and say what a daemon now does first`)
  }
  return lines.join('\n      ')
}

console.log('the way out of the daemon: the names of its steps, in the order they run')
const part = await import('../../src/daemon/run/shutdown.ts')
const atOnce = part.WAY_OUT_AT_ONCE.map(step => step.name)
const then = part.WAY_OUT_THEN.map(step => step.name)
console.log(`  ${atOnce.length} steps at once, before the caller gets the thread back: ${atOnce.join(' · ')}`)
console.log(`  ${then.length} steps then, one after another: ${then.join(' · ')}`)
check(`the ${AT_ONCE.length} steps that run at once are the ones this proof holds, in its order`, moved('WAY_OUT_AT_ONCE', AT_ONCE, atOnce) === '', moved('WAY_OUT_AT_ONCE', AT_ONCE, atOnce))
check(`the ${THEN.length} steps that follow are the ones this proof holds, in its order`, moved('WAY_OUT_THEN', THEN, then) === '', moved('WAY_OUT_THEN', THEN, then))
check('no step stands in both lists, and none twice', new Set([...atOnce, ...then]).size === atOnce.length + then.length, [...atOnce, ...then].filter((name, i, all) => all.indexOf(name) !== i).join(', '))
check('every step is a function with a name', [...part.WAY_OUT_AT_ONCE, ...part.WAY_OUT_THEN].every(step => typeof step.run === 'function' && step.name.trim() !== ''))
check('the reader names a swap, a step added and a step dropped, each by its own line', moved('L', ['a', 'b', 'c'], ['a', 'c', 'b']).includes('two steps changed places') && moved('L', ['a', 'b'], ['a', 'b', 'x']).includes('a step was added') && moved('L', ['a', 'b'], ['a']).includes('a step was dropped') && moved('L', ['a', 'b'], ['a', 'b']) === '')

rmSync(home, { recursive: true, force: true })
console.log(`\nprove-daemon-way-out-order: ${failures === 0 ? 'green' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
