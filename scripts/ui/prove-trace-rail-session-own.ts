#!/usr/bin/env bun
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = resolve(import.meta.dir, '..', '..')
const HOME = mkdtempSync(join(tmpdir(), 'trace-rail-session-own-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_CRITTER

const React = (await import('react')).default
const { render } = await import(join(ROOT, 'src/ink.ts'))
const { AppStateProvider } = await import(join(ROOT, 'src/state/AppState.tsx'))
const { getDefaultAppState } = await import(join(ROOT, 'src/state/AppStateStore.ts'))
const { enableConfigs } = await import(join(ROOT, 'src/utils/config/globalConfig.ts'))
enableConfigs()
await import(join(ROOT, 'src/tasks.ts'))
const { HelmTelemetryRail } = await import(join(ROOT, 'src/components/HelmTelemetryRail.tsx'))
const focus = await import(join(ROOT, 'src/utils/cockpit/helmFocus.ts'))
const { noSessionConnector } = await import(join(ROOT, 'src/services/engine-connector/noSessionConnector.ts'))
const { setFocusedSessionConnector, _resetFocusedSessionConnectorForTesting } = await import(join(ROOT, 'src/services/engine-connector/focusedConnector.ts'))
const { getInvocationTracePath, buildInvocationTrace } = await import(join(ROOT, 'src/utils/observability/invocationTrace.ts'))
const { getSessionId } = await import(join(ROOT, 'src/bootstrap/state.ts'))

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const h = React.createElement as (...a: unknown[]) => React.ReactElement
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const settle = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const OWN = 'aaaaaaaa-bbbb-4ccc-8ddd-tracerailown1'
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-tracerailoth2'
const at = (minute: number): string => new Date(Date.UTC(2026, 9, 4, 18, minute, 0)).toISOString()
const record = (tool: string, minute: number, sessionId?: string): string =>
  JSON.stringify({ ts: at(minute), tool, surface: 'builtin', risk: 'low', ...(sessionId !== undefined ? { sessionId } : {}), ok: true })

function focusOn(sessionId: string): void {
  const base = noSessionConnector()
  const overrides: Record<string, unknown> = { sessionId: () => sessionId }
  setFocusedSessionConnector(new Proxy(base, {
    get(target, key) {
      if (typeof key === 'string' && key in overrides) return overrides[key]
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }))
}

async function paintRail(): Promise<string> {
  focus.resetHelmFocusForTest()
  let written = ''
  const stdout = Object.assign(
    new Writable({ write(chunk: Buffer, _enc, cb) { written += chunk.toString(); cb() } }),
    { columns: 30, rows: 40, isTTY: false },
  ) as unknown as NodeJS.WriteStream
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
  const instance = await render(h(AppStateProvider as never, { initialState: getDefaultAppState() }, h(HelmTelemetryRail as never, { width: 28 })), { stdout, stdin, exitOnCtrlC: false, patchConsole: false })
  await settle(600)
  const frame = strip(instance.lastFrame())
  instance.unmount?.()
  await settle(30)
  return frame
}
const traceBlock = (frame: string): string => {
  const lines = frame.split('\n')
  const start = lines.findIndex(l => l.includes('TRACE'))
  return start < 0 ? '' : lines.slice(start, start + 4).join('\n')
}

section('§1 the emitted record carries the session it ran in')
{
  const trace = buildInvocationTrace({ name: 'Bash', isReadOnly: () => false } as never, { ok: true })
  check('RED ON THE BASE: an invocation trace record names its session', trace.sessionId === String(getSessionId()), JSON.stringify(trace))
}

section("§2 a brand-new session's TRACE rail lists its own calls only — never another session's")
writeFileSync(getInvocationTracePath(), [record('Bash', 6, OTHER), record('Computer', 6, OTHER), record('Read', 7)].join('\n') + '\n')
{
  focusOn(OWN)
  const frame = await paintRail()
  const block = traceBlock(frame)
  check('RED ON THE BASE: a session that has run nothing shows an empty trace (no row of another session, no count of the box)', block.includes('TRACE') && block.includes('fills as tools run') && !block.includes('Bash') && !block.includes('Computer') && !block.includes('Read'), block)
  check('…and its count is its own (0), without the repo word', /TRACE · 0\b/.test(block) && !block.includes('repo'), block)
}
{
  writeFileSync(getInvocationTracePath(), [record('Bash', 6, OTHER), record('Glob', 8, OWN), record('Computer', 6, OTHER), record('Bash', 9, OWN), record('Read', 7)].join('\n') + '\n')
  focusOn(OWN)
  const frame = await paintRail()
  const block = traceBlock(frame)
  check("the focused session's own two calls paint, newest first, and the count is 2", /TRACE · 2\b/.test(block) && block.includes('Bash') && block.includes('Glob') && !block.includes('Computer') && !block.includes('Read') && block.indexOf('Bash') < block.indexOf('Glob'), block)
  focusOn(OTHER)
  const other = traceBlock(await paintRail())
  check("a hop to the other session shows that session's own calls (the box's rows follow the focus, never leak across it)", /TRACE · 2\b/.test(other) && other.includes('Computer') && !other.includes('Glob'), other)
}
_resetFocusedSessionConnectorForTesting()

console.log(failures === 0 ? '\nprove-trace-rail-session-own: all green' : `\nprove-trace-rail-session-own: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
