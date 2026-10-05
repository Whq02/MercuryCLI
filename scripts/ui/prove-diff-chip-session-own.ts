#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const ROOT = resolve(import.meta.dir, '..', '..')
const HOME = mkdtempSync(join(tmpdir(), 'diff-chip-own-'))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_LOCAL_PROBE_TARGETS = 'none'
process.env.MERCURY_LIVE_GLYPHS = '0'
process.env.MERCURY_FULLSCREEN = '1'
delete process.env.MERCURY_HOME
delete process.env.MERCURY_CRITTER
mkdirSync(HOME, { recursive: true })

const React = (await import('react')).default
const { render } = await import(join(ROOT, 'src/ink.ts'))
const { AppStateProvider } = await import(join(ROOT, 'src/state/AppState.tsx'))
const { getDefaultAppState } = await import(join(ROOT, 'src/state/AppStateStore.ts'))
const { enableConfigs } = await import(join(ROOT, 'src/utils/config/globalConfig.ts'))
enableConfigs()
const { noSessionConnector } = await import(join(ROOT, 'src/services/engine-connector/noSessionConnector.ts'))
const { setFocusedSessionConnector, _resetFocusedSessionConnectorForTesting } = await import(join(ROOT, 'src/services/engine-connector/focusedConnector.ts'))
const tracker = await import(join(ROOT, 'src/cost-tracker.ts'))
const { DeckPane } = await import(join(ROOT, 'src/components/DeckPane.tsx'))
const { MonitorView } = await import(join(ROOT, 'src/components/mercury-ui/screens/MonitorView.tsx'))
const h = React.createElement

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const settle = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

const RUNNER_USAGE = { totalCostUSD: 1.25, totalLinesAdded: 42, totalLinesRemoved: 7, unpricedTurns: 0 }
function focusOnRunner(): void {
  const base = noSessionConnector()
  const overrides: Record<string, unknown> = {
    sessionId: () => 'aaaaaaaa-bbbb-4ccc-8ddd-diffchipown01',
    usage: () => ({ ...base.usage(), ...RUNNER_USAGE }),
  }
  setFocusedSessionConnector(new Proxy(base, {
    get(target, key) {
      if (typeof key === 'string' && key in overrides) return overrides[key]
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  }))
}

async function paint(element: unknown, columns: number, rows: number): Promise<string> {
  let written = ''
  const stdout = Object.assign(
    new Writable({ write(chunk: Buffer, _enc, cb) { written += chunk.toString(); cb() } }),
    { columns, rows, isTTY: false },
  ) as unknown as NodeJS.WriteStream
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} }) as unknown as NodeJS.ReadStream
  const instance = await render(h(AppStateProvider as never, { initialState: getDefaultAppState() }, element as never), { stdout, stdin, exitOnCtrlC: false, patchConsole: false })
  await settle(400)
  const frame = strip(instance.lastFrame())
  instance.unmount?.()
  await settle(30)
  void written
  return frame
}
const diffOf = (frame: string): string => /(?:diff\s+)?\+(\d+)\s*\/\s*-(\d+)/.exec(frame.replace(/\n/g, ' '))?.slice(1, 3).join('/') ?? '(no diff chip)'

section('§1 the ground: the cockpit process edited nothing; the focused session\'s runner reports +42/-7')
focusOnRunner()
check('the cockpit\'s own ledger is empty (nothing was edited in this process)', tracker.getTotalLinesAdded() === 0 && tracker.getTotalLinesRemoved() === 0)

section('§2 the deck pane paints the session\'s own diff and spend')
{
  const frame = await paint(h(DeckPane as never, {}), 140, 40)
  check('RED ON THE BASE: the deck pane\'s diff chip reads the runner\'s +42/-7, never the cockpit process\'s +0/-0', diffOf(frame) === '42/7', diffOf(frame) + ' · ' + (frame.split('\n').find(l => /\+\d+\/-\d+/.test(l))?.trim() ?? frame.slice(0, 200)))
}

section('§3 /monitor\'s header paints the same session facts')
{
  const frame = await paint(h(MonitorView as never, { onClose: () => {} }), 140, 40)
  check('RED ON THE BASE: the monitor header\'s diff chip reads +42/-7', diffOf(frame) === '42/7', diffOf(frame) + ' · ' + (frame.split('\n').find(l => /diff/.test(l))?.trim() ?? frame.slice(0, 200)))
  check('…with the session\'s spend', frame.includes('$1.25'), frame.split('\n').find(l => /\$/.test(l))?.trim() ?? '')
}

section('§4 the three readers name the one source (source pins)')
{
  const deck = read('src/components/Deck.tsx')
  const pane = read('src/components/DeckPane.tsx')
  const monitor = read('src/components/mercury-ui/screens/MonitorView.tsx')
  for (const [name, source] of [['Deck', deck], ['DeckPane', pane], ['MonitorView', monitor]] as const) {
    check(`${name} reads the focused session's usage facts and never the process ledger's line counters`, source.includes('getFocusedSessionConnector().usage()') && !source.includes('getTotalLinesAdded') && !source.includes('getTotalCost()'), name)
  }
}

_resetFocusedSessionConnectorForTesting()
console.log(`\n${'═'.repeat(76)}`)
if (failures > 0) {
  console.log(`❌ prove-diff-chip-session-own: ${failures} failure(s)`)
  process.exit(1)
}
console.log('✅ prove-diff-chip-session-own: the deck, the deck pane and /monitor read the session\'s own diff and spend')
process.exit(0)
