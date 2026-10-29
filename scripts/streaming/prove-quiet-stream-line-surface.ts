#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'quiet-surface-home-'))

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
type TailStore = ReturnType<typeof createStreamingTailStore>

const gptSession = {
  modelFacts: () => ({ effective: 'gpt-5.2', main: 'gpt-5.2', setting: 'gpt-5.2', sessionPin: null, pendingSwitch: null }),
  subscribeModel: () => () => {},
} as unknown as EngineConnectorV1
focus.setFocusedSessionConnector(gptSession)

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

const MARKER = 'frame-marker'
const framed = (): boolean => painted().includes(MARKER)
const PROSE = 'Streamed prose that must stay unseen here'

async function mount(store: TailStore, props: Record<string, unknown>, turnActive = true): Promise<{ unmount: () => void }> {
  written = ''
  const instance = await render(
    h(
      AppStateProvider as never,
      { initialState: { ...getDefaultAppState(), foregroundTurnActive: turnActive } },
      h(Box as never, { flexDirection: 'column' }, h(LiveStreamingTail as never, { store, ...props }), h(Text as never, {}, MARKER)),
    ),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await settle(250)
  return { unmount: () => instance.unmount?.() }
}

check('the flux probe is armed (the leaf\'s render marks are countable)', probe.fluxProbeEnabled() === true)

section('§1 THE PIN: the leaf paints nothing while the stream is quiet')
{
  const store = createStreamingTailStore()
  const m = await mount(store, { textSuppressed: true })
  check('quiet GPT stream, turn live, reveal suppressed — the frame carries the marker and no thinking line', framed() && !painted().includes('thinking'), JSON.stringify(painted().slice(-120)))
  m.unmount()
  await settle()
  const idle = createStreamingTailStore()
  const m2 = await mount(idle, { textSuppressed: true }, false)
  check('no turn — the same nothing (the turn\'s liveness is no reader of the leaf)', framed() && !painted().includes('thinking'), JSON.stringify(painted().slice(-120)))
  m2.unmount()
  await settle()
  const open = createStreamingTailStore()
  const m3 = await mount(open, { textSuppressed: false })
  check('the open surface, quiet GPT stream, turn live — the same nothing', framed() && !painted().includes('thinking'), JSON.stringify(painted().slice(-120)))
  m3.unmount()
  await settle()
}

section('§2 text flows: the suppressed surface paints neither prose nor line')
{
  const store = createStreamingTailStore()
  const m = await mount(store, { textSuppressed: true })
  check('fixture: the marker alone while quiet', framed() && !painted().includes('thinking'))
  store.update(() => PROSE)
  await settle(200)
  check('the store holds the prose (the stream flowed)', store.read() === PROSE)
  check('no prose on the suppressed surface', framed() && !painted().includes('Streamed prose'), JSON.stringify(painted().slice(-160)))
  check('no thinking line over the flowing prose either', !painted().includes('thinking'), JSON.stringify(painted().slice(-160)))
  m.unmount()
  await settle()
  const control = createStreamingTailStore()
  const c = await mount(control, { textSuppressed: false })
  written = ''
  control.update(() => 'Streamed prose that paints on an open surface')
  await settle(200)
  check('CONTROL: the open surface paints the prose', painted().includes('Streamed prose that paints'), JSON.stringify(painted().slice(-160)))
  c.unmount()
  await settle()
}

section('§3 the settle ghost never paints on a suppressed surface')
{
  const store = createStreamingTailStore()
  store.update(() => 'The settled reply')
  store.reset(null)
  check('fixture: the hold stands', store.readSettled() === 'The settled reply')
  const m = await mount(store, { textSuppressed: true })
  check('the ghost is not painted there', framed() && !painted().includes('The settled reply'), JSON.stringify(painted().slice(-160)))
  check('…and no line stands in for the quiet stretch', !painted().includes('thinking'), JSON.stringify(painted().slice(-160)))
  m.unmount()
  await settle()
  const control = createStreamingTailStore()
  control.update(() => 'The settled reply')
  control.reset(null)
  const c = await mount(control, { textSuppressed: false })
  check('CONTROL: the open surface paints the ghost in place', painted().includes('The settled reply'), JSON.stringify(painted().slice(-160)))
  c.unmount()
  await settle()
}

section('§4 the suppressed leaf is quiet under deltas (the probe counts the leaf\'s own renders)')
{
  const store = createStreamingTailStore()
  const m = await mount(store, { textSuppressed: true })
  store.update(() => 'a')
  await settle(120)
  const afterFirst = tailRenders()
  for (let i = 0; i < 20; i++) {
    store.update(cur => `${cur ?? ''}b`)
    await settle(40)
  }
  check('twenty growth deltas re-render the suppressed leaf zero times (the phase snapshot is constant while text flows)', tailRenders() === afterFirst, `render:tail ${tailRenders()} vs ${afterFirst} after the first text`)
  m.unmount()
  await settle()
  const control = createStreamingTailStore()
  const c = await mount(control, { textSuppressed: false })
  control.update(() => 'a')
  await settle(120)
  const openAfterFirst = tailRenders()
  for (let i = 0; i < 20; i++) {
    control.update(cur => `${cur ?? ''}b`)
    await settle(40)
  }
  check('CONTROL: the open surface re-renders the leaf under the same deltas (the probe sees them)', tailRenders() > openAfterFirst, `render:tail ${tailRenders()} vs ${openAfterFirst}`)
  c.unmount()
  await settle()
}

section('§5 structural: one gate, one owner of the row')
{
  const repl = readFileSync(join(ROOT, 'src/screens/Chat.tsx'), 'utf8')
  check('the three transcript arms mount the focused tail on every surface', (repl.match(/streamingTail=\{focusedTail\}/g) ?? []).length === 3)
  check('the three arms hand the one gate to the text half', (repl.match(/streamingTextSuppressed=\{streamingSuppressed\}/g) ?? []).length === 3)
  check('the Chat no longer un-mounts the tail under suppression', !repl.includes('streamingSuppressed ? null : focusedTail'))
  const messages = readFileSync(join(ROOT, 'src/components/Messages.tsx'), 'utf8')
  check('Messages threads the gate to the leaf', messages.includes('textSuppressed={streamingTextSuppressed}'))
  const message = readFileSync(join(ROOT, 'src/components/Message.tsx'), 'utf8')
  const thinkingStart = message.indexOf('case "thinking":')
  const thinkingCase = code(message.slice(thinkingStart, message.indexOf('default:', thinkingStart)))
  check('Message.tsx: the thinking case returns null nowhere and reads no route (the row paints on every provider)', thinkingStart >= 0 && thinkingCase.includes('<AssistantThinkingMessage') && !thinkingCase.includes('return null') && !thinkingCase.includes('declaredRouteOf'))
  check('Message.tsx: imports no route reader', !code(message).includes('declaredRouteOf'))
  const leaf = readFileSync(join(ROOT, 'src/components/LiveStreamingTail.tsx'), 'utf8')
  check('the suppressed leaf reads the phase, not the text', leaf.includes('textSuppressed ? readPhase : store.getSnapshot'))
  const leafCode = code(leaf)
  check('the tail reads no model: no focused-connector subscription, no model facts, no route read, no turn read', !leafCode.includes('subscribeThroughFocused') && !leafCode.includes('getFocusedSessionConnector') && !leafCode.includes('modelFacts') && !leafCode.includes('declaredRouteOf') && !leafCode.includes('useAppState'))
  check('the tail draws no thinking line (no grammar import, no label, no thinking word)', !leafCode.includes('thinkingGrammar') && !leafCode.includes('ThinkingLabel') && !/\bthinking\b/i.test(leafCode))
}

focus._resetFocusedSessionConnectorForTesting()
console.log(failures === 0 ? '\nprove-quiet-stream-line-surface: ALL LAWS HOLD' : `\nprove-quiet-stream-line-surface: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
