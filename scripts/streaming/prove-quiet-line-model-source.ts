#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'quiet-line-home-'))

process.env.MERCURY_FLUX_PROBE = '1'
delete process.env.MERCURY_FLUX_PROBE_TEE
const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)
const code = (src: string): string => src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

const React = (await import('react')).default
const { render, Box, Text } = await import(join(ROOT, 'src/ink.ts'))
const { AppStateProvider } = await import(join(ROOT, 'src/state/AppState.tsx'))
const { getDefaultAppState } = await import(join(ROOT, 'src/state/AppStateStore.ts'))
const { createStreamingTailStore } = await import(join(ROOT, 'src/utils/messages/streamingTailStore.ts'))

const { enableConfigs } = await import(join(ROOT, 'src/utils/config/globalConfig.ts'))
enableConfigs()
const { LiveStreamingTail } = await import(join(ROOT, 'src/components/LiveStreamingTail.tsx'))
const focus = await import(join(ROOT, 'src/services/engine-connector/focusedConnector.ts'))
const probe = await import(join(ROOT, 'src/utils/flux/fluxProbe.ts'))
type EngineConnectorV1 = import('../../src/services/engine-connector/types.js').EngineConnectorV1

function stubSession(effective: string): { connector: EngineConnectorV1; set: (next: string) => void; listeners: () => number } {
  const listeners = new Set<() => void>()
  let model = effective
  const connector = {
    modelFacts: () => ({ effective: model, main: model, setting: model, sessionPin: null, pendingSwitch: null }),
    subscribeModel: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  } as unknown as EngineConnectorV1
  return {
    connector,
    set(next: string) {
      model = next
      for (const l of listeners) l()
    },
    listeners: () => listeners.size,
  }
}

let written = ''
const stdout = Object.assign(
  new Writable({
    write(chunk: Buffer, _enc, cb) {
      written += chunk.toString()
      cb()
    },
  }),
  { columns: 80, rows: 24, isTTY: false },
) as unknown as NodeJS.WriteStream
const stdin = Object.assign(new Readable({ read() {} }), {
  isTTY: true,
  setRawMode() {},
  ref() {},
  unref() {},
}) as unknown as NodeJS.ReadStream
const strip = (s: string): string => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const settle = (ms = 120): Promise<void> => new Promise(r => setTimeout(r, ms))
const painted = (): string => strip(written)
const h = React.createElement as (...a: unknown[]) => React.ReactElement
const tailRenders = (): number => probe.fluxProbeDump().allMarks.filter((m: { k: string }) => m.k === 'render:tail').length

const GPT = 'gpt-5.2'
const CLAUDE = 'claude-opus-5'

const MARKER = 'frame-marker'
const framed = (): boolean => painted().includes(MARKER)

async function scene(appModel: string, sessionModel: string): Promise<{ frame: string; session: ReturnType<typeof stubSession>; unmount: () => void }> {
  const session = stubSession(sessionModel)
  focus.setFocusedSessionConnector(session.connector)
  const store = createStreamingTailStore()
  written = ''
  const instance = await render(
    h(
      AppStateProvider as never,
      { initialState: { ...getDefaultAppState(), foregroundTurnActive: true, engineModel: appModel, engineModelForSession: null } },
      h(Box as never, { flexDirection: 'column' }, h(LiveStreamingTail as never, { store }), h(Text as never, {}, MARKER)),
    ),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await settle(250)
  return { frame: painted(), session, unmount: () => instance.unmount?.() }
}

check('the flux probe is armed (the leaf\'s render marks are countable)', probe.fluxProbeEnabled() === true)

section('§1 AppState says Anthropic, the focused session says GPT — no line')
{
  const s = await scene(CLAUDE, GPT)
  check('the quiet stretch of a GPT session paints the marker and no thinking line', s.frame.includes(MARKER) && !s.frame.includes('thinking'), JSON.stringify(s.frame.slice(-120)))
  check('the leaf took no model subscription from the focused session', s.session.listeners() === 0, `listeners=${s.session.listeners()}`)
  s.unmount()
  await settle()
}

section('§2 the mirror: AppState says GPT, the focused session says Anthropic — no line')
{
  const s = await scene(GPT, CLAUDE)
  check('an Anthropic session paints the marker and no thinking line whatever AppState holds', s.frame.includes(MARKER) && !s.frame.includes('thinking'), JSON.stringify(s.frame.slice(-120)))
  s.unmount()
  await settle()
}

section('§3 the feeds: a facts change and a hop drive nothing in the leaf')
{
  const s = await scene(CLAUDE, GPT)
  check('fixture: the GPT session\'s quiet stretch paints the marker alone', framed() && !s.frame.includes('thinking'))
  const before = tailRenders()
  s.session.set(CLAUDE)
  await settle()
  s.session.set(GPT)
  await settle()
  check('the session\'s facts change (GPT → Anthropic → GPT) re-renders the leaf zero times', tailRenders() === before, `render:tail ${tailRenders()} vs ${before}`)
  check('…and paints no line', framed() && !painted().includes('thinking'), JSON.stringify(painted().slice(-120)))
  const other = stubSession(CLAUDE)
  focus.setFocusedSessionConnector(other.connector)
  await settle()
  other.set(GPT)
  await settle()
  check('a hop to another session, and that session\'s own switch to GPT, re-render the leaf zero times', tailRenders() === before, `render:tail ${tailRenders()} vs ${before}`)
  check('…the hopped-to session gained no subscriber from the leaf', other.listeners() === 0, `listeners=${other.listeners()}`)
  check('…and no line paints', framed() && !painted().includes('thinking'), JSON.stringify(painted().slice(-120)))
  s.unmount()
  await settle()
}

section('§4 structural: the leaf holds no model subscription and no route read')
{
  const leaf = code(readFileSync(join(ROOT, 'src/components/LiveStreamingTail.tsx'), 'utf8'))
  check('no AppState model read in the leaf', !leaf.includes('engineModelForSession') && !leaf.includes('engineModel') && !leaf.includes('useAppState'))
  check('no focused-connector model read and no subscription through the focused slot', !leaf.includes('getFocusedSessionConnector') && !leaf.includes('modelFacts') && !leaf.includes('subscribeThroughFocused') && !leaf.includes('subscribeModel'))
  check('no route read and no thinking line', !leaf.includes('declaredRouteOf') && !leaf.includes('ThinkingLabel') && !/\bthinking\b/i.test(leaf))
}

focus._resetFocusedSessionConnectorForTesting()
console.log(failures === 0 ? '\nprove-quiet-line-model-source: ALL LAWS HOLD' : `\nprove-quiet-line-model-source: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
