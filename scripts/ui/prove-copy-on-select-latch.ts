#!/usr/bin/env bun
import { mock } from 'bun:test'
import { EventEmitter as NodeEventEmitter } from 'node:events'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React, { useState } from 'react'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.MERCURY_CONFIG_DIR = realpathSync(mkdtempSync(join(tmpdir(), 'copy-latch-home-')))
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.ANTHROPIC_API_KEY = 'proof-key-ci-gate-not-a-real-key'
process.env.NODE_ENV = 'test'

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const j = (v: unknown): string => JSON.stringify(v)

const world = { fullscreen: true, enabled: true }
const fullscreen = await import('../../src/utils/fullscreen.ts')
mock.module('../../src/utils/fullscreen.js', () => ({ ...fullscreen, isFullscreenActive: () => world.fullscreen }))
const config = await import('../../src/utils/config.ts')
mock.module('../../src/utils/config.js', () => ({ ...config, isCopyOnSelectEnabled: () => world.enabled }))
const { useCopyOnSelect } = await import('../../src/hooks/useCopyOnSelect.js')
const { noteOwnInputSelectionSettled, registerInputSelectionOwner } = await import('../../src/utils/cockpit/inputSelectionBridge.js')
const { default: StdinContext } = await import('../../src/ink/components/StdinContext.js')
const { Box, EventEmitter, render, flushPendingSyncWork } = await import('../../src/ink.js')

const clipboard: string[] = []
const toasts: string[] = []
const listeners = new Set<() => void>()
let state: { isDragging: boolean } | null = null
let selectedText = ''
const selection = {
  copySelection: () => selectedText,
  copySelectionNoClear: () => { clipboard.push(`drag:${selectedText}`); return selectedText },
  copyText: (text: string) => { clipboard.push(`own:${text}`) },
  clearSelection() {},
  hasSelection: () => selectedText !== '' || state?.isDragging === true,
  getState: () => state,
  subscribe: (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback) } },
  moveFocus() {},
  setSelectionBgColor() {},
}
const changed = (): void => { for (const listener of [...listeners]) listener() }
const drag = (text: string): void => { state = { isDragging: true }; selectedText = text; changed() }
const release = (): void => { state = { isDragging: false }; changed() }
const clear = (): void => { state = null; selectedText = ''; changed() }

let setActive: ((value: boolean) => void) | null = null
let setToast: ((value: (text: string) => void) => void) | null = null
function Probe(): React.ReactNode {
  const [isActive, setIsActive] = useState(true)
  const [onCopied, setOnCopied] = useState<(text: string) => void>(() => (text: string) => { toasts.push(text) })
  setActive = setIsActive
  setToast = next => setOnCopied(() => next)
  useCopyOnSelect(selection as never, isActive, onCopied)
  return null
}
const settle = async (): Promise<void> => {
  for (let index = 0; index < 4; index++) {
    flushPendingSyncWork()
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
}
const emitter = new EventEmitter()
const stdin = Object.assign(new NodeEventEmitter(), { isTTY: true, isRaw: false, setRawMode() { return this }, setEncoding() { return this }, read() { return null }, unref() { return this }, ref() { return this }, pause() { return this }, resume() { return this } }) as unknown as NodeJS.ReadStream
const stream = new PassThrough()
stream.resume()
const stdout = Object.assign(stream, { columns: 80, rows: 24 }) as unknown as NodeJS.WriteStream
const stdinValue = { stdin, setRawMode() {}, isRawModeSupported: true, internal_exitOnCtrlC: false, internal_eventEmitter: emitter, internal_querier: null }
const instance = await render(React.createElement(StdinContext.Provider, { value: stdinValue as never }, React.createElement(Box, null, React.createElement(Probe))), { stdin, stdout, patchConsole: false, exitOnCtrlC: false })
await settle()
const taken = (list: string[]): string[] => list.splice(0, list.length)

section('§1 ONE COPY PER SETTLED DRAG — the drag itself copies nothing; the release copies once; the highlight stays')
check('the hook subscribed to the screen selection', listeners.size === 1)
drag('hello world')
check('a drag in progress copies nothing', clipboard.length === 0 && toasts.length === 0)
release()
check('the release copies without clearing and announces the text', j(taken(clipboard)) === j(['drag:hello world']) && j(taken(toasts)) === j(['hello world']))
changed()
check('a further change on the same settled selection copies nothing more (the latch)', clipboard.length === 0 && toasts.length === 0)
drag('hello world')
release()
check('a new drag ending on the same range copies again (the drag re-armed the latch)', j(taken(clipboard)) === j(['drag:hello world']) && j(taken(toasts)) === j(['hello world']))
clear()
check('clearing copies nothing and re-arms', clipboard.length === 0)
drag('   ')
release()
check('a whitespace-only selection is copied but not announced', j(taken(clipboard)) === j(['drag:   ']) && toasts.length === 0)
changed()
check('and its latch holds', clipboard.length === 0)

section('§2 THE OPT-OUT — read at event time')
clear()
world.enabled = false
drag('quiet')
release()
check('with copy-on-select off a release copies nothing', clipboard.length === 0 && toasts.length === 0)
world.enabled = true
changed()
check('turning it on mid-selection copies on the next change (the latch was never set)', j(taken(clipboard)) === j(['drag:quiet']) && j(taken(toasts)) === j(['quiet']))

section('§3 THE OWN-INPUT ROAD — a settled composer selection copies through copyText')
const unregister = registerInputSelectionOwner({ range: () => null, own: () => ({ start: 0, end: 4, text: 'draft' } as never), clear() {} })
noteOwnInputSelectionSettled()
check('a settled own selection copies its text and announces it', j(taken(clipboard)) === j(['own:draft']) && j(taken(toasts)) === j(['draft']))
world.enabled = false
noteOwnInputSelectionSettled()
check('the opt-out silences the own road too', clipboard.length === 0)
world.enabled = true
unregister()
noteOwnInputSelectionSettled()
check('without an own selection nothing copies', clipboard.length === 0)

section('§4 THE CALLBACK RIDES A REF — swapping it keeps the subscription and the latch')
const before = [...listeners][0]
const late: string[] = []
setToast?.(text => { late.push(text) })
await settle()
check('the screen subscription was not re-established', listeners.size === 1 && [...listeners][0] === before)
clear()
drag('again')
release()
check('the new callback hears the copy', j(taken(late)) === j(['again']) && toasts.length === 0 && j(taken(clipboard)) === j(['drag:again']))

section('§5 ARMING — inactive or outside the alternate screen, nothing is subscribed')
setActive?.(false)
await settle()
check('an inactive handler unsubscribes', listeners.size === 0)
setActive?.(true)
await settle()
check('an active handler subscribes again', listeners.size === 1)
world.fullscreen = false
setActive?.(false)
await settle()
setActive?.(true)
await settle()
check('outside the alternate screen the active handler subscribes nothing', listeners.size === 0)
world.fullscreen = true

instance.unmount()
instance.cleanup()
stream.destroy()
console.log(failures === 0 ? '\nPASS copy on select latch' : `\nFAIL ${failures} check(s)`)
process.exit(failures === 0 ? 0 : 1)
