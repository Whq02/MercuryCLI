#!/usr/bin/env bun
// ============================================================================
//  scripts/streaming/prove-settle-ghost-linger.ts — the settle ghost bridges
//  the last block of a turn: released on its row landing, with a bounded
//  linger past the turn's end as the backstop (FN-016 R24).
//
//  THE DEFECT: LiveStreamingTail computed the ghost as
//  `settled !== null && !settledShown && turnActive` and dropped the hold
//  the moment the turn ended, whether or not the row had landed. A plain
//  single-block reply streams one text block, the block's clear retires
//  the text into the settled hold, and the turn goes idle in the same
//  moment — so the finished reply dropped off the screen for a beat after
//  the model stopped, then reappeared with its nameplate and timestamp
//  when the transcript feed caught up (a 400 ms heartbeat, then a re-read
//  and re-parse of the whole session log — longer on a slow disk with a
//  long transcript).
//
//  THE LAW: the ghost releases on the row landing (settledShown, the one
//  release law); past the turn's falling edge it LINGERS for at most
//  SETTLE_LINGER_MS, then drops — a settle whose row never matches cannot
//  stand indefinitely.
//
//   §1 THE DEFECT PIN: the turn is already over and the row has not
//      landed — the ghost paints and the hold stands; the row landing
//      releases it and drops the hold;
//   §2 the backstop: no row ever lands — past the budget the hold is
//      dropped and the ghost gone;
//   §3 the controls: during the turn the ghost paints as before and the
//      budget is not armed; the row landing mid-turn releases it;
//   §4 structural: the budget is the exported constant, bounded.
//
//  Frames land on a non-TTY stream, which emits a frame only when the
//  output CHANGES — so every "still paints" claim here is read off a
//  FIRST frame (the mount) or the store's hold, never off a re-render
//  that changed nothing.
//
//  Run: ~/.bun/bin/bun run scripts/streaming/prove-settle-ghost-linger.ts
// ============================================================================
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'ghost-linger-home-'))
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
const { LiveStreamingTail, SETTLE_LINGER_MS } = await import(join(ROOT, 'src/components/LiveStreamingTail.tsx'))
type TailStore = ReturnType<typeof createStreamingTailStore>

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
const settle = (ms = 150): Promise<void> => new Promise(r => setTimeout(r, ms))
const painted = (): string => strip(written)
const h = React.createElement as (...a: unknown[]) => React.ReactElement

// The host owns the row-landing knob Messages owns in the product
// (settledShown, computeTailRelease's verdict); the turn is the mount's
// AppState (REPL's foregroundTurnActive).
// A sibling marker row keeps every frame non-empty (an EMPTY tree writes
// nothing on a non-TTY stream): a released ghost IS a changed frame —
// marker present, reply gone.
const MARKER = 'frame-marker'
const framed = (): boolean => painted().includes(MARKER)
let setShown: ((shown: boolean) => void) | null = null
function Host({ store }: { store: TailStore }): React.ReactElement {
  const [shown, set] = React.useState(false)
  setShown = set
  return h(Box as never, { flexDirection: 'column' }, h(LiveStreamingTail as never, { store, settledShown: shown }), h(Text as never, {}, MARKER))
}

const REPLY = 'The finished single-block reply'
async function mountWithHold(turnActive: boolean): Promise<{ store: TailStore; unmount: () => void }> {
  const store = createStreamingTailStore()
  store.update(() => REPLY)
  store.reset(null) // the block's clear retires the text into the settled hold
  written = ''
  const instance = await render(
    h(AppStateProvider as never, { initialState: { ...getDefaultAppState(), foregroundTurnActive: turnActive } }, h(Host as never, { store })),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await settle(300)
  return { store, unmount: () => instance.unmount?.() }
}

section('§1 THE DEFECT PIN: the turn is over, the row has not landed — the ghost bridges')
{
  const { store, unmount } = await mountWithHold(false)
  check('THE DEFECT PIN: with the turn already idle and no row landed, the ghost paints', painted().includes(REPLY), JSON.stringify(painted().slice(-160)))
  check('…and the hold stands (not dropped on the turn\'s end alone)', store.readSettled() === REPLY)
  written = ''
  setShown!(true)
  await settle(300)
  check('the row landing releases the ghost (a fresh frame: marker present, the reply gone)', framed() && !painted().includes(REPLY), JSON.stringify(painted().slice(-160)))
  check('…and drops the hold', store.readSettled() === null)
  unmount()
  await settle()
}

section('§2 the backstop: no row ever lands — the hold drops past the budget')
{
  const { store, unmount } = await mountWithHold(false)
  check('fixture: the ghost bridges past the turn\'s end', painted().includes(REPLY) && store.readSettled() === REPLY)
  written = ''
  await settle(SETTLE_LINGER_MS + 500)
  check('past SETTLE_LINGER_MS the hold is dropped (a settle whose row never matched does not stand indefinitely)', store.readSettled() === null)
  check('…and the ghost is gone from the frame that followed (marker present, reply gone)', framed() && !painted().includes(REPLY), JSON.stringify(painted().slice(-160)))
  unmount()
  await settle()
}

section('§3 the controls: the in-turn law is unchanged')
{
  const { store, unmount } = await mountWithHold(true)
  check('while the turn runs the ghost paints as before', painted().includes(REPLY), JSON.stringify(painted().slice(-160)))
  await settle(SETTLE_LINGER_MS + 500)
  check('the budget is not armed during the turn: the hold outlives it', store.readSettled() === REPLY)
  written = ''
  setShown!(true)
  await settle(300)
  check('the row landing mid-turn releases the ghost and drops the hold', framed() && !painted().includes(REPLY) && store.readSettled() === null, JSON.stringify(painted().slice(-160)))
  unmount()
  await settle()
}

section('§4 structural: the budget is the exported constant, bounded')
{
  check('SETTLE_LINGER_MS is exported and bounded (≤ 3 s)', typeof SETTLE_LINGER_MS === 'number' && SETTLE_LINGER_MS > 0 && SETTLE_LINGER_MS <= 3000, String(SETTLE_LINGER_MS))
  const leaf = readFileSync(join(ROOT, 'src/components/LiveStreamingTail.tsx'), 'utf8')
  check('the ghost lingers past the turn\'s end until the budget runs out', leaf.includes('const ghost = settled !== null && !settledShown && (turnActive || !lingerExpired)'))
  check('the hold drops on the row landing, or on the expired linger past the turn', leaf.includes('if (settled !== null && (settledShown || (!turnActive && lingerExpired))) store.dropSettled()'))
}

console.log(failures === 0 ? '\nprove-settle-ghost-linger: ALL LAWS HOLD' : `\nprove-settle-ghost-linger: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
