#!/usr/bin/env bun
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import stripAnsi from 'strip-ansi'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const home = mkdtempSync(join(tmpdir(), 'model-cancel-'))
Object.assign(process.env, {
  MERCURY_CONFIG_DIR: home,
  MERCURY_CREDENTIAL_STORE: 'file',
  MERCURY_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  MERCURY_BOOT_PREFLIGHT: '0',
  MERCURY_LIVE_GLYPHS: '0',
  MERCURY_LIVE_CLOCK: '0',
  MERCURY_REDUCED_MOTION: '1',
  MERCURY_LOCAL_PROBE_TARGETS: 'none',
  ANTHROPIC_API_KEY: 'proof-key-ci-gate-not-a-real-key',
  FORCE_COLOR: '0',
})
for (const key of ['MERCURY_MODEL', 'MERCURY_EFFORT_LEVEL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'NODE_ENV']) delete process.env[key]

let failures = 0
function check(label: string, good: boolean, detail = ''): void {
  if (!good) failures++
  console.log(`  [${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log(`\n${t}`)
async function until(predicate: () => boolean, budgetMs = 6000): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
  return predicate()
}

class Output extends EventEmitter {
  isTTY = true
  constructor(public columns: number, public rows: number) { super() }
  write(): boolean { return true }
}

const React = await import('react')
const { default: Ink } = await import('../../src/ink/ink.tsx')
const { App } = await import('../../src/components/App.tsx')
const { getDefaultAppState } = await import('../../src/state/AppStateStore.ts')
const { KeybindingSetup } = await import('../../src/keybindings/KeybindingProviderSetup.tsx')
const { noSessionConnector } = await import('../../src/services/engine-connector/noSessionConnector.ts')
const { setFocusedSessionConnector, _resetFocusedSessionConnectorForTesting } = await import('../../src/services/engine-connector/focusedConnector.ts')
const { call } = await import('../../src/commands/model/model.tsx')
const { renderDefaultModelSetting, renderDefaultModelLabel } = await import('../../src/utils/model/model.ts')
const { default: instances } = await import('../../src/ink/instances.ts')
const h = React.createElement

const SESSION_MODEL = 'openrouter/deepseek/deepseek-v4-flash'
const TARGET = 'sonnet'
const sessionLabel = renderDefaultModelSetting(SESSION_MODEL)
const defaultLabel = renderDefaultModelLabel()
const records = [
  { type: 'user', uuid: '00000000-0000-4000-8000-00000000c001', message: { role: 'user', content: 'one sentence on the trade-offs' } },
  {
    type: 'assistant',
    uuid: '00000000-0000-4000-8000-00000000c002',
    message: {
      role: 'assistant',
      model: SESSION_MODEL,
      content: [{ type: 'thinking', thinking: 'a private chain the next model never sees' }, { type: 'text', text: 'the answer.' }],
    },
  },
]

type Mount = { frame: () => string; press: (bytes: string) => void; done: string[]; unmount: () => void }
async function mount(carrier: 'daemon' | 'in-process', screenMessages: unknown[]): Promise<Mount> {
  _resetFocusedSessionConnectorForTesting()
  const overrides: Record<string, unknown> = {
    carrier,
    sessionId: () => 'cancel-proof-session',
    modelFacts: () => ({ main: SESSION_MODEL, effective: SESSION_MODEL, effectiveSource: 'live', sessionPin: null, effort: 'medium', effortSent: 'medium', pendingSwitch: null }),
    records: () => records,
  }
  const connector = new Proxy(noSessionConnector(), {
    get(target, key) {
      if (typeof key === 'string' && key in overrides) return overrides[key]
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  setFocusedSessionConnector(connector as never)
  const done: string[] = []
  const element = await call((message: string) => { done.push(message) }, { messages: screenMessages } as never, TARGET)
  const stdout = new Output(120, 40)
  const stdin = Object.assign(new Readable({ read() {} }), { isTTY: true, setRawMode() {}, ref() {}, unref() {} })
  const ink = new Ink({ stdout: stdout as never, stdin: stdin as never, stderr: new Output(120, 40) as never, exitOnCtrlC: false, patchConsole: false })
  instances.set(stdout as never, ink)
  const state = { ...getDefaultAppState(), engineModel: null, engineModelForSession: null }
  ink.render(h(App, { initialState: state as never, getFpsMetrics: () => undefined }, h(KeybindingSetup, null, element as never)))
  return {
    frame: () => stripAnsi(ink.lastFrameText()),
    press: (bytes: string) => { stdin.push(bytes) },
    done,
    unmount: () => { try { ink.unmount() } catch {} },
  }
}

const deadline = setTimeout(() => { console.error('prove-model-cancel-names-session exceeded its deadline'); process.exit(1) }, 60_000)
deadline.unref()

section(`§1 a daemon-carried session on ${SESSION_MODEL}: the preview names the session's model, and so does the cancel`)
{
  const m = await mount('daemon', [])
  check('the preview card opens for a lossy switch (an unsigned thinking block does not cross to the anthropic wire)', await until(() => m.frame().includes('Model switch preview')), m.frame())
  check(`the card's from-label is the session's model (${sessionLabel})`, m.frame().includes(sessionLabel), m.frame())
  m.press('\x1b')
  check('esc cancels: one receipt line', await until(() => m.done.length === 1), JSON.stringify(m.done))
  const line = m.done[0] ?? ''
  check(`the cancel names the model the session is on: "Kept ${sessionLabel} — …"`, line === `Kept ${sessionLabel} — the model switch was cancelled at the preview.`, line)
  check("…never the screen's own default (the field's \"Kept Fable 5.1 (default — Anthropic, …)\")", !line.includes('(default') && !line.includes(defaultLabel), line)
  m.unmount()
}

section('§2 the n key cancels the same way')
{
  const m = await mount('daemon', [])
  check('the preview card opens', await until(() => m.frame().includes('Model switch preview')), m.frame())
  m.press('n')
  check('n cancels with the same receipt', await until(() => m.done.length === 1) && m.done[0] === `Kept ${sessionLabel} — the model switch was cancelled at the preview.`, JSON.stringify(m.done))
  m.unmount()
}

section('§3 control: an in-process session reads the screen\'s own model fields, as before')
{
  const m = await mount('in-process', records)
  check('the preview card opens over the screen\'s messages', await until(() => m.frame().includes('Model switch preview')), m.frame())
  m.press('\x1b')
  check('the cancel names the screen\'s effective model (its default: no pin, no session override)', await until(() => m.done.length === 1) && m.done[0] === `Kept ${defaultLabel} — the model switch was cancelled at the preview.`, JSON.stringify(m.done))
  m.unmount()
}

rmSync(home, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-model-cancel-names-session: all green' : `\nprove-model-cancel-names-session: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
