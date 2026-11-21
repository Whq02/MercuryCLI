#!/usr/bin/env bun
// gate-watch: scripts/lib/processGroup.ts scripts/lib/runnerHost.ts scripts/lib/rows.ts scripts/lib/scriptedTurn.ts scripts/sdk/compatRoadFixture.ts scripts/editor-bridge/prove-acp-server.ts scripts/mcp/prove-automation-server.ts scripts/mcp/prove-automation-gateway.ts
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { endProcessGroup, requirePositivePid, spawnInOwnGroup } from '../lib/processGroup.ts'

const ROOT = resolve(import.meta.dir, '../..')
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const grandchildPidOf = (child: { stdout: NodeJS.ReadableStream | null }): Promise<number> =>
  new Promise(resolve => {
    let text = ''
    child.stdout!.on('data', (chunk: Buffer) => {
      text += chunk.toString('utf8')
      const match = /^(\d+)\n/.exec(text)
      if (match) resolve(Number(match[1]))
    })
  })
const PARENT_THAT_LEAVES_A_CHILD = 'sleep 600 & echo $!; wait'

for (const pid of [undefined, -1, 0, 1, 1.5, NaN, Infinity]) {
  let refused = false
  try { requirePositivePid(pid) } catch { refused = true }
  check(`a proof refuses the unsafe signal pid ${String(pid)}`, refused, `make requirePositivePid in scripts/lib/processGroup.ts throw for ${String(pid)}, so a signal never goes to an unsafe pid`)
}
check('a proof retains a positive process pid', requirePositivePid(process.pid) === process.pid, 'make requirePositivePid in scripts/lib/processGroup.ts return a positive integer pid unchanged')

console.log('§1 a timed-out road ends the whole tree it started, not just its first process')
if (process.platform === 'win32') {
  check('the group kill has no POSIX process group on Windows; the single-process kill stands (not exercised here)', true)
} else {
  const child = spawnInOwnGroup('/bin/sh', ['-c', PARENT_THAT_LEAVES_A_CHILD], { stdio: ['ignore', 'pipe', 'inherit'] })
  const grandchild = await grandchildPidOf(child)
  check('the fixture tree stands: the shell and its sleeping grandchild', alive(child.pid!) && alive(grandchild), `the fixture shell should stay up with its sleeping grandchild (spawnInOwnGroup in scripts/lib/processGroup.ts); pids ${child.pid} ${grandchild}`)
  endProcessGroup(child)
  await sleep(300)
  check('after the group kill the first process is gone', !alive(child.pid!), 'make endProcessGroup in scripts/lib/processGroup.ts kill the child it was given')
  check('…and so is the grandchild it had started (the old single-process kill left it running)', !alive(grandchild), `make endProcessGroup in scripts/lib/processGroup.ts signal the whole group (the negative pid) and make spawnInOwnGroup start the child as its own group leader; grandchild pid ${grandchild} is still running`)

  const plain = spawn('/bin/sh', ['-c', PARENT_THAT_LEAVES_A_CHILD], { stdio: ['ignore', 'pipe', 'inherit'] })
  const orphan = await grandchildPidOf(plain)
  plain.kill('SIGKILL')
  await sleep(300)
  check('the control: a plain spawn killed by itself leaves its grandchild alive (the leak the roads had)', !alive(plain.pid!) && alive(orphan), `the control no longer shows the leak: the plain spawn or its grandchild did not behave as this proof assumes (the fixture in this file, not processGroup.ts); orphan pid ${orphan}`)
  try {
    process.kill(orphan, 'SIGKILL')
  } catch {
  }
  const gone = spawnInOwnGroup('/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' })
  await new Promise(resolve => gone.once('close', resolve))
  endProcessGroup(gone)
  check('ending a group whose processes already left throws nothing', true)
}

console.log('§2 every road that starts the product (or a host that starts it) spawns in its own group and ends the group')
const ROADS = [
  ['scripts/lib/runnerHost.ts', /spawnInOwnGroup\(opts\.node/, /endProcessGroup\(child\)/],
  ['scripts/lib/rows.ts', null, /endProcessGroup\(host\.child\)/],
  ['scripts/lib/scriptedTurn.ts', /spawnInOwnGroup\(NODE/, /endProcessGroup\(child\)/],
  ['scripts/sdk/compatRoadFixture.ts', /spawnInOwnGroup\(PYTHON/, /endProcessGroup\(child\)/],
  ['scripts/editor-bridge/prove-acp-server.ts', /spawnInOwnGroup\(\(process\.execPath/, /endProcessGroup\(s\)/],
  ['scripts/mcp/prove-automation-server.ts', /spawnInOwnGroup\('node', args/, /endProcessGroup\(child\)/],
  ['scripts/mcp/prove-automation-gateway.ts', /spawnInOwnGroup\('node', args/, /endProcessGroup\(child\)/],
] as const
for (const [file, spawns, ends] of ROADS) {
  const text = readFileSync(join(ROOT, file), 'utf8')
  check(`${file} spawns in its own group and ends the group on its deadline`, (spawns === null || spawns.test(text)) && ends.test(text) && !/\.kill\('SIGKILL'\)/.test(text.replace(/endProcessGroup\([^)]*\)/g, '')), `change ${file} to start its child with spawnInOwnGroup and end it with endProcessGroup (both from scripts/lib/processGroup.ts), with no direct kill of SIGKILL left`)
}
const helper = readFileSync(join(ROOT, 'scripts/lib/processGroup.ts'), 'utf8')
check('the helper kills the negative pid (the group) and falls back to the one process where groups do not exist', helper.includes('process.kill(-child.pid, signal)') && helper.includes('child.kill(signal)') && helper.includes("process.platform !== 'win32'"), 'restore in endProcessGroup in scripts/lib/processGroup.ts the group kill process.kill(-child.pid, signal), the fallback child.kill(signal) and the win32 test')

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-process-group-teardown (${checks} checks${failures ? `, ${failures} failed` : ''})`)
process.exit(failures === 0 ? 0 : 1)
