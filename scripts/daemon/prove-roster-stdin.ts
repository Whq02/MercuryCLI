#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mock } from 'bun:test'

const scratch = mkdtempSync(join(tmpdir(), 'roster-stdin-'))
process.env.MERCURY_CONFIG_DIR = join(scratch, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
const child = Object.assign(new EventEmitter(), {
  pid: process.pid,
  stdin: new PassThrough(),
  stdout: new PassThrough(),
  stderr: new PassThrough(),
})
const childModule = await import('../../src/daemon/headlessRun.ts')
mock.module('../../src/daemon/headlessRun.ts', () => ({ ...childModule, spawnStreamJsonChild: () => ({ child }) }))
const { TaskRoster } = await import('../../src/daemon/roster.ts')
const { enableConfigs, saveGlobalConfig } = await import('../../src/utils/config/globalConfig.ts')
enableConfigs()
saveGlobalConfig(c => ({ ...c, switchboardCapacity: { askedAt: Date.now(), allowed: true, recommendedSeats: 3 } }))
let failures = 0
function check(name: string, pass: boolean): void {
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`)
  if (!pass) failures++
}
try {
  const roster = new TaskRoster({ dir: scratch, breaker: {} as never, maxInflight: 3 })
  check('the fixture registers a live worker', roster.registerLongLived('worker', { cwd: scratch, model: 'fixture-model', effort: 'high', role: 'MERCURY_CONCOURSE_WORKER', agentId: 'fixture' } as never).ok)
  check('live control is delivered', roster.control('worker', '{"type":"control_request"}'))
  let escaped = false
  try { child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })) } catch { escaped = true }
  check('asynchronous stdin failure cannot escape and stop the daemon', !escaped)
  const handle = (roster as any).handles.get('worker')
  handle.entry.state = 'retiring'
  const buffered = child.stdin.readableLength
  check('retiring workers refuse control', !roster.control('worker', '{"type":"control_request"}'))
  check('retiring workers refuse messages', !await roster.reply('worker', 'new work'))
  check('retiring refusal writes no bytes', child.stdin.readableLength === buffered)
  handle.longLived.intentionalStop = true
  child.emit('exit', 0, null)
  check('observed exit still settles the worker', roster.list()[0]?.outcome === 'killed')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
