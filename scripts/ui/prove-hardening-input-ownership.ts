#!/usr/bin/env bun
import React from 'react'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import stripAnsi from 'strip-ansi'

process.env.NODE_ENV = 'test'
process.env.MERCURY_FULLSCREEN = '1'
process.env.MERCURY_REDUCED_MOTION = '1'
process.env.MERCURY_LIVE_GLYPHS = '0'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const ink = await import('../../src/ink.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { TerminalSizeContext } = await import('../../src/ink/components/TerminalSizeContext.js')
const { RowPickModal } = await import('../../src/components/concourse/RowPickModal.js')
const { CommandCenter } = await import('../../src/components/mercury-ui/components.js')
const { useInteractiveList } = await import('../../src/components/mercury-ui/useInteractiveList.js')
const { useFlatList } = await import('../../src/components/mercury-ui/useFlatList.js')
const { caretVerticalOp, clampCaret } = await import('../../src/components/concourse/lineDraft.js')
const { resetOverlayStackForTests } = await import('../../src/context/overlayStack.js')
let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i++) {
    ink.flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}
async function mount(body: React.ReactNode, columns = 80, rows = 18) {
  const emitter = new ink.EventEmitter()
  const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() {}, setEncoding() {}, read() { return null }, unref() {}, ref() {}, pause() {}, resume() {} }) as unknown as NodeJS.ReadStream
  const stream = new PassThrough()
  stream.resume()
  const stdout = Object.assign(stream, { columns, rows }) as unknown as NodeJS.WriteStream
  const context = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
  const node = React.createElement(StdinContext.Provider, { value: context },
    React.createElement(TerminalSizeContext.Provider, { value: { columns, rows } },
      React.createElement(ink.Box, { width: columns, height: rows, flexDirection: 'column' }, body)))
  let painted = (): void => {}
  const first = new Promise<void>(resolve => { painted = resolve })
  const mounted = await ink.render(node, { stdin, stdout, patchConsole: false, exitOnCtrlC: false, onFrame: () => painted() })
  await first
  await settle()
  return {
    frame: () => stripAnsi(mounted.lastFrame()),
    async key(name: string, modifiers: { ctrl?: boolean; meta?: boolean; super?: boolean } = {}): Promise<void> {
      const event = new ink.InputEvent({ name, sequence: name, ctrl: false, shift: false, fn: false, meta: false, option: false, super: false, isPasted: false, ...modifiers } as never)
      emitter.emit('input', event)
      await settle()
    },
    close(): void {
      mounted.unmount()
      mounted.cleanup()
      stream.destroy()
      resetOverlayStackForTests()
    },
  }
}

for (const [count, rows] of [[5, 13], [12, 24]]) {
  let picked = ''
  const options = Array.from({ length: count! }, (_, i) => ({ id: `pick-${i}`, label: `option ${i}` }))
  const scene = await mount(React.createElement(RowPickModal, { cols: 80, rows: rows!, titlePrefix: 'EFFORT', title: 'fixture', legend: 'enter', options, onPick: id => { picked = id }, onClose: () => {} }), 80, rows!)
  try {
    check(`${count} rows: first option begins selected`, scene.frame().includes('▸ option 0'))
    for (let i = 1; i < count!; i++) await scene.key('down')
    check(`${count} rows: last option stays visible and selected`, scene.frame().includes(`▸ option ${count! - 1}`), scene.frame())
    await scene.key('return')
    check(`${count} rows: Enter picks the visible cursor`, picked === `pick-${count! - 1}`)
    for (let i = 1; i < count!; i++) await scene.key('up')
    check(`${count} rows: reverse traversal restores the first option`, scene.frame().includes('▸ option 0'))
  } finally { scene.close() }
}

for (const closeKeys of ['esc', 'esc-arrow', 'none'] as const) {
  let closes = 0
  const scene = await mount(React.createElement(CommandCenter, { view: 'fixture', closeKeys, onClose: () => { closes++ }, children: React.createElement(ink.Text, null, 'body') }))
  try {
    await scene.key('left')
    check(`${closeKeys}: left only closes the advertised arrow mode`, closes === (closeKeys === 'esc-arrow' ? 1 : 0))
    await scene.key('escape')
    check(`${closeKeys}: Escape follows the declared close mode`, closes === (closeKeys === 'none' ? 0 : closeKeys === 'esc-arrow' ? 2 : 1))
  } finally { scene.close() }
}

for (const kind of ['interactive', 'flat'] as const) {
  let fired = 0
  let loads = 0
  function Harness(): React.ReactNode {
    if (kind === 'interactive') {
      const list = useInteractiveList({ rows: ['one', 'two'], rowId: row => row, onClose: () => {}, actions: [{ key: 'x', hint: 'act', run: () => { fired++; return null } }] })
      return React.createElement(ink.Text, null, list.selectedRow)
    }
    const list = useFlatList({ load: async () => { loads++; return ['one', 'two'] }, maxRows: 2, onClose: () => {}, primaryChar: 'x', onPrimary: () => { fired++ } })
    return React.createElement(ink.Text, null, list.selected ?? 'loading')
  }
  const scene = await mount(React.createElement(Harness))
  try {
    for (const modifier of ['ctrl', 'meta', 'super'] as const) {
      await scene.key('x', { [modifier]: true })
      check(`${kind}: ${modifier}+x does not perform plain x`, fired === 0)
      if (kind === 'flat') {
        await scene.key('r', { [modifier]: true })
        check(`${kind}: ${modifier}+r does not reload`, loads === 1)
      }
    }
    await scene.key('n', { ctrl: true })
    check(`${kind}: Emacs ctrl+n still navigates`, scene.frame().includes('two'))
    await scene.key('x')
    check(`${kind}: plain x still acts once`, fired === 1)
  } finally { scene.close() }
}

{
  const { SessionManagerView } = await import('../../src/components/mercury-ui/screens/SessionManagerView.js')
  let closes = 0
  const scene = await mount(React.createElement(SessionManagerView, { onClose: () => { closes++ } }))
  try {
    check('unwired session manager paints its fallback', scene.frame().includes('Session switching needs'))
    await scene.key('escape')
    check('unwired session manager keeps Escape reachable', closes === 1)
  } finally { scene.close() }
}

for (const text of ['a\n😀z', 'a\néz', 'a\n👨‍👩‍👧‍👦z']) {
  const draft = { text, caret: 1 }
  const moved = caretVerticalOp({ upArrow: false, downArrow: true }, draft)!(draft)
  check('vertical caret lands on a grapheme boundary', moved.caret === clampCaret(text, moved.caret), JSON.stringify(moved))
}
console.log(`\ninput ownership: ${failures} failure(s) of ${checks} checks`)
process.exit(failures ? 1 : 0)
