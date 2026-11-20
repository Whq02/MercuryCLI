#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const HERE = import.meta.dir
const BUN = process.execPath.includes('bun') ? process.execPath : join(process.env.HOME ?? '', '.bun/bin/bun')
const SRC = process.env.PROVE_SRC ?? join(HERE, '../../src')
const POSIX_MODES = process.platform !== 'win32' && (typeof process.getuid !== 'function' || process.getuid() !== 0)

function scratch(tag: string): string {
  return mkdtempSync(join(tmpdir(), `faults-fo03-${tag}-`))
}

function runChild(body: string, timeoutMs = 8000): { timedOut: boolean; out: string } {
  const dir = scratch('child')
  const file = join(dir, 'child.ts')
  writeFileSync(file, body)
  const r = spawnSync(BUN, [file], { encoding: 'utf8', timeout: timeoutMs, env: { ...process.env } })
  return { timedOut: r.error !== undefined || r.signal !== null, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const BOX = join(SRC, 'daemon/saturnBoxSchedules.ts')
const HELD = `{ scheduleId: 'bbbbbbbb', dueAt: 1, reason: 'unreachable', envelope: { kind: 'birth', birth: {} }, heldAt: 1 }`

console.log('saturnBoxSchedules')
{
  const dir = scratch('box-eloop')
  symlinkSync(join(dir, 'saturn-box-schedules.json.lock'), join(dir, 'saturn-box-schedules.json.lock'))
  const r = runChild(`import { removeBoxSchedule } from ${JSON.stringify(BOX)}
try { console.log('RESULT', removeBoxSchedule('aaaaaaaa', ${JSON.stringify(dir)})) } catch (e) { console.log('THREW', (e as NodeJS.ErrnoException).code) }`)
  check('box-lock-stat-fails: an unreadable lock throws instead of spinning', !r.timedOut && /THREW ELOOP/.test(r.out), r.timedOut ? 'spun past the timeout' : r.out.slice(0, 200))
}
{
  const dir = scratch('box-enotdir')
  const lock = join(dir, 'saturn-box-schedules.json.lock')
  writeFileSync(lock, 'x')
  utimesSync(lock, new Date(0), new Date(0))
  const r = runChild(`import { removeBoxSchedule } from ${JSON.stringify(BOX)}
try { console.log('RESULT', removeBoxSchedule('aaaaaaaa', ${JSON.stringify(dir)})) } catch (e) { console.log('THREW', (e as NodeJS.ErrnoException).code) }`)
  check('box-lock-break-fails: a stale lock that cannot be removed throws instead of spinning', !r.timedOut && /THREW ENOTDIR/.test(r.out), r.timedOut ? 'spun past the timeout' : r.out.slice(0, 200))
}
{
  const dir = scratch('box-corrupt')
  const path = join(dir, 'saturn-box-schedules.json')
  writeFileSync(path, '{"version":1,"schedules":[{"id":"cccccccc"')
  const r = runChild(`import { holdBoxFire } from ${JSON.stringify(BOX)}
try { console.log('RESULT', holdBoxFire(${HELD}, ${JSON.stringify(dir)})) } catch (e) { console.log('THREW', (e as Error).name) }`)
  check('box-read-corrupt-hold: a corrupt box file is not replaced by a hold', /THREW SyntaxError/.test(r.out), r.out.slice(0, 200))
  check('box-read-corrupt-file-kept: the corrupt file still stands as written', readFileSync(path, 'utf8') === '{"version":1,"schedules":[{"id":"cccccccc"')
}
if (POSIX_MODES) {
  const dir = scratch('box-eacces')
  const path = join(dir, 'saturn-box-schedules.json')
  const body = JSON.stringify({ version: 1, schedules: [], heldFires: [] })
  writeFileSync(path, body)
  chmodSync(path, 0o000)
  const r = runChild(`import { holdBoxFire } from ${JSON.stringify(BOX)}
try { console.log('RESULT', holdBoxFire(${HELD}, ${JSON.stringify(dir)})) } catch (e) { console.log('THREW', (e as NodeJS.ErrnoException).code) }`)
  chmodSync(path, 0o600)
  check('box-read-eacces-hold: an unreadable box file throws EACCES, not held over it', /THREW EACCES/.test(r.out), r.out.slice(0, 200))
  check('box-read-eacces-file-kept: the unreadable file still stands as written', readFileSync(path, 'utf8') === body)
}

console.log(failures === 0 ? 'all rows pass' : `${failures} row(s) failed`)
process.exit(failures === 0 ? 0 : 1)
