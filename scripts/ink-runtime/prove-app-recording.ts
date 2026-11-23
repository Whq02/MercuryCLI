#!/usr/bin/env bun
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import type { ReactNode } from 'react'
import type AppClass from '../../src/screen/renderer/elements/App.tsx'
import type { InputEvent } from '../../src/screen/renderer/events/input-event.ts'
import type { ParsedKey } from '../../src/screen/renderer/input/input-decoder.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import {
  advance,
  enterWorld,
  escaped,
  hide,
  installStage,
  leaveStage,
  note,
  pendingTimers,
  recorded,
  settle,
  StageKeys,
  StageScreen,
  terminal,
  wordsOf,
} from './inkRecordingStage.ts'

const SELF = 'scripts/ink-runtime/prove-app-recording.ts'
const UNIT = 'App'
const RECORDING = join(import.meta.dirname, 'app-recording.json')
const RECORDING_NAME = 'scripts/ink-runtime/app-recording.json'
const AT_ONCE = 4
const CHILD_LIMIT_MS = 60_000
const NOT_OF_A_RECORDING: ReadonlyArray<[what: string, found: RegExp]> = [
  ['a path of this machine', /\/Users\/|\/private\/|\/tmp\/|\/home\/|[A-Za-z]:\\\\/],
  ['a signal by its name', /\bSIG[A-Z]{3,}\b/],
]
const ANSI = /\u001b\[[0-9;:?<>=]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g

class NamedStageKeys extends StageKeys {
  readError: Error | null = null

  constructor(private readonly tag: string, isTTY = true) {
    super(isTTY)
  }

  override setEncoding(encoding?: string): this {
    note(`${this.tag} setEncoding(${encoding ?? ''})`)
    return super.setEncoding()
  }

  override setRawMode(raw: boolean): this {
    this.isRaw = raw
    note(`${this.tag} setRawMode(${raw})`)
    return this
  }

  override ref(): this {
    note(`${this.tag} ref`)
    return this
  }

  override unref(): this {
    note(`${this.tag} unref`)
    return this
  }

  override addListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    if (event === 'readable') note(`${this.tag} addListener(readable)`)
    StageKeys.prototype.addListener.call(this, event, listener)
    return this
  }

  override removeListener(event: string | symbol, listener: (...args: unknown[]) => void): this {
    if (event === 'readable' && this.listeners('readable').includes(listener)) {
      note(`${this.tag} removeListener(readable)`)
    }
    StageKeys.prototype.removeListener.call(this, event, listener)
    return this
  }

  override read(size?: number): string | null {
    if (this.readError !== null) {
      const error = this.readError
      this.readError = null
      throw error
    }
    return super.read(size)
  }
}

function keySummary(key: ParsedKey): string {
  const mods: string[] = []
  if (key.ctrl) mods.push('ctrl')
  if (key.meta) mods.push('meta')
  if (key.shift) mods.push('shift')
  if (key.option) mods.push('option')
  if (key.super) mods.push('super')
  if (key.isPasted) mods.push('pasted')
  const pos = key.x !== undefined || key.y !== undefined ? ` @${key.x ?? '-'},${key.y ?? '-'}` : ''
  return `name=${key.name ?? 'none'} seq=${escaped(key.sequence ?? '')}${mods.length > 0 ? ` [${mods.join(',')}]` : ''}${pos}`
}

function inputEventSummary(event: InputEvent): string {
  const mods: string[] = []
  if (event.key.ctrl) mods.push('ctrl')
  if (event.key.meta) mods.push('meta')
  if (event.key.shift) mods.push('shift')
  if (event.key.return) mods.push('return')
  if (event.key.escape) mods.push('escape')
  if (event.key.upArrow) mods.push('up')
  if (event.key.downArrow) mods.push('down')
  if (event.key.leftArrow) mods.push('left')
  if (event.key.rightArrow) mods.push('right')
  if (event.key.isPasted) mods.push('pasted')
  if (event.wheelStep) mods.push('wheelStep')
  return `input=${escaped(event.input)}${mods.length > 0 ? ` [${mods.join(',')}]` : ''}`
}

function screenLines(text: string): string {
  const rows = text.replace(ANSI, '').split('\n')
  if (rows.length === 1 && rows[0] === '') return 'empty'
  return rows.map(row => escaped(row)).join(' | ')
}

function sgr(button: number, col: number, row: number, up = false): string {
  return `\u001b[<${button};${col};${row}${up ? 'm' : 'M'}`
}

async function loadProduct() {
  const React = await import('react')
  const { ConcurrentRoot } = await import('react-reconciler/constants.js')
  const { default: App } = await import('../../src/screen/renderer/elements/App.js')
  const { default: StdinContext } = await import('../../src/screen/renderer/elements/StdinContext.js')
  const { default: AppContext } = await import('../../src/screen/renderer/elements/AppContext.js')
  const { TerminalSizeContext, LiveTerminalSizeContext } = await import('../../src/screen/renderer/elements/TerminalSizeContext.js')
  const { useTerminalFocus } = await import('../../src/screen/renderer/bindings/use-terminal-focus.js')
  const { default: useInput } = await import('../../src/screen/renderer/bindings/use-input.js')
  const { default: Text } = await import('../../src/screen/renderer/elements/Text.js')
  const { default: Box } = await import('../../src/screen/renderer/elements/Box.js')
  const { default: Ink } = await import('../../src/screen/renderer/screenInstance.js')
  const { default: instances } = await import('../../src/screen/renderer/instances.js')
  const { default: reconciler } = await import('../../src/screen/renderer/reconciler.js')
  const { createNode } = await import('../../src/screen/renderer/dom.js')
  const { createSelectionState } = await import('../../src/screen/renderer/geometry/selection.js')
  const { useLayoutChrome } = await import('../../src/screen/fullscreen-layout/layoutChromeContext.js')
  const ledger = await import('../../src/screen/renderer/root/terminalModeLedger.js')
  const { getMercuryHome } = await import('../../src/platform/environment/envUtils.js')
  const { crashReportDir } = await import('../../src/platform/logs/crashReport.js')
  const home = getMercuryHome()
  hide(home, '<config-home>')
  if (home.startsWith(homedir() + sep)) hide(`~${home.slice(homedir().length)}`, '<config-home>')
  return {
    React,
    ConcurrentRoot,
    App,
    StdinContext,
    AppContext,
    TerminalSizeContext,
    LiveTerminalSizeContext,
    useTerminalFocus,
    useInput,
    Text,
    Box,
    Ink,
    instances,
    reconciler,
    createNode,
    createSelectionState,
    useLayoutChrome,
    ledger,
    crashReportDir,
  }
}

type Product = Awaited<ReturnType<typeof loadProduct>>

type HarnessKnobs = {
  ttyIn?: boolean
  ttyOut?: boolean
  exitOnCtrlC?: boolean
  columns?: number
  rows?: number
  hyperlink?: string
  clickConsumed?: boolean
}

class DirectAppHarness {
  readonly out: StageScreen
  readonly err: StageScreen
  stdin: NamedStageKeys
  readonly selection: ReturnType<Product['createSelectionState']>
  readonly rootNode: ReturnType<Product['createNode']>
  readonly container: unknown
  appRef: AppClass | null = null
  stdinCtx: {
    setRawMode: (value: boolean) => void
    isRawModeSupported: boolean
    internal_eventEmitter: {
      on: (event: string, fn: (...args: unknown[]) => void) => void
      removeListener: (event: string, fn: (...args: unknown[]) => void) => void
    }
  } | null = null
  appCtx: { exit: (error?: Error) => void } | null = null
  columns: number
  rows: number
  exitOnCtrlC: boolean
  hyperlink: string | undefined
  clickConsumed: boolean
  private emitterWired = false

  constructor(private readonly the: Product, knobs: HarnessKnobs = {}) {
    this.columns = knobs.columns ?? 80
    this.rows = knobs.rows ?? 24
    this.exitOnCtrlC = knobs.exitOnCtrlC ?? false
    this.hyperlink = knobs.hyperlink
    this.clickConsumed = knobs.clickConsumed ?? false
    this.out = new StageScreen('out', this.columns, this.rows, knobs.ttyOut ?? true)
    this.err = new StageScreen('err', this.columns, this.rows, false)
    this.stdin = new NamedStageKeys('stdin', knobs.ttyIn ?? true)
    this.selection = the.createSelectionState()
    this.rootNode = the.createNode('ink-root')
    this.container = the.reconciler.createContainer(
      this.rootNode,
      the.ConcurrentRoot as never,
      null,
      false,
      null,
      '',
      (error: Error) => note(`uncaught: ${wordsOf(error)}`),
      (error: Error) => note(`caught: ${wordsOf(error)}`),
      (error: Error) => note(`recoverable: ${wordsOf(error)}`),
      () => {},
    )
  }

  private wireEmitter(): void {
    if (this.emitterWired || this.stdinCtx === null) return
    this.emitterWired = true
    const emitter = this.stdinCtx.internal_eventEmitter
    emitter.on('input', (event: unknown) => note(`emit input ${inputEventSummary(event as InputEvent)}`))
    emitter.on('wheel', (event: unknown) => note(`emit wheel ${inputEventSummary(event as InputEvent)}`))
    emitter.on('terminalfocus', () => note('emit terminalfocus'))
    emitter.on('terminalblur', () => note('emit terminalblur'))
  }

  render(child?: ReactNode): void {
    const { React, App, StdinContext, AppContext, TerminalSizeContext, LiveTerminalSizeContext, useTerminalFocus, useLayoutChrome, Text } = this.the
    const harness = this
    function Probe(): ReactNode {
      const stdinValue = React.useContext(StdinContext)
      const appValue = React.useContext(AppContext)
      const size = React.useContext(TerminalSizeContext)
      const liveSize = React.useContext(LiveTerminalSizeContext)
      const focused = useTerminalFocus()
      const chrome = useLayoutChrome()
      harness.stdinCtx = stdinValue as unknown as DirectAppHarness['stdinCtx']
      harness.appCtx = appValue
      harness.wireEmitter()
      note(`probe size=${size?.columns ?? 0}x${size?.rows ?? 0} live=${liveSize?.columns ?? 0}x${liveSize?.rows ?? 0} rawSupported=${stdinValue.isRawModeSupported} focused=${focused} fullscreen=${chrome.fullscreen}`)
      return React.createElement(Text, null, child ?? 'ok')
    }

    const element = React.createElement(
      App,
      {
        ref: (instance: AppClass | null) => {
          this.appRef = instance
        },
        stdin: this.stdin as unknown as NodeJS.ReadStream,
        stdout: this.out as unknown as NodeJS.WriteStream,
        stderr: this.err as unknown as NodeJS.WriteStream,
        exitOnCtrlC: this.exitOnCtrlC,
        onExit: (error?: Error) => note(`cb onExit(${error ? wordsOf(error) : 'none'})`),
        columns: this.columns,
        rows: this.rows,
        selection: this.selection,
        notifySelectionChange: () => {
          const a = this.selection.anchor ? `${this.selection.anchor.col},${this.selection.anchor.row}` : 'none'
          const f = this.selection.focus ? `${this.selection.focus.col},${this.selection.focus.row}` : 'none'
          note(`cb notifySelectionChange anchor=${a} focus=${f} dragging=${this.selection.isDragging}`)
        },
        dispatchClick: (col: number, row: number) => {
          note(`cb dispatchClick(${col},${row}) -> ${this.clickConsumed}`)
          return this.clickConsumed
        },
        dispatchHover: (col: number, row: number) => note(`cb dispatchHover(${col},${row})`),
        getHyperlinkAt: (col: number, row: number) => {
          note(`cb getHyperlinkAt(${col},${row}) -> ${this.hyperlink ?? 'none'}`)
          return this.hyperlink
        },
        openHyperlink: (url: string) => note(`cb openHyperlink(${url})`),
        handleMultiClick: (col: number, row: number, count: 2 | 3) => note(`cb handleMultiClick(${col},${row},${count})`),
        handleSelectionDrag: (col: number, row: number) => note(`cb handleSelectionDrag(${col},${row})`),
        onStdinResume: () => note('cb onStdinResume'),
        dispatchKeyboardEvent: (key: ParsedKey) => note(`cb dispatchKeyboardEvent ${keySummary(key)}`),
      },
      child !== undefined ? child : React.createElement(Probe),
    )
    this.the.reconciler.updateContainerSync(element, this.container as never, null, null)
    this.the.reconciler.flushSyncWork()
  }

  unmount(): void {
    this.the.reconciler.updateContainerSync(null, this.container as never, null, null)
    this.the.reconciler.flushSyncWork()
  }

  snapshot(): void {
    note(`state modes=${terminal.words()} held=[${this.the.ledger.shutdownReleaseObligations().join(',')}] stdin=${this.stdin.words()} timers=[${pendingTimers()}]`)
  }
}

type Scene = {
  name: string
  play: (the: Product) => Promise<void>
}

const SCENES: readonly Scene[] = [
  {
    name: 'mount-tty-and-raw-mode',
    play: async the => {
      const h = new DirectAppHarness(the, { ttyIn: true, ttyOut: true })
      note('> mount tty')
      h.render()
      await settle()
      h.snapshot()

      note('> setRawMode(true) first')
      h.stdinCtx!.setRawMode(true)
      await settle()
      h.snapshot()

      note('> terminal response to probe')
      h.stdin.sends('\x1b[?2026;1$y\x1b[?0u\x1b[?62;c')
      await settle()
      h.snapshot()

      note('> setRawMode(true) second')
      h.stdinCtx!.setRawMode(true)
      await settle()
      h.snapshot()

      note('> setRawMode(false) first')
      h.stdinCtx!.setRawMode(false)
      await settle()
      h.snapshot()

      note('> setRawMode(false) second')
      h.stdinCtx!.setRawMode(false)
      await settle()
      h.snapshot()

      note('> unmount')
      h.unmount()
      await settle()
      h.snapshot()
    },
  },
  {
    name: 'mount-non-tty',
    play: async the => {
      const h = new DirectAppHarness(the, { ttyIn: false, ttyOut: false })
      note('> mount non-tty')
      h.render()
      await settle()
      h.snapshot()

      note('> setRawMode(true) on non-tty')
      try {
        h.stdinCtx!.setRawMode(true)
      } catch (error) {
        note(`threw: ${wordsOf(error)}`)
      }
      await settle()
      h.snapshot()

      note('> unmount')
      h.unmount()
      await settle()
      h.snapshot()
    },
  },
  {
    name: 'keys-plain-escape-split-csi-wheel-and-gap',
    play: async the => {
      const h = new DirectAppHarness(the, { ttyIn: true, ttyOut: true })
      h.render()
      h.stdinCtx!.setRawMode(true)
      await advance(300)

      note('> plain key a')
      h.stdin.sends('a')
      await settle()

      note('> lone escape')
      h.stdin.sends('\x1b')
      await settle()
      h.snapshot()

      note('> 25ms pass (not flushed yet)')
      await advance(25)
      h.snapshot()

      note('> 25ms pass (lone escape flushes)')
      await advance(25)
      h.snapshot()

      note('> split CSI chunk 1')
      h.stdin.sends('\x1b[')
      await advance(20)
      h.snapshot()

      note('> split CSI chunk 2')
      h.stdin.sends('A')
      await settle()
      h.snapshot()

      note('> mixed text and acting key in one chunk')
      h.stdin.sends('hi\rbye\x1b[B')
      await settle()

      note('> coalesced SGR wheel run')
      h.stdin.sends('\x1b[<65;5;5M\x1b[<65;5;5M\x1b[<65;5;5M')
      await settle()

      note('> direct pressEscape()')
      h.appRef!.pressEscape()
      await settle()

      note('> gap over 5000ms triggers onStdinResume')
      await advance(5001)
      h.stdin.sends('z')
      await settle()

      note('> unmount')
      h.unmount()
      await settle()
    },
  },
  {
    name: 'bracketed-paste',
    play: async the => {
      const h = new DirectAppHarness(the, { ttyIn: true, ttyOut: true })
      h.render()
      h.stdinCtx!.setRawMode(true)
      await advance(300)

      note('> complete bracketed paste')
      h.stdin.sends('\x1b[200~hello\nworld\x1b[201~')
      await settle()
      h.snapshot()

      note('> split bracketed paste chunk 1')
      h.stdin.sends('\x1b[200~part1')
      await advance(100)
      h.snapshot()

      note('> split bracketed paste chunk 2')
      h.stdin.sends('part2\x1b[201~')
      await settle()
      h.snapshot()

      note('> unmount')
      h.unmount()
      await settle()
    },
  },
  {
    name: 'mouse-press-drag-release-click-hover-multiclick',
    play: async the => {
      const h = new DirectAppHarness(the, { ttyIn: true, ttyOut: true, hyperlink: 'https://example.invalid', clickConsumed: false })
      h.render()
      h.stdinCtx!.setRawMode(true)
      await advance(300)

      note('> hover motion and duplicate hover')
      h.stdin.sends(sgr(35, 4, 3) + sgr(35, 4, 3))
      await settle()

      note('> press, drag motion coalesced, release')
      h.stdin.sends(sgr(0, 5, 4))
      await settle()
      h.stdin.sends(sgr(32, 6, 4) + sgr(32, 10, 4))
      await settle()
      h.stdin.sends(sgr(0, 10, 4, true))
      await settle()

      note('> single click opens hyperlink after 500ms')
      await advance(600)
      h.stdin.sends(sgr(0, 2, 2) + sgr(0, 2, 2, true))
      await settle()
      h.snapshot()
      await advance(500)
      h.snapshot()

      note('> double click at same cell')
      await advance(600)
      h.stdin.sends(sgr(0, 8, 6) + sgr(0, 8, 6, true))
      await settle()
      await advance(100)
      h.stdin.sends(sgr(0, 8, 6) + sgr(0, 8, 6, true))
      await settle()
      h.snapshot()

      note('> unmount')
      h.unmount()
      await settle()
    },
  },
  {
    name: 'focus-in-and-out',
    play: async the => {
      const h = new DirectAppHarness(the, { ttyIn: true, ttyOut: true })
      h.render()
      h.stdinCtx!.setRawMode(true)
      await advance(300)

      note('> start drag then focus out')
      h.stdin.sends(sgr(0, 3, 3))
      await settle()
      h.stdin.sends('\x1b[O')
      await settle()

      note('> focus in')
      h.stdin.sends('\x1b[I')
      await settle()

      note('> press within refocus window is swallowed')
      await advance(50)
      h.stdin.sends(sgr(0, 4, 4) + sgr(0, 4, 4, true))
      await settle()

      note('> press after refocus window clicks normally')
      await advance(250)
      h.stdin.sends(sgr(0, 4, 4) + sgr(0, 4, 4, true))
      await settle()

      note('> direct setTerminalFocus(false)')
      h.appRef!.setTerminalFocus(false)
      await settle()

      note('> unmount')
      h.unmount()
      await settle()
    },
  },
  {
    name: 'stdin-swap-while-raw',
    play: async the => {
      const h = new DirectAppHarness(the, { ttyIn: true, ttyOut: true })
      h.render()
      h.stdinCtx!.setRawMode(true)
      await advance(300)

      const firstStdin = h.stdin
      note('> swap stdin while raw mode is on')
      h.stdin = new NamedStageKeys('stdin2', true)
      h.render()
      await settle()
      note(`firstStdin=${firstStdin.words()} secondStdin=${h.stdin.words()}`)

      note('> send x on old stdin (ignored) and y on new stdin (received)')
      firstStdin.sends('x')
      h.stdin.sends('y')
      await settle()

      note('> unmount')
      h.unmount()
      await settle()
      note(`firstStdin=${firstStdin.words()} secondStdin=${h.stdin.words()}`)
    },
  },
  {
    name: 'resize-and-paint',
    play: async the => {
      const { React, Ink, instances, Text, useInput, TerminalSizeContext } = the
      const out = new StageScreen('out', 40, 10, true)
      const err = new StageScreen('err', 40, 10, false)
      const keys = new NamedStageKeys('stdin', true)
      const ink = new Ink({
        stdout: out as unknown as NodeJS.WriteStream,
        stdin: keys as unknown as NodeJS.ReadStream,
        stderr: err as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
        patchConsole: false,
      })
      instances.set(out as unknown as NodeJS.WriteStream, ink)

      function SizedView(): ReactNode {
        const size = React.useContext(TerminalSizeContext)
        const [seen, setSeen] = React.useState('')
        useInput(input => {
          note(`useInput got ${escaped(input)}`)
          setSeen(prev => prev + input)
        })
        return React.createElement(Text, null, `size=${size?.columns ?? 0}x${size?.rows ?? 0} seen=${seen}`)
      }

      note('> initial mount and paint')
      ink.render(React.createElement(SizedView))
      await advance(300)
      note(`frame: ${screenLines(ink.lastFrameText())}`)

      note('> resize 60x15')
      out.resizes(60, 15)
      await advance(200)
      note(`frame: ${screenLines(ink.lastFrameText())}`)

      note('> key k after resize')
      keys.sends('k')
      await advance(50)
      note(`frame: ${screenLines(ink.lastFrameText())}`)

      note('> unmount')
      ink.unmount()
      await settle()
      instances.delete(out as unknown as NodeJS.WriteStream)
    },
  },
  {
    name: 'handle-exit-with-and-without-error',
    play: async the => {
      note('> exit via Ctrl+C without error')
      const a = new DirectAppHarness(the, { ttyIn: true, ttyOut: true, exitOnCtrlC: true })
      a.render()
      a.stdinCtx!.setRawMode(true)
      await advance(300)
      a.stdin.sends('\x03')
      await settle()
      a.snapshot()
      a.unmount()
      await settle()

      note('> exit via AppContext.exit(Error)')
      const b = new DirectAppHarness(the, { ttyIn: true, ttyOut: true, exitOnCtrlC: false })
      b.render()
      b.stdinCtx!.setRawMode(true)
      await advance(300)
      b.appCtx!.exit(new Error('boom-exit'))
      await settle()
      b.snapshot()
      b.unmount()
      await settle()
    },
  },
  {
    name: 'render-error-caught',
    play: async the => {
      const { React, Ink, instances, Text, useInput, crashReportDir } = the
      const out = new StageScreen('out', 80, 20, true)
      const err = new StageScreen('err', 80, 20, false)
      const keys = new NamedStageKeys('stdin', true)
      const ink = new Ink({
        stdout: out as unknown as NodeJS.WriteStream,
        stdin: keys as unknown as NodeJS.ReadStream,
        stderr: err as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
        patchConsole: false,
      })
      instances.set(out as unknown as NodeJS.WriteStream, ink)
      const exited = ink.waitUntilExit().then(
        () => note('waitUntilExit resolved'),
        error => note(`waitUntilExit rejected: ${wordsOf(error)}`),
      )

      function Faulty(): ReactNode {
        const [boom, setBoom] = React.useState(false)
        useInput(input => {
          if (input === '!') setBoom(true)
        })
        if (boom) throw new Error('child-render-boom')
        return React.createElement(Text, null, 'healthy')
      }

      note('> mount healthy')
      ink.render(React.createElement(Faulty))
      await advance(300)
      note(`frame: ${screenLines(ink.lastFrameText())}`)

      note('> trigger child render error')
      keys.sends('!')
      await advance(100)
      await exited
      note(`frame: ${screenLines(ink.lastFrameText())}`)
      const reports = existsSync(crashReportDir()) ? readdirSync(crashReportDir()).filter(f => f.startsWith('crash-')) : []
      note(`crashReports=${reports.length}`)
      note(`stdin=${keys.words()}`)
      instances.delete(out as unknown as NodeJS.WriteStream)
    },
  },
  {
    name: 'unmount-clears-timers-and-raw-mode',
    play: async the => {
      const h = new DirectAppHarness(the, { ttyIn: true, ttyOut: true, hyperlink: 'https://example.invalid', clickConsumed: false })
      h.render()
      h.stdinCtx!.setRawMode(true)
      await advance(300)

      note('> arm incomplete escape timer and hyperlink timer')
      h.stdin.sends(sgr(0, 2, 2) + sgr(0, 2, 2, true))
      await settle()
      h.stdin.sends('\x1b')
      await settle()
      h.snapshot()

      note('> unmount immediately while timers are pending')
      h.unmount()
      await settle()
      h.snapshot()

      note('> advance 1000ms after unmount (no stray events)')
      await advance(1000)
      h.snapshot()
    },
  },
]

const argOf = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)
  return at < 0 ? undefined : process.argv[at + 1]
}

const sceneAsked = argOf('--scene')
if (sceneAsked !== undefined && argOf('--out') !== undefined) {
  const scene = SCENES.find(s => s.name === sceneAsked)
  if (!scene) {
    console.error(`unknown scene: ${sceneAsked}`)
    process.exit(1)
  }
  enterWorld('plain')
  installStage(null)
  try {
    const the = await loadProduct()
    await scene.play(the)
    writeFileSync(argOf('--out')!, JSON.stringify(recorded()))
  } finally {
    leaveStage()
  }
  process.exit(0)
}

const scratch = mkdtempSync(join(tmpdir(), 'app-recording-'))

function playInChild(name: string, round: number, at: number): Promise<string[]> {
  const stem = join(scratch, `${round}-${at}`)
  const home = `${stem}-home`
  mkdirSync(home, { recursive: true })
  return new Promise((done, refuse) => {
    const child = spawn(process.execPath, [...process.execArgv, import.meta.path, '--scene', name, '--out', `${stem}.json`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MERCURY_CONFIG_DIR: home },
    })
    let said = ''
    child.stderr!.on('data', chunk => {
      said += String(chunk)
    })
    const limit = setTimeout(() => child.kill('SIGKILL'), CHILD_LIMIT_MS)
    child.on('error', refuse)
    child.on('close', (code, signal) => {
      clearTimeout(limit)
      if (code !== 0 || !existsSync(`${stem}.json`)) {
        refuse(new Error(`scene "${name}" failed (${signal === null ? `code ${code}` : 'signal'}):\n${said.trim().split('\n').slice(-12).join('\n')}`))
        return
      }
      done(JSON.parse(readFileSync(`${stem}.json`, 'utf8')) as string[])
    })
  })
}

async function record(round: number, names: readonly string[]): Promise<Record<string, string[]>> {
  const out = new Map<string, string[]>()
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const at = next++
      const name = names[at]
      if (name === undefined) return
      out.set(name, await playInChild(name, round, at))
    }
  }
  const ended = await Promise.allSettled(Array.from({ length: AT_ONCE }, worker))
  for (const end of ended) if (end.status === 'rejected') throw end.reason
  const ordered: Record<string, string[]> = {}
  for (const name of names) ordered[name] = out.get(name)!
  return ordered
}

function firstDifference(stood: string[], stands: string[]): string | null {
  const reach = Math.max(stood.length, stands.length)
  for (let at = 0; at < reach; at++) {
    if (stood[at] === stands[at]) continue
    return `line ${at + 1}\n      stood:  ${stood[at] ?? '(no line)'}\n      stands: ${stands[at] ?? '(no line)'}`
  }
  return null
}

let failures = 0
const fail = (line: string): void => {
  failures++
  console.log(`  [FAIL] ${line}`)
}

const names = SCENES.map(scene => scene.name)
const source = Bun.resolveSync('../../src/screen/renderer/elements/App.js', import.meta.dir)
if (source.replaceAll('\\', '/').endsWith('/src/screen/renderer/elements/App.tsx')) {
  console.log(`  [PASS] recorded unit is ${UNIT} of src/screen/renderer/elements/App.tsx`)
} else {
  fail(`recorded module is not src/screen/renderer/elements/App.tsx: ${source}`)
}

let first: Record<string, string[]> = {}
let second: Record<string, string[]> = {}
try {
  first = await record(1, names)
  second = await record(2, names)
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
} finally {
  try {
    removeScratch(scratch)
  } catch (error) {
    console.log(`  [NOTE] scratch cleanup skipped: ${(error as NodeJS.ErrnoException).code ?? String(error)}`)
  }
}

for (const name of names) {
  const lines = first[name] ?? []
  const twice = firstDifference(lines, second[name] ?? [])
  if (twice !== null) fail(`${name}: two recordings on the same tree differ: ${twice}`)
  for (const [what, found] of NOT_OF_A_RECORDING) {
    const at = lines.findIndex(line => found.test(line))
    if (at >= 0) fail(`${name}: recording holds ${what} at line ${at + 1}: ${lines[at]}`)
  }
}

if (process.argv.includes('--write')) {
  if (failures === 0) {
    mkdirSync(dirname(RECORDING), { recursive: true })
    writeFileSync(RECORDING, JSON.stringify(first, null, 2) + '\n')
    const total = names.reduce((n, name) => n + first[name]!.length, 0)
    console.log(`  [PASS] ${names.length} scenes (${total} lines) equal across two runs, written to ${RECORDING_NAME}`)
  }
  process.exit(failures === 0 ? 0 : 1)
}

if (!existsSync(RECORDING)) {
  fail(`no recording stands at ${RECORDING_NAME}: run \`bun run ${SELF} --write\` on the base`)
} else {
  const stood = JSON.parse(readFileSync(RECORDING, 'utf8')) as Record<string, string[]>
  for (const name of names) {
    const held = stood[name]
    if (held === undefined) {
      fail(`${name}: missing from ${RECORDING_NAME}`)
      continue
    }
    const moved = firstDifference(held, first[name] ?? [])
    if (moved === null) console.log(`  [PASS] ${name} (${first[name]!.length} lines)`)
    else fail(`recorded behaviour of ${UNIT} changed in "${name}" at ${moved}`)
  }
  for (const name of Object.keys(stood)) {
    if (!names.includes(name)) fail(`${name}: stored in ${RECORDING_NAME} without a scene`)
  }
}

console.log(`\n${failures === 0 ? 'green' : 'RED'}: prove-app-recording — ${names.length} scenes, ${failures === 0 ? 'equal to the recording' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
