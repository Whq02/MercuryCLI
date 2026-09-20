import assert from 'node:assert/strict'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { collectWindowsProcesses } from '../../src/daemon/processSweepWindows.js'
import type { DoctorProcessesReport } from '../../src/cli/doctorProcesses.js'

if (process.platform !== 'win32') {
  console.log('SKIP: the integrated Windows process sweep requires Windows')
  process.exit(0)
}
const root = resolve(import.meta.dir, '../..')
const node = join(root, 'dist/vendor/node/node.exe')
const bundle = join(root, 'dist/mercury.mjs')
const scratch = mkdtempSync(join(tmpdir(), 'process-doctor-'))
const home = join(scratch, 'home')
const fixture = join(scratch, 'mercury.mjs')
mkdirSync(join(home, 'processes'), { recursive: true })
writeFileSync(fixture, 'setInterval(() => {}, 1000)\n')
const env = { ...process.env, MERCURY_CONFIG_DIR: home, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_UPDATE_API_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', ANTHROPIC_API_KEY: 'fixture-key-000' }
const children: ChildProcess[] = []
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }
const doctor = (...args: string[]): string => execFileSync(node, [bundle, 'doctor', ...args], { env, cwd: scratch, windowsHide: true, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 })
try {
  for (const detached of [false, true]) {
    const child = spawn(node, [fixture], { env, cwd: scratch, windowsHide: true, detached, stdio: 'ignore' })
    children.push(child)
    await once(child, 'spawn')
  }
  const table = await collectWindowsProcesses()
  assert.equal(table.complete, true, table.error)
  const [live, stale] = children.map(child => table.observations.find(row => row.process.pid === child.pid))
  assert.ok(live && stale)
  assert.equal(live.terminalAlive, true)
  assert.equal(stale.terminalAlive, false)
  const old = Date.now() - 86_400_000
  const id = randomUUID()
  const registration = join(home, 'processes', `cockpit-${stale.process.pid}-${id}.json`)
  writeFileSync(registration, JSON.stringify({ schema: 1, id, pid: stale.process.pid, startToken: stale.startToken, configHome: home, daemonDir: join(home, 'daemon'), terminal: stale.process.terminal, bornAt: old, heartbeatAt: old }))
  utimesSync(registration, new Date(old), new Date(old))
  const before: DoctorProcessesReport = JSON.parse(doctor('processes'))
  assert.equal(before.complete, true, before.error)
  const reviewed = before.entries.filter(entry => entry.classification === 'stale')
  assert.deepEqual(reviewed.map(entry => entry.process.pid), [stale.process.pid], 'only the owned expired registration may be eligible for ending')
  assert.equal(before.entries.find(entry => entry.process.pid === live.process.pid)?.classification, 'running')
  console.log('BEFORE ' + JSON.stringify({ summary: before.summary, entries: before.entries.map(entry => ({ pid: entry.process.pid, classification: entry.classification, reason: entry.reason })) }))
  const health = JSON.parse(doctor('--json')) as { sections: Array<{ checks: Array<{ name?: string; label?: string; id?: string; evidence?: string }> }> }
  const row = health.sections.flatMap(section => section.checks).find(check => JSON.stringify(check).includes('Mercury processes'))
  assert.ok(row, 'doctor --json carries the Mercury processes row')
  console.log('HEALTH ' + JSON.stringify(row))
  const after: DoctorProcessesReport = JSON.parse(doctor('processes', '--end-stale'))
  assert.equal(after.complete, true, after.error)
  assert.match(after.result ?? '', /^Ended 1 stale processes; 0 could not be ended;/)
  assert.deepEqual(after.endings.map(ending => ending.entry.process.pid), [stale.process.pid])
  assert.equal(alive(stale.process.pid), false)
  assert.equal(alive(live.process.pid), true, 'the console-backed fixture remains running')
  console.log('AFTER ' + JSON.stringify({ result: after.result, endings: after.endings.map(ending => ({ pid: ending.entry.process.pid, outcome: ending.outcome, reason: ending.reason })) }))
  const again: DoctorProcessesReport = JSON.parse(doctor('processes', '--end-stale'))
  assert.equal(again.endings.length, 0)
  assert.equal(alive(live.process.pid), true)
  console.log('PASS: the built doctor ends only its reviewed stale process, preserves the live process and repeats safely')
} finally {
  for (const child of children) {
    if (child.pid !== undefined && alive(child.pid)) child.kill()
  }
  const deadline = Date.now() + 5000
  while (children.some(child => child.pid !== undefined && alive(child.pid)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
  assert.ok(children.every(child => child.pid === undefined || !alive(child.pid)), 'all owned fixture processes have ended')
  rmSync(scratch, { recursive: true, force: true })
  console.log('CLEANUP: owned fixture processes ended and scratch home removed')
}
