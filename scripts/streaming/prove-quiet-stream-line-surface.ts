#!/usr/bin/env bun
// ============================================================================
//  scripts/streaming/prove-quiet-stream-line-surface.ts — a GPT turn's quiet
//  stretch paints its one line on EVERY surface: the suppression of the
//  reasoning expander and its replacement line share one gate (FN-016 R12,
//  [Windows] — masked on the win32 inline surface by R2's gate, and on any
//  reduced-motion or WSL-under-WT inline surface).
//
//  THE DEFECT: Message.tsx returns null for a thinking block of an
//  OpenAI-routed served model outside the reveal modes, on the stated
//  grounds that LiveStreamingTail owns the single quiet-stream 'thinking'
//  line. But the REPL mounted the tail only where the reveal was NOT
//  suppressed (streamingTail={streamingSuppressed ? null : focusedTail}),
//  so on a suppressed surface the suppression half ran and the replacement
//  half never mounted: the turn read as an empty gap under the last
//  settled row for the whole reasoning stretch.
//
//  THE LAW: the tail mounts on every surface; the reveal gate suppresses
//  its TEXT half (no prose, no settle ghost, no per-delta re-render of the
//  leaf) and the quiet-stream line paints while the stream is quiet; once
//  text flows unseen on a suppressed surface the line stands down (the
//  verb row is the feedback there — showSpinner carries the suppression
//  term).
//
//   §1 THE DEFECT PIN: the suppressed leaf, quiet GPT stream, turn live —
//      the thinking line paints;
//   §2 text flows: suppressed paints neither prose nor line (the control
//      arm paints the prose);
//   §3 the settle ghost never paints on a suppressed surface (the control
//      arm paints it);
//   §4 the leaf is quiet under deltas: the flux probe counts the leaf's
//      own renders (render:tail) — twenty growth deltas add none on a
//      suppressed surface, and do re-render the open control arm;
//   §5 structural: the three REPL arms mount the focused tail and hand the
//      one gate to the text half; Messages threads it; Message.tsx keeps
//      the pure suppression with the tail as the owner.
//
//  Frames land on a non-TTY stream, which emits a frame only when the
//  output CHANGES, and an EMPTY tree writes nothing — so a leaf that stood
//  down would leave no frame to read. A sibling marker row under the leaf
//  keeps every frame non-empty: a stand-down IS a changed frame (marker
//  present, line gone). Every claim here reads a first frame, a changed
//  frame, the store, or the probe; never a re-render that changed nothing.
//
//  Run: ~/.bun/bin/bun run scripts/streaming/prove-quiet-stream-line-surface.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'quiet-surface-home-'))
// The flux probe counts the leaf's own renders (render:tail marks); the
// gate latches on its first read, so it is armed before any src import.
process.env.MERCURY_FLUX_PROBE = '1'
delete process.env.MERCURY_FLUX_PROBE_TEE
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
// The boot seam: the render reads the global config at ThemeProvider mount
// (the theme setting), which the product allows only once boot has said so.
const { enableConfigs } = await import(join(ROOT, 'src/utils/config/globalConfig.ts'))
enableConfigs()
const { LiveStreamingTail } = await import(join(ROOT, 'src/components/LiveStreamingTail.tsx'))
const focus = await import(join(ROOT, 'src/services/engine-connector/focusedConnector.ts'))
const probe = await import(join(ROOT, 'src/utils/flux/fluxProbe.ts'))
type EngineConnectorV1 = import('../../src/services/engine-connector/types.js').EngineConnectorV1
type TailStore = ReturnType<typeof createStreamingTailStore>

// The focused session: a GPT model (the route the quiet line belongs to).
const gptSession = {
  modelFacts: () => ({ effective: 'gpt-5.2', main: 'gpt-5.2', setting: 'gpt-5.2', sessionPin: null, pendingSwitch: null }),
  subscribeModel: () => () => {},
} as unknown as EngineConnectorV1
focus.setFocusedSessionConnector(gptSession)

// ── a fake terminal: every frame lands in `written` ────────────────────────
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
// The marker row: present in every frame, so a captured frame is evidence.
const MARKER = 'frame-marker'
const framed = (): boolean => painted().includes(MARKER)

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

section('§1 THE DEFECT PIN: the suppressed leaf paints the quiet-stream line')
{
  const store = createStreamingTailStore()
  const m = await mount(store, { textSuppressed: true })
  check('quiet GPT stream, turn live, reveal suppressed — the thinking line paints', framed() && painted().includes('thinking'), JSON.stringify(painted().slice(-120)))
  m.unmount()
  await settle()
  const idle = createStreamingTailStore()
  const m2 = await mount(idle, { textSuppressed: true }, false)
  check('no turn, no line (control — a framed frame without the line)', framed() && !painted().includes('thinking'), JSON.stringify(painted().slice(-120)))
  m2.unmount()
  await settle()
}

section('§2 text flows: the suppressed surface paints neither prose nor line')
{
  const store = createStreamingTailStore()
  const m = await mount(store, { textSuppressed: true })
  check('fixture: the line stands while quiet', framed() && painted().includes('thinking'))
  written = ''
  store.update(() => 'Streamed prose that must stay unseen here')
  await settle(200)
  check('the phase change repainted (a fresh frame carries the marker)', framed(), JSON.stringify(painted().slice(-160)))
  check('no prose on the suppressed surface', !painted().includes('Streamed prose'), JSON.stringify(painted().slice(-160)))
  check('the thinking line stands down while text flows unseen (the verb row is the feedback there)', !painted().includes('thinking'), JSON.stringify(painted().slice(-160)))
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
  store.reset(null) // the clear retires the text into the settled hold
  check('fixture: the hold stands', store.readSettled() === 'The settled reply')
  const m = await mount(store, { textSuppressed: true, settledShown: false })
  check('the ghost is not painted there', framed() && !painted().includes('The settled reply'), JSON.stringify(painted().slice(-160)))
  check('…and the quiet line stands in for the quiet stretch', painted().includes('thinking'), JSON.stringify(painted().slice(-160)))
  m.unmount()
  await settle()
  const control = createStreamingTailStore()
  control.update(() => 'The settled reply')
  control.reset(null)
  const c = await mount(control, { textSuppressed: false, settledShown: false })
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

section('§5 structural: one gate, two halves')
{
  const repl = readFileSync(join(ROOT, 'src/screens/REPL.tsx'), 'utf8')
  check('the three transcript arms mount the focused tail on every surface', (repl.match(/streamingTail=\{focusedTail\}/g) ?? []).length === 3)
  check('the three arms hand the one gate to the text half', (repl.match(/streamingTextSuppressed=\{streamingSuppressed\}/g) ?? []).length === 3)
  check('the REPL no longer un-mounts the tail under suppression', !repl.includes('streamingSuppressed ? null : focusedTail'))
  const messages = readFileSync(join(ROOT, 'src/components/Messages.tsx'), 'utf8')
  check('Messages threads the gate to the leaf', messages.includes('textSuppressed={streamingTextSuppressed}'))
  const message = readFileSync(join(ROOT, 'src/components/Message.tsx'), 'utf8')
  check('Message.tsx keeps the pure suppression with the tail as the owner', message.includes("declaredRouteOf(servedModel) === 'openai'") && message.includes('the LiveStreamingTail owns the'))
  const leaf = readFileSync(join(ROOT, 'src/components/LiveStreamingTail.tsx'), 'utf8')
  check('the suppressed leaf reads the phase, not the text', leaf.includes('textSuppressed ? readPhase : store.getSnapshot'))
}

focus._resetFocusedSessionConnectorForTesting()
console.log(failures === 0 ? '\nprove-quiet-stream-line-surface: ALL LAWS HOLD' : `\nprove-quiet-stream-line-surface: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
