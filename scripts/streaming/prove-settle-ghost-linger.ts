#!/usr/bin/env bun
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
const { enableConfigs } = await import(join(ROOT, 'src/utils/config/globalConfig.ts'))
enableConfigs()
const { LiveStreamingTail, SETTLE_LINGER_MS } = await import(join(ROOT, 'src/components/LiveStreamingTail.tsx'))
type TailStore = ReturnType<typeof createStreamingTailStore>

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

const MARKER = 'frame-marker'
const framed = (): boolean => painted().includes(MARKER)
let setShown: ((shown: boolean) => void) | null = null
function Host({ store }: { store: TailStore }): React.ReactElement {
  const [shown, set] = React.useState(false)
  setShown = set
  return h(Box as never, { flexDirection: 'column' }, h(LiveStreamingTail as never, { store, settledShown: shown }), h(Text as never, {}, MARKER))
}

const REPLY = 'The finished single-block reply'
async function mountWithHold(turnActive: boolean, store = createStreamingTailStore()): Promise<{ store: TailStore; unmount: () => void }> {
  if (store.readSettled() === null) {
    store.update(() => REPLY)
    store.reset(null)
  }
  written = ''
  const instance = await render(
    h(AppStateProvider as never, { initialState: { ...getDefaultAppState(), foregroundTurnActive: turnActive } }, h(Host as never, { store })),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await settle(300)
  return { store, unmount: () => instance.unmount?.() }
}

section('§1 THE FIRST DEFECT PIN: the turn is over, the row has not landed — the ghost bridges')
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

section('§3 THE SECOND DEFECT PIN: the turn runs on (a queued next turn) — the ghost still drops at its budget')
{
  const { store, unmount } = await mountWithHold(true)
  check('while the turn runs the ghost paints', painted().includes(REPLY), JSON.stringify(painted().slice(-160)))
  written = ''
  await settle(SETTLE_LINGER_MS + 500)
  check('THE DEFECT PIN: the budget is the ghost\'s own — it drops with the turn still active (no linger keyed to the turn\'s end)', store.readSettled() === null && framed() && !painted().includes(REPLY), JSON.stringify({ hold: store.readSettled(), frame: painted().slice(-160) }))
  unmount()
  await settle()
  const again = await mountWithHold(true)
  written = ''
  setShown!(true)
  await settle(300)
  check('the row landing mid-turn releases the ghost at once and drops the hold', framed() && !painted().includes(REPLY) && again.store.readSettled() === null, JSON.stringify(painted().slice(-160)))
  again.unmount()
  await settle()
}

section('§4 the age is the ghost\'s own: a hold made before the mount expires by its clear\'s clock')
{
  const store = createStreamingTailStore()
  store.update(() => REPLY)
  store.reset(null)
  const since = store.readSettledSinceMs()
  check('the store stamps the clear (the ghost\'s birth) on its own clock', typeof since === 'number' && since > 0, String(since))
  const head = Math.round(SETTLE_LINGER_MS * 0.75)
  await settle(head)
  const { unmount } = await mountWithHold(true, store)
  check('mounted three quarters of the budget after the clear, the ghost still paints', painted().includes(REPLY), JSON.stringify(painted().slice(-160)))
  written = ''
  await settle(SETTLE_LINGER_MS - head + 400)
  check('…and drops when ITS OWN budget runs out — well before a full budget from the mount', store.readSettled() === null && framed() && !painted().includes(REPLY), JSON.stringify({ hold: store.readSettled(), frame: painted().slice(-160) }))
  unmount()
  await settle()
  store.update(() => 'next text')
  check('the next text drops the stamp with the hold', store.readSettledSinceMs() === null && store.readSettled() === null)
}

section('§5 structural: the budget is the exported constant, bounded; the leaf keys nothing on the turn')
{
  check('SETTLE_LINGER_MS is exported and bounded (≤ 3 s)', typeof SETTLE_LINGER_MS === 'number' && SETTLE_LINGER_MS > 0 && SETTLE_LINGER_MS <= 3000, String(SETTLE_LINGER_MS))
  const leaf = readFileSync(join(ROOT, 'src/components/LiveStreamingTail.tsx'), 'utf8')
  check('the ghost stands until its row lands or its own linger expires — never on the turn', leaf.includes('const ghost = settled !== null && !settledShown && !lingerExpired'))
  check('the linger is armed from the clear\'s stamp (readSettledSinceMs), the remaining budget only', /readSettledSinceMs\(\)/.test(leaf) && /SETTLE_LINGER_MS - age/.test(leaf))
  check('the hold drops on the row landing, or on the expired linger', leaf.includes('if (settled !== null && (settledShown || lingerExpired)) store.dropSettled()'))
}

console.log(failures === 0 ? '\nprove-settle-ghost-linger: ALL LAWS HOLD' : `\nprove-settle-ghost-linger: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
