#!/usr/bin/env bun
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'key-verdict-home-')))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.NODE_ENV = 'test'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)

type Resolved = { key: string | null; source: string }
const world = {
  authEnabled: true,
  subscriber: false,
  onFile: (): Resolved => ({ key: null, source: 'none' }),
  resolved: (): Resolved => ({ key: null, source: 'none' }),
  helperFailure: null as { message: string } | null,
  wire: async (_key: string): Promise<boolean> => true,
  helperWarmed: 0,
  wireCalls: 0,
}
const auth = await import('../../src/utils/auth.ts')
mock.module('../../src/utils/auth.js', () => ({
  ...auth,
  isAnthropicAuthEnabled: () => world.authEnabled,
  isClaudeAISubscriber: () => world.subscriber,
  getAnthropicApiKeyWithSource: (opts?: { skipRetrievingKeyFromApiKeyHelper?: boolean }) => (opts?.skipRetrievingKeyFromApiKeyHelper ? world.onFile() : world.resolved()),
  getApiKeyFromApiKeyHelper: async () => { world.helperWarmed++; return null },
  getApiKeyHelperFailure: () => world.helperFailure,
}))
const anthropic = await import('../../src/services/providers/anthropic/index.ts')
mock.module('../../src/services/providers/anthropic/index.js', () => ({
  ...anthropic,
  verifyApiKey: async (key: string) => { world.wireCalls++; return world.wire(key) },
}))
const { useApiKeyVerification } = await import('../../src/hooks/useApiKeyVerification.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { Box, EventEmitter, render, flushPendingSyncWork } = await import('../../src/ink.js')
type Api = ReturnType<typeof useApiKeyVerification>

const settle = async (): Promise<void> => {
  for (let index = 0; index < 4; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}
const mount = async () => {
  let latest: Api | null = null
  const seen: Api[] = []
  function Probe(): React.ReactNode {
    latest = useApiKeyVerification()
    seen.push(latest)
    return null
  }
  const emitter = new EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns: 80, rows: 24 }) as unknown as NodeJS.WriteStream
  const stdinValue = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const instance = await render(React.createElement(StdinContext.Provider, { value: stdinValue as never }, React.createElement(Box, null, React.createElement(Probe))), { stdin, stdout, patchConsole: false, exitOnCtrlC: false })
  await settle()
  return {
    api: (): Api => latest as Api,
    renders: (): Api[] => seen,
    async reverify(opts?: { probe?: boolean }) { await (latest as Api).reverify(opts); await settle() },
    close() { instance.unmount(); instance.cleanup(); stream.destroy() },
  }
}

section('§1 THE OPENING STATUS — read once from what is on file, without running the helper')
{
  world.onFile = () => ({ key: 'sk-on-file', source: 'ANTHROPIC_API_KEY' })
  const withKey = await mount()
  check('a key on file opens as loading', withKey.api().status === 'loading', withKey.api().status)
  check('the helper was not run and no request was made', world.helperWarmed === 0 && world.wireCalls === 0)
  withKey.close()
  world.onFile = () => ({ key: null, source: 'credentials.keyCommand' })
  const withHelper = await mount()
  check('a configured helper not yet run opens as loading', withHelper.api().status === 'loading', withHelper.api().status)
  withHelper.close()
  world.onFile = () => ({ key: null, source: 'none' })
  const bare = await mount()
  check('no key and no helper opens as missing', bare.api().status === 'missing', bare.api().status)
  bare.close()
  world.onFile = () => { throw new Error('keyless environment') }
  const keyless = await mount()
  check('a throwing read opens as missing, never a render error', keyless.api().status === 'missing', keyless.api().status)
  keyless.close()
  world.subscriber = true
  const subscriber = await mount()
  check('a subscriber opens as valid without reading anything', subscriber.api().status === 'valid')
  subscriber.close()
  world.subscriber = false
  world.authEnabled = false
  const off = await mount()
  check('Anthropic auth off opens as valid', off.api().status === 'valid')
  off.close()
  world.authEnabled = true
}

section('§2 REVERIFY — the helper is warmed, then the ladder: missing, the helper error, the quiet read, the wire probe')
{
  world.onFile = () => ({ key: null, source: 'none' })
  const field = await mount()
  world.resolved = () => { throw new Error('keyless') }
  await field.reverify()
  check('a throwing resolve reads missing with no error recorded', field.api().status === 'missing' && field.api().error === null && world.helperWarmed === 1, j([field.api().status, world.helperWarmed]))
  world.resolved = () => ({ key: null, source: 'none' })
  await field.reverify()
  check('no key reads missing', field.api().status === 'missing')
  world.resolved = () => ({ key: null, source: 'credentials.keyCommand' })
  world.helperFailure = { message: 'exit 3' }
  await field.reverify()
  check('a helper that gave nothing reads error with the recorded reason', field.api().status === 'error' && field.api().error?.message === 'the configured credentials.keyCommand returned no valid key: exit 3', j([field.api().status, field.api().error?.message]))
  world.helperFailure = null
  await field.reverify()
  check('without a recorded reason the error names the helper alone', field.api().error?.message === 'the configured credentials.keyCommand returned no valid key', String(field.api().error?.message))
  world.resolved = () => ({ key: 'sk-live', source: 'ANTHROPIC_API_KEY' })
  await field.reverify({ probe: false })
  check('a key with probe: false reads valid and makes no request', field.api().status === 'valid' && world.wireCalls === 0, j([field.api().status, world.wireCalls]))
  check('the earlier error is kept (never cleared by a later success)', field.api().error !== null)
  world.wire = async () => false
  await field.reverify()
  check('the wire probe refusing reads invalid', field.api().status === 'invalid' && world.wireCalls === 1, j([field.api().status, world.wireCalls]))
  world.wire = async () => true
  await field.reverify()
  check('the wire probe accepting reads valid', field.api().status === 'valid' && world.wireCalls === 2)
  world.wire = async () => { throw new Error('socket closed') }
  await field.reverify()
  check('a throwing probe reads error with the thrown error', field.api().status === 'error' && field.api().error?.message === 'socket closed', j([field.api().status, field.api().error?.message]))
  world.wire = async () => { throw 'plain string' }
  await field.reverify()
  check('a non-Error throw is wrapped', field.api().error?.message === 'plain string', String(field.api().error?.message))
  world.subscriber = true
  await field.reverify()
  check('a subscriber reads valid at once', field.api().status === 'valid')
  world.subscriber = false
  field.close()
}

section('§3 THE IDENTITY LAW — one object per (status, error) pair')
{
  world.onFile = () => ({ key: 'sk-on-file', source: 'ANTHROPIC_API_KEY' })
  const field = await mount()
  const first = field.api()
  await settle()
  check('a re-render without a change hands back the same object', field.api() === first)
  world.resolved = () => ({ key: 'sk-on-file', source: 'ANTHROPIC_API_KEY' })
  await field.reverify({ probe: false })
  check('a status change mints a new object', field.api() !== first && field.api().status === 'valid')
  field.close()
}

console.log(failures === 0 ? '\nPASS key verdict ladder' : `\nFAIL ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
