#!/usr/bin/env bun
import { EventEmitter } from 'node:events'

for (const name of ['WT_SESSION', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'KITTY_WINDOW_ID', 'ZED_TERM', 'VTE_VERSION', 'TMUX', 'MERCURY_FORCE_SYNC_OUTPUT', 'MERCURY_NO_SYNC_OUTPUT']) delete process.env[name]
process.env.TERM = 'xterm-256color'

const React = await import('react')
const h = React.createElement
const { default: Ink } = await import('../../src/ink/ink.tsx')
const { default: instances } = await import('../../src/ink/instances.ts')
const { Box, Text } = await import('../../src/ink.ts')
const { AlternateScreen } = await import('../../src/ink/components/AlternateScreen.tsx')
const { syncOutputCapabilityNow, upgradeSyncOutputSupport } = await import('../../src/ink/session/capabilities.ts')

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

const ENTER_ALT = '\u001b[?1049h'

class ConsoleHost extends EventEmitter {
  isTTY = true
  window = { cols: 117, rows: 34 }
  bufferCols = 117
  columns = 117
  rows = 34
  entered = 0
  constructor(private readonly bufferFollowsWindow: boolean) {
    super()
  }
  write(bytes: string): boolean {
    for (let at = bytes.indexOf(ENTER_ALT); at >= 0; at = bytes.indexOf(ENTER_ALT, at + 1)) {
      this.entered++
      this.bufferCols = this.window.cols
    }
    return true
  }
  getWindowSize(): [number, number] {
    return [this.bufferCols, this.window.rows]
  }
  _refreshSize(): void {
    const [columns, rows] = this.getWindowSize()
    if (columns === this.columns && rows === this.rows) return
    this.columns = columns
    this.rows = rows
    this.emit('resize')
  }
  windowBecomes(cols: number, rows: number): void {
    this.window = { cols, rows }
    this.bufferCols = this.bufferFollowsWindow ? cols : Math.max(this.bufferCols, cols)
  }
  userResizes(cols: number, rows: number): void {
    this.windowBecomes(cols, rows)
    this._refreshSize()
  }
}

class Keys extends EventEmitter {
  isTTY = true
  isRaw = false
  readableLength = 0
  setEncoding(): this {
    return this
  }
  setRawMode(raw: boolean): this {
    this.isRaw = raw
    return this
  }
  ref(): this {
    return this
  }
  unref(): this {
    return this
  }
  pause(): this {
    return this
  }
  resume(): this {
    return this
  }
  read(): string | null {
    return null
  }
}

const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const widest = (frame: string): number => Math.max(0, ...frame.split('\n').map(row => row.replace(/\u001b\[[0-9;]*m/g, '').trimEnd().length))

type Walk = { maximized: number; restored: number; enteredAtMaximize: number; enteredAtRestore: number }
type Road = 'the resize event' | 'a render'

async function maximizeThenRestore(platform: NodeJS.Platform, bufferFollowsWindow: boolean, road: Road = 'the resize event'): Promise<Walk> {
  const host = new ConsoleHost(bufferFollowsWindow)
  const ink = new Ink({ stdout: host as never, stdin: new Keys() as never, stderr: new ConsoleHost(true) as never, patchConsole: false, exitOnCtrlC: false })
  instances.set(host as never, ink)
  const scene = (label: string): React.ReactNode => h(AlternateScreen, { mouseTracking: false }, h(Box, { flexDirection: 'column', width: '100%' }, h(Text, { wrap: 'truncate-end' }, '═'.repeat(400)), h(Text, null, label)))
  const becomes = (cols: number, rows: number, label: string): void => {
    if (road === 'the resize event') return host.userResizes(cols, rows)
    host.windowBecomes(cols, rows)
    ink.render(scene(label))
  }
  ink.render(scene('a row'))
  await settle(250)
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  const walk: Walk = { maximized: 0, restored: 0, enteredAtMaximize: 0, enteredAtRestore: 0 }
  try {
    const atRest = host.entered
    becomes(213, 50, 'a row, maximized')
    await settle(500)
    walk.maximized = widest(ink.lastFrameText())
    walk.enteredAtMaximize = host.entered - atRest
    const maximized = host.entered
    becomes(117, 34, 'a row, restored')
    await settle(500)
    walk.restored = widest(ink.lastFrameText())
    walk.enteredAtRestore = host.entered - maximized
  } finally {
    Object.defineProperty(process, 'platform', real)
  }
  const exited = ink.waitUntilExit()
  ink.unmount()
  await exited
  instances.delete(host as never)
  return walk
}

t('the console of this proof names itself to nothing and draws nothing atomically', syncOutputCapabilityNow() === false)

const classic = await maximizeThenRestore('win32', false)
t('§1 the old Windows console, maximized: the frame is 213 columns wide', classic.maximized === 213, `${classic.maximized}`)
t('§1 restored to a window of 117 columns over a buffer still 213 wide, the frame is the window\'s width', classic.restored === 117, `${classic.restored} columns painted`)
t('§1 each settled resize took one fresh alternate buffer, the size of the window', classic.enteredAtMaximize === 1 && classic.enteredAtRestore === 1, `${classic.enteredAtMaximize} at the maximize, ${classic.enteredAtRestore} at the restore`)

const streaming = await maximizeThenRestore('win32', false, 'a render')
t('§1 the same when a render is the first to see the new size (a reply being written): 213, then the window\'s 117, one fresh buffer each', streaming.maximized === 213 && streaming.restored === 117 && streaming.enteredAtMaximize === 1 && streaming.enteredAtRestore === 1, `${streaming.maximized} → ${streaming.restored} columns, ${streaming.enteredAtMaximize} + ${streaming.enteredAtRestore} entries`)

const elsewhere = await maximizeThenRestore('darwin', true)
t('§2 off Windows a resize enters no alternate screen again', elsewhere.enteredAtMaximize === 0 && elsewhere.enteredAtRestore === 0 && elsewhere.maximized === 213 && elsewhere.restored === 117, `${elsewhere.enteredAtMaximize} + ${elsewhere.enteredAtRestore} entries, ${elsewhere.maximized} → ${elsewhere.restored} columns`)

upgradeSyncOutputSupport()
const atomic = await maximizeThenRestore('win32', true)
t('§3 a Windows console that draws atomically (Windows Terminal, the editor\'s terminal) is left as it was: 213 and back to 117, no alternate screen entered again', atomic.enteredAtMaximize === 0 && atomic.enteredAtRestore === 0 && atomic.maximized === 213 && atomic.restored === 117, `${atomic.enteredAtMaximize} + ${atomic.enteredAtRestore} entries, ${atomic.maximized} → ${atomic.restored} columns`)

const atomicStreaming = await maximizeThenRestore('win32', true, 'a render')
t('§3 and when a render is the first to see its new size, it paints at that size at once as before', atomicStreaming.enteredAtMaximize === 0 && atomicStreaming.enteredAtRestore === 0 && atomicStreaming.maximized === 213 && atomicStreaming.restored === 117, `${atomicStreaming.enteredAtMaximize} + ${atomicStreaming.enteredAtRestore} entries, ${atomicStreaming.maximized} → ${atomicStreaming.restored} columns`)

console.log(failures === 0 ? 'CONSOLE WINDOW WIDTH: ALL PASS' : 'CONSOLE WINDOW WIDTH: RED')
process.exit(failures)
