#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const FIXTURE = join(REPO, 'scripts', 'streaming', 'turn-end-fixture-server.ts')
const BUN = process.env.BUN ?? join(process.env.HOME ?? '', '.bun/bin/bun')

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
const until = async (pred: () => boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (pred()) return true
    await sleep(100)
  }
  return pred()
}

const scratch = mkdtempSync(join(tmpdir(), 'fixture-parent-watch-'))
const capture = join(scratch, 'wire.jsonl')
writeFileSync(capture, '')

console.log('============================================================')
console.log(' the turn-end fixture lives exactly as long as its parent')
console.log('============================================================')

{
  const parent = spawn('/bin/sh', ['-c', `"$0" run "$1" "$2" & echo FIXPID $!; sleep 2; exit 0`, BUN, FIXTURE, capture], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  parent.stdout.on('data', (c: Buffer) => {
    out += c.toString('utf8')
  })
  const parentExit = new Promise<number | null>(resolve => parent.on('exit', code => resolve(code)))
  const gotPid = await until(() => /FIXPID (\d+)/.test(out), 5_000)
  const fixturePid = Number(/FIXPID (\d+)/.exec(out)?.[1] ?? 0)
  check('§1 the parent shell backgrounded the fixture and named its pid', gotPid && fixturePid > 0, out.slice(0, 200))
  const wasAlive = await until(() => alive(fixturePid), 3_000)
  check('§1 the fixture was alive under its living parent', wasAlive)
  const listening = await until(() => /PORT \d+/.test(out), 10_000)
  check('§1 the fixture reached its port under the living parent', listening, out.slice(0, 200))
  await parentExit
  const died = await until(() => !alive(fixturePid), 6_000)
  check("§1 the parent gone, the fixture exited on its own within a few seconds — nobody reaped it (the orphan class closed)", died, `pid ${fixturePid} still alive after 6 s`)
  if (!died) {
    try {
      process.kill(fixturePid, 'SIGKILL')
    } catch {
    }
  }
}

{
  const fixture = spawn(BUN, ['run', FIXTURE, capture], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  fixture.stdout.on('data', (c: Buffer) => {
    out += c.toString('utf8')
  })
  const listening = await until(() => /PORT \d+/.test(out), 10_000)
  check('§2 the fixture under a living parent reached its port', listening, out.slice(0, 200))
  await sleep(3_000)
  check('§2 …and is still up three seconds later (the watch never fires on a living parent)', fixture.exitCode === null && alive(fixture.pid ?? 0))
  fixture.kill('SIGTERM')
  const reaped = await until(() => fixture.exitCode !== null || !alive(fixture.pid ?? 0), 5_000)
  check('§2 …and the reaper still ends it', reaped)
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
