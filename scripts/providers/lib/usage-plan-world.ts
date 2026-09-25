import React from 'react'
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'
import stringWidth from 'string-width'
import type { DOMElement, DOMNode } from '../../../src/ink/dom.js'

export function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index < 0 ? undefined : process.argv[index + 1]
}

export function tally() {
  let failures = 0
  return {
    check(name: string, ok: boolean, detail = '') {
      if (!ok) failures++
      console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${!ok && detail ? ` — ${detail}` : ''}`)
    },
    finish() {
      console.log(`usage plans: ${failures} failure(s)`)
      process.exitCode = failures === 0 ? 0 : 1
    },
  }
}

export async function usagePlanWorld() {
  const root = resolve(argument('--root') ?? join(import.meta.dir, '../../..'))
  const parent = process.env.TMPDIR && isAbsolute(process.env.TMPDIR) ? process.env.TMPDIR : tmpdir()
  const home = mkdtempSync(join(parent, 'usage-plans-'))
  const savedEnv = { ...process.env }
  for (const name of Object.keys(process.env)) {
    if (/^(MERCURY_|ANTHROPIC_|CLAUDE_|OPENAI_|ZAI_|OPENROUTER_|GOOGLE_|GEMINI_|MOONSHOT_|DEEPSEEK_|HF_|HUGGINGFACE_|AWS_|AZURE_)/.test(name) || /proxy/i.test(name)) delete process.env[name]
  }
  Object.assign(process.env, {
    HOME: home,
    MERCURY_CONFIG_DIR: home,
    MERCURY_AUTH_SCOPE_DIR: home,
    MERCURY_HOME: home,
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_EVOLUTION_LEDGER: '0',
    MERCURY_HELM_CONSOLE: '0',
    ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
    BROWSER: '/usr/bin/true',
    TZ: 'UTC',
    LANG: 'en_GB.UTF-8',
    LC_ALL: 'en_GB.UTF-8',
  })
  for (const name of ['ANTHROPIC_BASE_URL', 'MERCURY_OPENAI_AUTH_BASE', 'MERCURY_OPENAI_CHATGPT_BASE', 'MERCURY_OPENAI_API_BASE', 'MERCURY_OPENROUTER_AUTH_BASE', 'MERCURY_OPENROUTER_API_BASE', 'MERCURY_GEMINI_API_BASE', 'MERCURY_ZAI_API_BASE', 'MERCURY_MOONSHOT_API_BASE', 'MERCURY_MOONSHOT_OAUTH_BASE', 'MERCURY_MOONSHOT_CODING_BASE', 'MERCURY_DEEPSEEK_API_BASE', 'MERCURY_HUGGINGFACE_API_BASE', 'MERCURY_HUGGINGFACE_OAUTH_BASE', 'MERCURY_HUGGINGFACE_ROUTER_BASE', 'MERCURY_LOCAL_BASE_URL']) process.env[name] = 'http://127.0.0.1:1'
  ;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
  const originalNow = Date.now
  const originalLocale = Date.prototype.toLocaleString
  const reset = new Date()
  reset.setHours(18, 45, 0, 0)
  const resetAtMs = reset.getTime()
  const observedAtMs = resetAtMs - 2 * 3_600_000
  let now = observedAtMs + 12_000
  Date.now = () => now
  Date.prototype.toLocaleString = function (_locales, options) {
    return originalLocale.call(this, 'en-GB', { ...options, timeZone: 'UTC', hourCycle: 'h23' })
  }
  const window = (minutes: number, used: string, limit: string, resetsAtMs: number) => ({
    window: { duration: minutes, timeUnit: 'TIME_UNIT_MINUTE' },
    detail: { used, limit, resetTime: new Date(resetsAtMs).toISOString() },
  })
  const fiveHour = window(300, '50', '100', resetAtMs)
  const week = window(7 * 24 * 60, '250', '1000', resetAtMs + 7 * 86_400_000)
  let body: unknown = { limits: [week, fiveHour] }
  let refused = false
  const requests: string[] = []
  const escaped: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      requests.push(`${request.method} ${path}`)
      if (request.method !== 'GET' || path !== '/coding/v1/usages' || request.headers.get('authorization') !== 'Bearer kimi-fixture-access') return new Response(null, { status: 403 })
      return refused ? new Response(null, { status: 503 }) : Response.json(body)
    },
  })
  const base = `http://127.0.0.1:${server.port}`
  process.env.MERCURY_MOONSHOT_CODING_BASE = `${base}/coding/v1`
  const originalFetch = globalThis.fetch
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    if (url.origin !== base) {
      escaped.push(url.origin)
      throw new Error('Only the usage fixture may be contacted')
    }
    return originalFetch(input, { ...init, redirect: 'error' })
  }) as typeof fetch
  globalThis.fetch = fetchImpl
  const path = (relative: string) => join(root, relative)
  async function stub(relative: string, overrides: Record<string, unknown>) {
    const target = path(relative)
    const actual = await import(target)
    mock.module(target, () => ({ ...actual, ...overrides }))
  }
  await stub('src/utils/proxy.ts', { getApiFetch: () => fetchImpl, getProxyFetchOptions: () => ({}) })
  const { enableConfigs } = await import(path('src/utils/config.ts'))
  enableConfigs()
  const accounts = await import(path('src/services/providers/moonshot/moonshotAccounts.ts')) as typeof import('../../../src/services/providers/moonshot/moonshotAccounts.js')
  const secrets = await import(path('src/utils/router/providerSecrets.ts')) as typeof import('../../../src/utils/router/providerSecrets.js')
  accounts.writeMoonshotTokens({ accessToken: 'kimi-fixture-access', refreshToken: 'kimi-fixture-refresh' }, 'global')
  secrets.writeStoredZaiApiKey('zai-fixture-coding-key', 'coding')
  const reader = await import(path('src/services/providers/moonshot/moonshotUsageState.ts')) as typeof import('../../../src/services/providers/moonshot/moonshotUsageState.js')
  const owner = await import(path('src/services/providers/providerUsage.ts')) as typeof import('../../../src/services/providers/providerUsage.js')
  const fresh = await import(path('src/services/providers/usageFreshness.ts')) as typeof import('../../../src/services/providers/usageFreshness.js')
  const quota = await import(path('src/utils/cockpit/quota.ts')) as typeof import('../../../src/utils/cockpit/quota.js')
  const records = await import(path('src/services/claudeAiLimits.ts')) as typeof import('../../../src/services/claudeAiLimits.js')
  await owner.refreshProviderUsage('moonshot', { fetchImpl, now: () => observedAtMs, force: true })
  const ids = ['moonshot', 'zai', 'anthropic', 'openai', 'openrouter', 'gemini', 'deepseek', 'huggingface', 'openai-compat', 'local']
  await stub('src/services/providers/providerUsage.ts', {
    providerFamilyPresences: () => ids.map(id => ({ id, available: id === 'moonshot' || id === 'zai', credentialed: id === 'moonshot' || id === 'zai', credentialLabel: id === 'zai' ? 'GLM Coding Plan key' : accounts.resolveMoonshotAccount()?.label })),
  })
  await stub('src/utils/model/computedDefault.ts', { recentSignIns: () => [{ family: 'moonshot' }, { family: 'zai' }] })
  await stub('src/keybindings/useKeybinding.ts', { useKeybinding: () => undefined, useKeybindings: () => undefined })
  await stub('src/hooks/useExitOnCtrlCD.ts', { useExitOnCtrlCD: () => undefined })
  await stub('src/context/notifications.tsx', { useNotifications: () => ({ addNotification() {}, removeNotification() {} }) })
  let model = 'glm-fixture'
  const modelListeners = new Set<() => void>()
  const clockListeners = new Set<() => void>()
  const subscribeClock = (listener: () => void) => { clockListeners.add(listener); return () => { clockListeners.delete(listener) } }
  const connector = {
    modelFacts: () => ({ main: model }),
    subscribeModel: (listener: () => void) => { modelListeners.add(listener); return () => { modelListeners.delete(listener) } },
  }
  await stub('src/services/engine-connector/focusedConnector.ts', {
    getFocusedSessionConnector: () => connector,
    subscribeThroughFocused: (subscribe: (connection: typeof connector, listener: () => void) => () => void) => (listener: () => void) => subscribe(connector, listener),
  })
  await stub('src/components/tasks/useFocusedWork.ts', {
    useFocusedWorkRows: () => [],
    useFocusedWorkRoster: () => ({ rows: [], mission: [], reported: true }),
    otherSessionRunnerPids: () => new Set(),
    focusedSessionIdOrNull: () => null,
  })
  await stub('src/state/telemetryBus.ts', { useTelemetry: () => ({ trace: null, workflowsDisk: [] }) })
  await stub('src/utils/cockpit/healthCertSnapshot.ts', { healthCertSnapshot: () => ({ state: 'unavailable' }) })
  await stub('src/hooks/useTerminalSize.ts', { useTerminalSize: () => ({ columns: 178, rows: 51 }) })
  await stub('src/components/mercury-ui/components.tsx', { useNowTick: () => React.useSyncExternalStore(subscribeClock, () => now, () => now) })
  const ink = await import(path('src/ink.ts')) as typeof import('../../../src/ink.js')
  const { default: StdinContext } = await import(path('src/ink/components/StdinContext.ts'))
  const { default: squashText } = await import(path('src/ink/squash-text-nodes.ts')) as typeof import('../../../src/ink/squash-text-nodes.js')
  const mounted = new Set<() => void>()
  const settle = async () => {
    for (let index = 0; index < 8; index++) {
      ink.flushPendingSyncWork()
      await new Promise<void>(resolve => setTimeout(resolve, 5))
    }
  }
  function runs(node: DOMNode): string[] {
    if (node.nodeName === '#text') return []
    if (node.nodeName === 'ink-text') return [squashText(node)]
    return node.childNodes.flatMap(runs)
  }
  async function mount(content: React.ReactNode) {
    const emitter = new ink.EventEmitter()
    const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
    const stream = new PassThrough()
    stream.resume()
    const stdout = Object.assign(stream, { columns: 178, rows: 51 }) as unknown as NodeJS.WriteStream
    const ref = React.createRef<DOMElement>()
    const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
    const node = (child: React.ReactNode) => React.createElement(StdinContext.Provider, { value: context }, React.createElement(ink.Box, { ref, width: 178, height: 51, flexDirection: 'column' }, child))
    let painted = (): void => {}
    const firstFrame = new Promise<void>(resolve => { painted = resolve })
    const instance = await ink.render(node(content), { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
    await firstFrame
    await settle()
    const close = () => { instance.unmount(); instance.cleanup(); stream.destroy(); mounted.delete(close) }
    mounted.add(close)
    return {
      frame: () => stripAnsi(instance.lastFrame()).replace(/\n$/, '').split('\n').map(line => line.trimEnd()).join('\n'),
      runs: () => ref.current ? runs(ref.current) : [],
      async repaint(next: React.ReactNode) { instance.rerender(node(next)); await settle() },
      close,
    }
  }
  const frames = argument('--frames')
  if (frames) mkdirSync(frames, { recursive: true })
  function save(name: string, frame: string) {
    if (frames) writeFileSync(join(frames, `${name}-178x51.txt`), frame + '\n')
  }
  return {
    root, path, owner, accounts, secrets, reader, fresh, quota, records, ink, mount, settle, save,
    resetAtMs, observedAtMs, fiveHour, week, requests, escaped, fetchImpl,
    now: () => now,
    setNow: (value: number) => { now = value; for (const listener of clockListeners) listener() },
    focus: (value: 'moonshot' | 'zai') => { model = value === 'moonshot' ? 'kimi-fixture' : 'glm-fixture'; for (const listener of modelListeners) listener() },
    setBody: (value: unknown) => { body = value },
    refuse: (value: boolean) => { refused = value },
    inBounds: (frame: string) => frame.split('\n').length <= 51 && frame.split('\n').every(line => stringWidth(line) <= 178),
    close() {
      for (const close of mounted) close()
      server.stop(true)
      globalThis.fetch = originalFetch
      Date.now = originalNow
      Date.prototype.toLocaleString = originalLocale
      for (const name of Object.keys(process.env)) if (!(name in savedEnv)) delete process.env[name]
      Object.assign(process.env, savedEnv)
      rmSync(home, { recursive: true, force: true })
    },
  }
}
