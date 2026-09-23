#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' the control server start and a pipe name another process holds')
console.log('============================================================')

if (process.platform !== 'win32') {
  console.log('  [SKIP] POSIX removes a stale socket file before it listens; the named-pipe leg is Windows-only')
  process.exit(0)
}

const HOME = mkdtempSync(join(tmpdir(), 'pipe-phantom-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { controlSockPath } = await import('../../src/daemon/controlSocket.ts')
const { startControlServer } = await import('../../src/daemon/controlServer.ts')

const pipe = controlSockPath()
let connections = 0
const holder = net.createServer(sock => {
  connections++
  sock.on('error', () => {})
  sock.destroy()
})
await new Promise<void>((resolve, reject) => {
  holder.once('error', reject)
  holder.listen(pipe, () => resolve())
})

let outcome = 'listening'
try {
  const handle = await startControlServer({} as never)
  await handle.close()
} catch (error) {
  outcome = (error as NodeJS.ErrnoException).code ?? String(error)
}
await new Promise(resolve => setTimeout(resolve, 200))

check('the start does not take over the name another process holds', outcome !== 'listening', outcome)
check('the start makes no connection to the process that holds the name', connections === 0, `${connections} connection(s)`)

await new Promise<void>(resolve => holder.close(() => resolve()))
try {
  rmSync(HOME, { recursive: true, force: true, maxRetries: 3 })
} catch {
}
console.log(failures === 0 ? '\nALL PIPE PHANTOM-CONNECT CHECKS PASS' : `\n${failures} CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
