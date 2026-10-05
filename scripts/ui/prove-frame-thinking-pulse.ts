#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = resolve(import.meta.dir, '..', '..')
process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'frame-thinking-pulse-'))
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
const { MercuryFrame } = await import(join(ROOT, 'src/components/MercuryFrame.tsx'))
const { noSessionConnector } = await import(join(ROOT, 'src/services/engine-connector/noSessionConnector.ts'))
const { setFocusedSessionConnector, _resetFocusedSessionConnectorForTesting } = await import(join(ROOT, 'src/services/engine-connector/focusedConnector.ts'))
const { statusLine } = await import(join(ROOT, 'src/components/SwitchboardTagBar.tsx'))

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

type Phase = 'thinking' | 'tool' | 'responding' | 'idle'
const seat = { inFlight: true, phase: 'thinking' as Phase, quietMs: 3000 as number | null, phaseMs: 252_000 as number | null, stuck: false, wait: null as unknown }
const listeners = new Set<() => void>()
const live = () => ({ inFlight: seat.inFlight, phase: seat.phase, agentsWaiting: 0, inProgressToolUseIDs: new Set<string>(), turnStartedAtMs: Date.now() - 300_000 })
const status = () => ({ title: 'the seat', projectLabel: 'project', interrupting: false, hardStopping: false, wait: seat.wait, quietMs: seat.quietMs, watchdogMs: 600_000, phaseMs: seat.phaseMs, toolBudgetMs: null, stuck: seat.stuck })
const overrides: Record<string, unknown> = {
  sessionId: () => 'aaaaaaaa-bbbb-4ccc-8ddd-thinkingpulse',
  live,
  status,
  subscribeLive: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  tail: () => ({ subscribe: () => () => {}, read: () => null }),
}
const base = noSessionConnector()
setFocusedSessionConnector(new Proxy(base, {
  get(target, key) {
    if (typeof key === 'string' && key in overrides) return overrides[key]
    const value = Reflect.get(target, key, target)
    return typeof value === 'function' ? value.bind(target) : value
  },
}))
const poke = (): void => { for (const l of listeners) l() }

let written = ''
const stdout = Object.assign(
  new Writable({ write(chunk: Buffer, _enc, cb) { written += chunk.toString(); cb() } }),
  { columns: 120, rows: 20, isTTY: false },
) as unknown as NodeJS.WriteStream
const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
const instance = await render(h(AppStateProvider as never, { initialState: getDefaultAppState() }, h(MercuryFrame as never, { model: 'claude-fable-5-1' })), { stdout, stdin, exitOnCtrlC: false, patchConsole: false })
await settle(500)
const band = (): string => strip(instance.lastFrame()).split('\n').find(l => l.includes('◐ thinking')) ?? strip(instance.lastFrame()).split('\n').filter(l => l.trim() !== '').slice(-1)[0] ?? ''

section("§1 the band's thinking pulse: the phase, how long it has stood, and the age of the stream's last frame")
{
  const row = band()
  check('RED ON THE BASE: while the focused session thinks, the band carries the pulse chip in the heartbeat grammar (◐ thinking <elapsed> · ↻<last frame age>)', row.includes('◐ thinking 4m · ↻3s'), row)
  check("the status row itself still says nothing for a healthy think (the pulse is the band's, not a second sentence)", statusLine(live() as never, status() as never) === '', statusLine(live() as never, status() as never))
}

section('§2 the chip moves with the stream: the age climbs on the tick when no frame arrives, and resets when one does')
{
  seat.quietMs = 41_000
  await settle(1300)
  check('a stream gone quiet for 41 s reads ↻41s on the next tick without any frame from the runner', band().includes('↻41s'), band())
  seat.quietMs = 1000
  seat.phaseMs = 253_000
  poke()
  await settle(300)
  check('a frame arriving brings the age back down', band().includes('↻1s'), band())
}

section('§3 the chip is the thinking phase only, and never over a wait the status row already speaks')
{
  seat.phase = 'tool'
  poke()
  await settle(300)
  check('a running tool shows no thinking pulse (the tool rows carry their own progress)', !band().includes('◐ thinking'), band())
  seat.phase = 'responding'
  poke()
  await settle(300)
  check('prose streaming shows no thinking pulse (the transcript moves)', !band().includes('◐ thinking'), band())
  seat.phase = 'thinking'
  seat.wait = { kind: 'first-byte', cold: false, promptTokens: 10, model: 'Fable', budgetMs: 60_000, sinceMs: Date.now(), attempt: 1 }
  poke()
  await settle(300)
  check('a request wait is the status row\'s sentence, not a second chip', !band().includes('◐ thinking'), band())
  seat.wait = null
  seat.inFlight = false
  seat.phase = 'idle'
  poke()
  await settle(300)
  check('an idle session shows no pulse', !band().includes('◐ thinking'), band())
}

section('§4 the stuck verdict keeps the chip and only changes its ink (never a guard, a cap or a nudge)')
{
  seat.inFlight = true
  seat.phase = 'thinking'
  seat.quietMs = 320_000
  seat.phaseMs = 600_000
  seat.stuck = true
  poke()
  await settle(300)
  const row = band()
  check('past the watchdog\'s warning point the chip still paints, with the elapsed think and the silence', row.includes('◐ thinking 10m · ↻5m'), row)
  const frameSrc = await import('node:fs').then(fs => fs.readFileSync(join(ROOT, 'src/components/MercuryFrame.tsx'), 'utf8'))
  check('the band holds no thinking clock of its own: the facts are the seat\'s (phaseMs, quietMs, stuck) and nothing here aborts, caps or nudges a think', frameSrc.includes('thinkingStatus.stuck ? tok.warning : tok.success') && !/abort|setTimeout\(|nudge/.test(frameSrc.slice(frameSrc.indexOf('thinkingKey'), frameSrc.indexOf('thinkingNode ='))))
}

instance.unmount?.()
_resetFocusedSessionConnectorForTesting()
console.log(failures === 0 ? '\nprove-frame-thinking-pulse: all green' : `\nprove-frame-thinking-pulse: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
