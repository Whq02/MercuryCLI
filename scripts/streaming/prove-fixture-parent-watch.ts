#!/usr/bin/env bun
import { spawn, type ChildProcess } from 'node:child_process'
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
type Signaller = (pid: number, sig: NodeJS.Signals | 0) => void
let sendSignal: Signaller = (pid, sig) => process.kill(pid, sig)
const ownedPid = (pid: unknown): pid is number => typeof pid === 'number' && Number.isInteger(pid) && pid > 1 && pid !== process.pid
const probe = (pid: unknown): 'alive' | 'gone' | 'unowned' => {
  if (!ownedPid(pid)) return 'unowned'
  try {
    sendSignal(pid, 0)
    return 'alive'
  } catch {
    return 'gone'
  }
}
const alive = (pid: unknown): boolean => probe(pid) === 'alive'
const endOwned = (pid: unknown, sig: NodeJS.Signals): 'sent' | 'gone' | 'refused' => {
  if (!ownedPid(pid)) return 'refused'
  try {
    sendSignal(pid, sig)
    return 'sent'
  } catch {
    return 'gone'
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

type Report = (label: string, ok: boolean, detail?: string) => void
async function orphanLeg(spawnParent: () => ChildProcess, report: Report): Promise<{ fixturePid: number | null; contained: boolean }> {
  const parent = spawnParent()
  let out = ''
  parent.stdout?.on('data', (c: Buffer) => {
    out += c.toString('utf8')
  })
  const parentExit = new Promise<number | null>(resolve => parent.on('exit', code => resolve(code)))
  const gotPid = await until(() => /FIXPID (\d+)/.test(out), 5_000)
  const parsed = /FIXPID (\d+)/.exec(out)?.[1]
  const fixturePid: number | null = gotPid && parsed !== undefined && ownedPid(Number(parsed)) ? Number(parsed) : null
  report('§1 the parent shell backgrounded the fixture and named its pid', fixturePid !== null, out.slice(0, 200) || '(the shell printed nothing)')
  if (fixturePid === null) {
    parent.kill('SIGKILL')
    await parentExit
    report('§1 contained: no fixture pid was owned, so nothing was probed or signalled beyond the exact parent child; the leg stops here', true)
    return { fixturePid: null, contained: true }
  }
  const wasAlive = await until(() => alive(fixturePid), 3_000)
  report('§1 the fixture was alive under its living parent', wasAlive)
  const listening = await until(() => /PORT \d+/.test(out), 10_000)
  report('§1 the fixture reached its port under the living parent', listening, out.slice(0, 200))
  await parentExit
  const died = await until(() => !alive(fixturePid), 6_000)
  report("§1 the parent gone, the fixture exited on its own within a few seconds — nobody reaped it (the orphan class closed)", died, `pid ${fixturePid} still alive after 6 s`)
  if (!died) endOwned(fixturePid, 'SIGKILL')
  return { fixturePid, contained: false }
}

{
  const recorded: Array<[number, NodeJS.Signals | 0]> = []
  const real = sendSignal
  sendSignal = (pid, sig) => {
    recorded.push([pid, sig])
  }
  check('§0 pid 0 is unowned: no probe signal is sent', probe(0) === 'unowned' && recorded.length === 0)
  check('§0 a negative pid is unowned', probe(-1) === 'unowned' && recorded.length === 0)
  check('§0 NaN / undefined / a float are unowned', probe(NaN) === 'unowned' && probe(undefined) === 'unowned' && probe(12.5) === 'unowned' && recorded.length === 0)
  check('§0 pid 1 and the prover’s own pid are never owned', probe(1) === 'unowned' && probe(process.pid) === 'unowned' && recorded.length === 0)
  check('§0 a SIGKILL aimed at pid 0 / −1 / NaN is REFUSED before any signal', endOwned(0, 'SIGKILL') === 'refused' && endOwned(-1, 'SIGKILL') === 'refused' && endOwned(NaN, 'SIGKILL') === 'refused' && recorded.length === 0)
  const mine = process.pid + 100_000
  check('§0 a validated pid does reach the signaller with the exact signal', (probe(mine), endOwned(mine, 'SIGTERM'), recorded.length === 2 && recorded[0]![0] === mine && recorded[0]![1] === 0 && recorded[1]![0] === mine && recorded[1]![1] === 'SIGTERM'), JSON.stringify(recorded))
  recorded.length = 0
  const rows: Array<[string, boolean]> = []
  const silent = await orphanLeg(() => spawn('/bin/sh', ['-c', 'exit 3'], { stdio: ['ignore', 'pipe', 'pipe'] }), (label, ok) => rows.push([label, ok]))
  check('§0 a parent shell that never names a fixture pid is a CONTAINED failure of its own leg', silent.fixturePid === null && silent.contained && rows.some(([l, ok]) => l.startsWith('§1 the parent shell') && !ok))
  check('§0 …and that leg sent NO signal at all (no zero, negative or group target)', recorded.length === 0, JSON.stringify(recorded))
  sendSignal = real
}

await orphanLeg(
  () => spawn('/bin/sh', ['-c', `"$0" run "$1" "$2" & echo FIXPID $!; sleep 2; exit 0`, BUN, FIXTURE, capture], { stdio: ['ignore', 'pipe', 'pipe'] }),
  check,
)

{
  const fixture = spawn(BUN, ['run', FIXTURE, capture], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  fixture.stdout.on('data', (c: Buffer) => {
    out += c.toString('utf8')
  })
  const listening = await until(() => /PORT \d+/.test(out), 10_000)
  check('§2 the fixture under a living parent reached its port', listening, out.slice(0, 200))
  await sleep(3_000)
  check('§2 the spawned fixture has an owned pid', ownedPid(fixture.pid), String(fixture.pid))
  check('§2 …and is still up three seconds later (the watch never fires on a living parent)', fixture.exitCode === null && alive(fixture.pid))
  fixture.kill('SIGTERM')
  const reaped = await until(() => fixture.exitCode !== null || !alive(fixture.pid), 5_000)
  check('§2 …and the reaper still ends it', reaped)
}

rmSync(scratch, { recursive: true, force: true })
console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
