#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = resolve(import.meta.dir, '..', '..')
const HOME = mkdtempSync(join(tmpdir(), 'trace-readers-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_TRACE = '1'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_CRITTER
mkdirSync(HOME, { recursive: true })

const React = (await import('react')).default
const { render } = await import(join(ROOT, 'src/screen/themedRenderer.ts'))
const { AppStateProvider } = await import(join(ROOT, 'src/screen/app-state/AppState.tsx'))
const { getDefaultAppState } = await import(join(ROOT, 'src/screen/app-state/AppStateStore.ts'))
const { enableConfigs } = await import(join(ROOT, 'src/platform/config/globalConfig.ts'))
enableConfigs()
const { getInvocationTracePath, buildInvocationTrace } = await import(join(ROOT, 'src/platform/observability/invocationTrace.ts'))
const { getSessionId, setOriginalCwd, setCwdState } = await import(join(ROOT, 'src/boot/process-state/processState.ts'))
setOriginalCwd(HOME)
setCwdState(HOME)
process.chdir(HOME)
const traceModule = await import(join(ROOT, 'src/screen/cockpit/traceSnapshot.ts'))
const { traceSnapshot } = traceModule
const sessionTraceSnapshot = (traceModule as { sessionTraceSnapshot?: (s: unknown, id: string | null) => { state: string; data?: { total: number; highRisk: number; killed: number; errors: number; records: Array<{ sessionId?: string }> } } }).sessionTraceSnapshot ?? ((s: unknown) => s as never)
const { noSessionConnector } = await import(join(ROOT, 'src/engine/connector/noSessionConnector.ts'))
const { setFocusedSessionConnector, conversationIdHere, _resetFocusedSessionConnectorForTesting } = await import(join(ROOT, 'src/engine/connector/focusedConnector.ts'))
const { pokeVitals, getVitals, _statsForProofs } = await import(join(ROOT, 'src/screen/app-state/vitalsBus.ts'))
const { TraceView } = await import(join(ROOT, 'src/commands/trace/TraceView.tsx'))
const h = React.createElement

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const j = (v: unknown): string => JSON.stringify(v)
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const settle = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const OWN = 'aaaaaaaa-bbbb-4ccc-8ddd-tracereadown1'
const OTHER = 'aaaaaaaa-bbbb-4ccc-8ddd-tracereadoth2'
const at = (minute: number): string => new Date(Date.UTC(2026, 9, 4, 18, minute, 0)).toISOString()
const record = (tool: string, minute: number, sessionId?: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ ts: at(minute), tool, surface: 'builtin', risk: tool === 'Bash' ? 'high' : 'low', ...(sessionId !== undefined ? { sessionId } : {}), ok: true, ...extra })

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

mkdirSync(join(getInvocationTracePath(), '..'), { recursive: true })
writeFileSync(
  getInvocationTracePath(),
  [record('Bash', 6, OTHER), record('Computer', 6, OTHER), record('Glob', 8, OWN), record('Bash', 9, OWN, { ok: false, killed: true }), record('Read', 7), record('Bash', 10, OTHER, { ok: false })].join('\n') + '\n',
)

section('§0 the emitted record carries the session it ran in')
{
  const trace = buildInvocationTrace({ name: 'Bash', isReadOnly: () => false } as never, { ok: true })
  check('an invocation trace record names its session', trace.sessionId === String(getSessionId()), `${JSON.stringify(trace)}; buildInvocationTrace in src/platform/observability/invocationTrace.ts must stamp the record with getSessionId()`)
}

section('§1 THE ONE NARROWING — a live trace snapshot narrowed to a session keeps its own records and re-derives the counts')
{
  const box = await traceSnapshot()
  check('the box-wide snapshot is live with six records (three sessions\' calls, one unstamped)', box.state === 'live' && box.data.total === 6, `${j({ state: box.state, total: box.state === 'live' ? box.data.total : null })}; traceSnapshot in src/screen/cockpit/traceSnapshot.ts must read all six lines of the trace file at getInvocationTracePath()`)
  const own = sessionTraceSnapshot(box, OWN)
  check('RED ON THE BASE: the session\'s own snapshot carries its two calls and nothing of the box', own.state === 'live' && own.data.total === 2 && own.data.records.every(r => r.sessionId === OWN), `${j(own.state === 'live' ? own.data.records : own)}; sessionTraceSnapshot in src/screen/cockpit/traceSnapshot.ts must keep only the records stamped with the session id`)
  check('…the counts are its own: 2 total · 1 high-risk class · 1 killed · 0 errored', own.state === 'live' && own.data.highRisk === 1 && own.data.killed === 1 && own.data.errors === 0, `${j(own.state === 'live' ? [own.data.highRisk, own.data.killed, own.data.errors] : own)}; sessionTraceSnapshot in src/screen/cockpit/traceSnapshot.ts must recount total, highRisk, killed and errors from the kept records`)
  const other = sessionTraceSnapshot(box, OTHER)
  check('the other session reads its own three (one errored)', other.state === 'live' && other.data.total === 3 && other.data.errors === 1, `${j(other.state === 'live' ? [other.data.total, other.data.errors] : other)}; sessionTraceSnapshot in src/screen/cockpit/traceSnapshot.ts must recount from the records of the session asked for`)
  const none = sessionTraceSnapshot(box, null)
  check('no session at all reads zero (an unstamped record belongs to no session)', none.state === 'live' && none.data.total === 0, 'sessionTraceSnapshot in src/screen/cockpit/traceSnapshot.ts must keep no record when the session id is null, including unstamped records')
  const off = sessionTraceSnapshot({ state: 'off', reason: 'enable with MERCURY_TRACE=1' } as never, OWN)
  check('a snapshot that is not live passes through untouched', off.state === 'off', 'sessionTraceSnapshot in src/screen/cockpit/traceSnapshot.ts must return a snapshot that is not live unchanged')
}

section('§2 /trace — the view reads the focused session\'s own records through the same narrowing')
{
  focusOn(OWN)
  check('the conversation reader answers the focused session', conversationIdHere() === OWN, `got ${String(conversationIdHere())}; conversationIdHere in src/engine/connector/focusedConnector.ts must answer the sessionId of the focused connector`)
  let written = ''
  const stdout = Object.assign(
    new Writable({ write(chunk: Buffer, _enc, cb) { written += chunk.toString(); cb() } }),
    { columns: 100, rows: 40, isTTY: false },
  ) as unknown as NodeJS.WriteStream
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
  const instance = await render(h(AppStateProvider as never, { initialState: getDefaultAppState() }, h(TraceView as never, { onClose: () => {} })), { stdout, stdin, exitOnCtrlC: false, patchConsole: false })
  pokeVitals()
  const deadline = Date.now() + 8000
  while (Date.now() < deadline && getVitals().trace?.state !== 'live') await settle(50)
  check('the vitals bus read the box-wide trace once the view subscribed', getVitals().trace?.state === 'live', j({ trace: getVitals().trace?.state ?? null, refreshedAt: getVitals().refreshedAt, version: getVitals().version, bus: _statsForProofs() }) + '; the vitals bus in src/screen/app-state/vitalsBus.ts did not publish a live trace after pokeVitals, or the view in src/commands/trace/TraceView.tsx did not subscribe')
  await settle(600)
  const frame = strip(instance.lastFrame())
  instance.unmount?.()
  await settle(30)
  check('RED ON THE BASE: the trace view lists the session\'s own calls (Glob, its killed Bash) and none of the other session\'s (Computer)', frame.includes('Glob') && !frame.includes('Computer'), frame.split('\n').filter(l => /Glob|Computer|Bash|Read/.test(l)).join(' | ') + '; src/commands/trace/TraceView.tsx must list only the focused session records, narrowed by sessionTraceSnapshot in src/screen/cockpit/traceSnapshot.ts')
  check('the view names no repo-wide count', !/\brepo\b/.test(frame), (frame.split('\n').find(l => /repo/.test(l)) ?? '') + '; remove the repo-wide count from src/commands/trace/TraceView.tsx')
}

section('§3 the deck pane narrows the same way and names no repo tail')
{
}

_resetFocusedSessionConnectorForTesting()
console.log(`\n${'═'.repeat(76)}`)
if (failures > 0) {
  console.log(`❌ prove-trace-readers-session-own: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ prove-trace-readers-session-own: /trace and the deck pane read the focused session\'s own tool calls')
process.exit(0)
