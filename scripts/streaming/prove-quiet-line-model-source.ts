#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'quiet-line-home-'))
const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

const React = (await import('react')).default
const { render, Box, Text } = await import(join(ROOT, 'src/ink.ts'))
const { AppStateProvider } = await import(join(ROOT, 'src/state/AppState.tsx'))
const { getDefaultAppState } = await import(join(ROOT, 'src/state/AppStateStore.ts'))
const { createStreamingTailStore } = await import(join(ROOT, 'src/utils/messages/streamingTailStore.ts'))
const { enableConfigs } = await import(join(ROOT, 'src/utils/config/globalConfig.ts'))
enableConfigs()
const { LiveStreamingTail } = await import(join(ROOT, 'src/components/LiveStreamingTail.tsx'))
const focus = await import(join(ROOT, 'src/services/engine-connector/focusedConnector.ts'))
type EngineConnectorV1 = import('../../src/services/engine-connector/types.js').EngineConnectorV1

function stubSession(effective: string): { connector: EngineConnectorV1; set: (next: string) => void } {
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
      { initialState: { ...getDefaultAppState(), foregroundTurnActive: true, mainLoopModel: appModel, mainLoopModelForSession: null } },
      h(Box as never, { flexDirection: 'column' }, h(LiveStreamingTail as never, { store }), h(Text as never, {}, MARKER)),
    ),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await settle(250)
  return { frame: painted(), session, unmount: () => instance.unmount?.() }
}

section('§1 THE DEFECT PIN: AppState says Anthropic, the focused session says GPT — the quiet line paints')
{
  const s = await scene(CLAUDE, GPT)
  check('the quiet stretch of the GPT session shows the one grey thinking line', s.frame.includes('thinking'), JSON.stringify(s.frame.slice(-120)))
  s.unmount()
  await settle()
}

section('§2 the mirror: AppState says GPT (the picker\'s local patch), the focused session says Anthropic — no line')
{
  const s = await scene(GPT, CLAUDE)
  check('an Anthropic session paints no thinking line whatever AppState holds', s.frame.includes(MARKER) && !s.frame.includes('thinking'), JSON.stringify(s.frame.slice(-120)))
  s.unmount()
  await settle()
}

section('§3 the feeds: the session\'s own facts and the focused slot drive the line')
{
  const s = await scene(CLAUDE, GPT)
  check('fixture: the GPT session\'s line stands', s.frame.includes('thinking'))
  written = ''
  s.session.set(CLAUDE)
  await settle()
  check('the session\'s facts change (a settled switch to Anthropic) repaints the line OFF (a fresh frame: marker present, line gone)', framed() && !painted().includes('thinking'), JSON.stringify(painted().slice(-120)))
  written = ''
  s.session.set(GPT)
  await settle()
  check('…and back on when the facts say GPT again', painted().includes('thinking'), JSON.stringify(painted().slice(-120)))
  const other = stubSession(CLAUDE)
  written = ''
  focus.setFocusedSessionConnector(other.connector)
  await settle()
  check('a hop to an Anthropic session stands the line down (the slot re-point is heard; a fresh frame without the line)', framed() && !painted().includes('thinking'), JSON.stringify(painted().slice(-120)))
  written = ''
  other.set(GPT)
  await settle()
  check('the hopped-to session\'s own facts now drive it (its switch to GPT paints the line)', painted().includes('thinking'), JSON.stringify(painted().slice(-120)))
  s.unmount()
  await settle()
}

section('§4 structural: the leaf reads the focused connector\'s effective model, never AppState\'s')
{
  const leaf = readFileSync(join(ROOT, 'src/components/LiveStreamingTail.tsx'), 'utf8')
  check('no AppState model read remains in the leaf', !leaf.includes('s.mainLoopModelForSession ?? s.mainLoopModel'))
  check('the leaf rides the focused connector\'s effective model', leaf.includes("getFocusedSessionConnector().modelFacts().effective"))
  check('…through the focused slot (a hop re-points it)', leaf.includes('subscribeThroughFocused((connector, listener) =>') && leaf.includes('connector.subscribeModel(listener)'))
}

focus._resetFocusedSessionConnectorForTesting()
console.log(failures === 0 ? '\nprove-quiet-line-model-source: ALL LAWS HOLD' : `\nprove-quiet-line-model-source: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
