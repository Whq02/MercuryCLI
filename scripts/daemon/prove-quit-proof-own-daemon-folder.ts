#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const world = mkdtempSync(join(tmpdir(), 'prove-quit-own-daemon-'))
const handed = join(world, 'daemon')
mkdirSync(handed, { recursive: true })
process.env.MERCURY_CONFIG_DIR = join(world, 'home')
process.env.MERCURY_DAEMON_DIR = handed
const { controlSockPath } = (await import('../../src/daemon/controlSocket.ts')) as { controlSockPath: () => string }

console.log('============================================================')
console.log(' prove-quit-reaps-the-tree calls no daemon but its own')
console.log('============================================================')

const calls: string[] = []
const callers: Socket[] = []
const door = createServer(sock => {
  callers.push(sock)
  sock.on('error', () => {})
  sock.on('data', chunk => {
    let op = 'unreadable'
    try {
      op = String((JSON.parse(String(chunk).split('\n')[0] ?? '') as { op?: unknown }).op)
    } catch {}
    calls.push(op)
    sock.write(JSON.stringify({ ok: true, op: 'shutdown', reaped: 0, workers: [] }) + '\n')
  })
})
await new Promise<void>((resolve, reject) => {
  door.once('error', reject)
  door.listen(controlSockPath(), resolve)
})

const proof = spawn(process.execPath, [join(import.meta.dir, 'prove-quit-reaps-the-tree.ts')], { env: { ...process.env, MERCURY_DAEMON_DIR: handed }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
let said = ''
proof.stdout?.on('data', chunk => (said += String(chunk)))
proof.stderr?.on('data', chunk => (said += String(chunk)))
const code = await new Promise<number | null>(resolve => proof.on('exit', resolve))
for (const sock of callers) sock.destroy()
await new Promise<void>(resolve => door.close(() => resolve()))

check(
  'run with a daemon folder handed in by its environment, where a daemon stands and answers, the proof never calls that daemon',
  calls.length === 0,
  `the stand-in at ${handed} was called ${calls.length} time(s): ${calls.join(', ')}`,
)
check(
  'and it reads there what it reads alone',
  code === 0,
  `exit ${String(code)}: ${said.split('\n').filter(line => line.includes('[FAIL]')).map(line => line.trim().slice(0, 200)).join(' | ')}`,
)

rmSync(world, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-quit-proof-own-daemon-folder${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
