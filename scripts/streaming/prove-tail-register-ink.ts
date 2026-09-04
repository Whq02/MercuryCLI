#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'register-ink-home-'))
process.env.FORCE_COLOR = '3'
process.env.MERCURY_STREAM_CARET = '0'
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
type TailStore = ReturnType<typeof createStreamingTailStore>

const writes: string[] = []
const lastWrite = (): string => writes[writes.length - 1] ?? ''
const stdout = Object.assign(
  new Writable({
    write(chunk: Buffer, _enc, cb) {
      writes.push(chunk.toString())
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
const settle = (ms = 250): Promise<void> => new Promise(r => setTimeout(r, ms))
const h = React.createElement as (...a: unknown[]) => React.ReactElement
const MARKER = 'frame-marker'
const NOTE = 'Reading the sum table before the tool runs on it.'
const WORDS = NOTE.split(' ').slice(0, 4).join(' ')

function Host({ store }: { store: TailStore }): React.ReactElement {
  return h(Box as never, { flexDirection: 'column' }, h(LiveStreamingTail as never, { store }), h(Text as never, {}, MARKER))
}
async function paintBlock(phase: 'commentary' | 'final_answer' | null, text = NOTE): Promise<{ store: TailStore; frame: string; unmount: () => Promise<void> }> {
  const store = createStreamingTailStore()
  const instance = await render(
    h(AppStateProvider as never, { initialState: { ...getDefaultAppState(), foregroundTurnActive: true } }, h(Host as never, { store })),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  )
  await settle()
  store.setPhase(phase)
  store.update(() => text)
  await settle()
  return {
    store,
    frame: lastWrite(),
    unmount: async () => {
      instance.unmount?.()
      await settle()
    },
  }
}
const inkOfRow = (frame: string, needle: string): string => {
  const row = frame.split('\n').find(l => strip(l).includes(needle)) ?? ''
  return (row.match(/\x1b\[[0-9;]*m/g) ?? []).join('')
}

section('§1 the same words, a different ink')
const plain = await paintBlock(null)
check('the unlabelled block painted its words', strip(plain.frame).includes(WORDS), JSON.stringify(strip(plain.frame).slice(-200)))
const plainInk = inkOfRow(plain.frame, WORDS)
plain.store.reset(null)
await settle(300)
check('CONTROL: the unlabelled ghost changes nothing on screen at the clear (the frame at the clear equals the frame before it)', lastWrite() === plain.frame && plain.store.readSettled() === NOTE, `${lastWrite().length} vs ${plain.frame.length} bytes`)
await plain.unmount()

const answer = await paintBlock('final_answer')
check('a final answer paints byte-identically to an unlabelled block (the primary ink)', answer.frame === plain.frame, `${answer.frame.length} vs ${plain.frame.length} bytes`)
await answer.unmount()

const note = await paintBlock('commentary')
check('the working note painted the SAME words', strip(note.frame).includes(WORDS) && strip(note.frame) === strip(plain.frame), JSON.stringify(strip(note.frame).slice(-200)))
const noteInk = inkOfRow(note.frame, WORDS)
check('…in a DIFFERENT ink from the first byte (the frames differ only in their escapes)', note.frame !== plain.frame && noteInk !== plainInk, `${JSON.stringify(noteInk)} vs ${JSON.stringify(plainInk)}`)

section('§2 no flash: the clear that makes the ghost changes nothing on screen')
{
  note.store.reset(null)
  await settle(300)
  check('the ghost stands in the note\'s own ink — the frame at the settle swap is byte-identical to the streaming frame (no flash)', lastWrite() === note.frame && note.store.readSettled() === NOTE && note.store.readPhases().settled === 'commentary', JSON.stringify({ bytes: [lastWrite().length, note.frame.length], phases: note.store.readPhases() }))
}

section('§3 the register is dropped with the ghost')
{
  note.store.setPhase(null)
  note.store.update(() => 'The answer stands on its own.')
  await settle(300)
  const ink = inkOfRow(lastWrite(), 'answer stands')
  check('the next unlabelled text paints in the primary ink again', strip(lastWrite()).includes('answer stands') && note.store.readPhases().current === null && ink === plainInk, `${JSON.stringify(ink)} vs ${JSON.stringify(plainInk)}`)
}
await note.unmount()

console.log(failures === 0 ? '\nprove-tail-register-ink: ALL LAWS HOLD' : `\nprove-tail-register-ink: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
