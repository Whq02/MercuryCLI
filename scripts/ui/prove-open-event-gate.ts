#!/usr/bin/env bun
process.env.NODE_ENV = 'test'

import { Readable, Writable } from 'node:stream'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const React = await import('react')
const { render, Box, Text } = await import('../../src/ink.js')
const { default: useInput } = await import('../../src/ink/hooks/use-input.js')
const { MercuryCommandPalette } = await import('../../src/components/MercuryCommandPalette.js')
const { currentInputEventSeq } = await import('../../src/ink/events/input-event.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')

let written = ''
const stdout = Object.assign(
  new Writable({
    write(chunk: Buffer, _enc, cb) {
      written += chunk.toString()
      cb()
    },
  }),
  { columns: 100, rows: 32, isTTY: false },
) as unknown as NodeJS.WriteStream

const stdin = Object.assign(new Readable({ read() {} }), {
  isTTY: true,
  setRawMode() {},
  ref() {},
  unref() {},
}) as unknown as NodeJS.ReadStream

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
const settle = () => new Promise(r => setTimeout(r, 30))
const press = async (bytes: string) => {
  ;(stdin as unknown as Readable).push(bytes)
  await settle()
}

const runs: string[] = []
let closedAt = 0
const h = React.createElement as (...a: unknown[]) => React.ReactElement
const FAKE_COMMANDS = [
  { type: 'local', name: 'quokka', description: 'the q command', isEnabled: () => true, isHidden: false },
  { type: 'local', name: 'help', description: 'help', isEnabled: () => true, isHidden: false },
] as never[]

function Host(): React.ReactNode {
  const [open, setOpen] = React.useState(false)
  useInput(
    input => {
      if (input === 'P' && !open) setOpen(true)
    },
    { isActive: !open },
  )
  if (!open) return h(Text as never, {}, 'palette-closed')
  return h(MercuryCommandPalette as never, {
    commands: FAKE_COMMANDS,
    onRun: (t: string) => runs.push(t),
    onClose: () => {
      closedAt = currentInputEventSeq()
      setOpen(false)
    },
  })
}

console.log('prove-open-event-gate — live first-key behavior')
const instance = await render(h(AppStateProvider as never, {}, h(Host as never, {})), {
  stdout,
  stdin,
  exitOnCtrlC: false,
  patchConsole: false,
})

await settle()
const seqBefore = currentInputEventSeq()

written = ''
await press('P')
check('opener event dispatched (seq advanced)', currentInputEventSeq() > seqBefore)
check('palette opened on P', strip(written).includes('run a command'), 'placeholder visible')
check("opener key did NOT leak into the query (no 'P' echo row)", !strip(written).includes('▸ P'))

written = ''
await press('q')
const frame2 = strip(written)
check("fast first printable landed in the query ('q' filters to quokka)", frame2.includes('quokka'))
check('placeholder replaced (query non-empty)', !frame2.includes('run a command'))
check('it landed exactly once (query row shows single q)', !frame2.includes('qq'))

written = ''
;(stdin as unknown as Readable).push('\x1b')
await new Promise(r => setTimeout(r, 300))
check('esc closed the palette (no gate in the way)', strip(written).includes('palette-closed'))
check('close observed the esc event itself (no extra wall-clock wait)', closedAt === currentInputEventSeq())

const { currentInputEventSeq: seqFn } = await import('../../src/ink/events/input-event.js')
const a = seqFn()
await press('x')
check('every stdin event bumps the seq exactly once', seqFn() === a + 1, `${a} → ${seqFn()}`)

instance.unmount?.()
console.log(failures === 0 ? '\n✓ prove-open-event-gate: all green' : `\n✗ prove-open-event-gate: ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
