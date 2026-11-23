#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'quiet-surface-home-'))
process.env.MERCURY_FLUX_PROBE = '1'
delete process.env.MERCURY_FLUX_PROBE_TEE
const ROOT = resolve(import.meta.dir, '..', '..')
let failures = 0
const quietSurfaceFixHint = 'change LiveStreamingTail in src/screen/messages/LiveStreamingTail.tsx (its textSuppressed path, the phase snapshot and the settled ghost) so a suppressed surface paints no prose, ghost or thinking line and does not re-render per delta'
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ` — ${detail ? `${detail} — ` : ''}${quietSurfaceFixHint}` : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log(`\n${'─'.repeat(76)}\n${t}`)

const React = (await import('react')).default
const { render, Box, Text } = await import(join(ROOT, 'src/screen/themedRenderer.ts'))
const { AppStateProvider } = await import(join(ROOT, 'src/screen/app-state/AppState.tsx'))
const { getDefaultAppState } = await import(join(ROOT, 'src/screen/app-state/AppStateStore.ts'))
const { createStreamingTailStore } = await import(join(ROOT, 'src/engine/message-shapes/streamingTailStore.ts'))
const { enableConfigs } = await import(join(ROOT, 'src/platform/config/globalConfig.ts'))
enableConfigs()
const { LiveStreamingTail } = await import(join(ROOT, 'src/screen/messages/LiveStreamingTail.tsx'))
const focus = await import(join(ROOT, 'src/engine/connector/focusedConnector.ts'))
const probe = await import(join(ROOT, 'src/integrations/media-flux/fluxProbe.ts'))
type EngineConnectorV1 = import('../../src/engine/connector/types.js').EngineConnectorV1
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


focus._resetFocusedSessionConnectorForTesting()
console.log(failures === 0 ? '\nprove-quiet-stream-line-surface: ALL LAWS HOLD' : `\nprove-quiet-stream-line-surface: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
