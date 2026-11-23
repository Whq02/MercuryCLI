import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import type { ReactNode } from 'react'
import type { ScrollBoxHandle } from '../../src/screen/renderer/elements/ScrollBox.tsx'
import type { DOMElement } from '../../src/screen/renderer/dom.ts'
import type { FrameEvent } from '../../src/screen/renderer/frame.ts'
import type InkClass from '../../src/screen/renderer/screenInstance.tsx'
import type { Options } from '../../src/screen/renderer/screenInstance.tsx'
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
  sendDebugLinesTo,
  settle,
  StageKeys,
  StageScreen,
  TEE_NAMES,
  terminal,
  ticks,
  wordsOf,
  WORLDS,
  type WorldName,
} from './inkRecordingStage.ts'

type TeeName = (typeof TEE_NAMES)[number]

type Scene = {
  name: string
  world: WorldName
  env?: (folder: string) => Record<string, string>
  tees?: readonly TeeName[]
  probe?: string
  play: (p: Play) => Promise<void>
}

async function loadProduct() {
  const React = await import('react')
  const unit = await import('../../src/screen/renderer/screenInstance.tsx')
  const { default: instances } = await import('../../src/screen/renderer/instances.ts')
  const { default: Box } = await import('../../src/screen/renderer/elements/Box.tsx')
  const { default: Text } = await import('../../src/screen/renderer/elements/Text.tsx')
  const { default: Link } = await import('../../src/screen/renderer/elements/Link.tsx')
  const { default: ScrollBox } = await import('../../src/screen/renderer/elements/ScrollBox.tsx')
  const { AlternateScreen } = await import('../../src/screen/renderer/elements/AlternateScreen.tsx')
  const { NoSelect } = await import('../../src/screen/renderer/elements/NoSelect.tsx')
  const { default: useInput } = await import('../../src/screen/renderer/bindings/use-input.ts')
  const { useDeclaredCursor } = await import('../../src/screen/renderer/bindings/use-declared-cursor.ts')
  const ledger = await import('../../src/screen/renderer/root/terminalModeLedger.ts')
  const log = await import('../../src/platform/logs/errorLog.ts')
  const doors = await import('../../src/platform/processes/process.ts')
  const flux = await import('../../src/integrations/media-flux/fluxProbe.ts')
  const governor = await import('../../src/screen/cockpit/motionGovernor.ts')
  const session = await import('../../src/boot/process-state/processState.ts')
  const { getMercuryHome } = await import('../../src/platform/environment/envUtils.ts')
  const home = getMercuryHome()
  hide(home, '<the config home>')
  if (home.startsWith(homedir() + sep)) hide(`~${home.slice(homedir().length)}`, '<the config home>')
  const h = React.createElement as unknown as (type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]) => ReactNode
  return { React, h, Ink: unit.default, unit, instances, Box, Text, Link, ScrollBox, AlternateScreen, NoSelect, useInput, useDeclaredCursor, ledger, log, doors, flux, governor, session }
}

type Product = Awaited<ReturnType<typeof loadProduct>>

type MountKnobs = {
  ttyOut?: boolean
  ttyIn?: boolean
  patchConsole?: boolean
  exitOnCtrlC?: boolean
  stderr?: unknown
  waitUntilExit?: () => Promise<void>
  silentFrames?: boolean
}

const ANSI = /\u001b\[[0-9;:?<>=]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
const yn = (value: boolean): string => (value ? 'yes' : 'no')
const at = (point: { col: number; row: number } | null): string => (point === null ? 'none' : `${point.col},${point.row}`)

function screenWords(text: string): string {
  const rows = text.replace(ANSI, '').split('\n')
  if (rows.length === 1 && rows[0] === '') return 'empty'
  return rows.map(row => `\n    |${escaped(row)}`).join('')
}

function selectionWords(ink: InkClass): string {
  const s = ink.selection
  const span = s.anchorSpan === null ? 'none' : `${s.anchorSpan.kind} ${at(s.anchorSpan.lo)}..${at(s.anchorSpan.hi)}`
  const band = s.clipLo === undefined && s.clipHi === undefined && s.clipTop === undefined && s.clipBottom === undefined ? 'whole' : `${s.clipLo ?? '-'}..${s.clipHi ?? '-'} x ${s.clipTop ?? '-'}..${s.clipBottom ?? '-'}`
  return `anchor=${at(s.anchor)} focus=${at(s.focus)} dragging=${yn(s.isDragging)} span=${span} band=${band} alt-press=${yn(s.lastPressHadAlt)} off=${s.scrolledOffAbove.length}/${s.scrolledOffBelow.length} has=${yn(ink.hasTextSelection())}`
}

const touchedWords = (at: number): string => (at >= 1_700_000_000_000 ? `${at - 1_700_000_000_000} ms into the scene` : 'before the scene')

const sgr = (button: number, col: number, row: number, up = false): string => `\u001b[<${button};${col + 1};${row + 1}${up ? 'm' : 'M'}`

class Play {
  ink!: InkClass
  out!: StageScreen
  err!: StageScreen
  keys!: StageKeys
  frames = 0
  frameHook: ((event: FrameEvent) => void) | null = null
  private readonly last = new Map<string, string>()
  private errorsSeen = 0
  private pools: unknown = null
  private poolsSeen = 0

  constructor(readonly the: Product, readonly folder: string) {}

  get h(): Product['h'] {
    return this.the.h
  }

  mount(columns: number, rows: number, knobs: MountKnobs = {}): InkClass {
    this.out = new StageScreen('out', columns, rows, knobs.ttyOut ?? true)
    this.err = new StageScreen('err', columns + 7, rows + 3, false)
    this.keys = new StageKeys(knobs.ttyIn ?? true)
    const options: Options = {
      stdout: this.out as never,
      stdin: this.keys as never,
      stderr: (knobs.stderr ?? this.err) as never,
      exitOnCtrlC: knobs.exitOnCtrlC ?? false,
      patchConsole: knobs.patchConsole ?? false,
      ...(knobs.silentFrames ? {} : { onFrame: (event: FrameEvent) => this.onFrame(event) }),
      ...(knobs.waitUntilExit ? { waitUntilExit: knobs.waitUntilExit } : {}),
    }
    this.ink = new this.the.Ink(options)
    this.the.instances.set(this.out as never, this.ink)
    this.ink.onHyperlinkClick = url => note(`  a link is opened: ${escaped(url)}`)
    return this.ink
  }

  private onFrame(event: FrameEvent): void {
    this.frames++
    const phases = event.phases!
    const flickers = event.flickers.map(flicker => ` flicker=${flicker.reason}:${flicker.desiredHeight}/${flicker.availableHeight}`).join('')
    note(
      `  frame ${this.frames}: reads=${ticks(event.durationMs)} renderer=${ticks(phases.renderer)} diff=${ticks(phases.diff)} optimize=${ticks(phases.optimize)} write=${ticks(phases.write)} layout=${ticks(phases.yoga)} commit=${ticks(phases.commit)} patches=${phases.patches} nodes=${phases.yogaVisited}/${phases.yogaMeasured}/${phases.yogaCacheHits}/${phases.yogaLive}${flickers}`,
    )
    this.frameHook?.(event)
  }

  show(node: ReactNode): void {
    this.ink.render(node)
  }

  state(): void {
    const ink = this.ink
    const rows: Array<[string, string]> = [
      ['modes', terminal.words()],
      ['held', this.the.ledger.shutdownReleaseObligations().join(' ') || 'nothing'],
      [
        'ink',
        `alt=${yn(ink.isAltScreenActive)} mouse=${yn(ink.isMouseTrackingEnabled())} prefers=${yn(ink.isMouseTrackingPreferred())} wheel=${yn(ink.isWheelReportingConfirmed())} entry=${yn(ink.isAltEntryPending())} reasserts=${ink.screenReassertCount} exit=${ink.exitOutcome?.kind ?? 'none'}`,
      ],
      ['stdin', this.keys.words()],
      ['pools', this.poolsWords()],
      ['touched', touchedWords(this.the.session.getLastInteractionTime())],
      ['timers', pendingTimers() || 'none'],
      ['selection', selectionWords(ink)],
      ['screen', screenWords(ink.lastFrameText())],
    ]
    for (const [name, words] of rows) {
      if (this.last.get(name) === words) continue
      this.last.set(name, words)
      note(`  ${name}:${words.startsWith("\n") ? "" : " "}${words}`)
    }
    const errors = this.the.log.getInMemoryErrors()
    for (const entry of errors.slice(this.errorsSeen)) note(`  an error is logged: ${escaped(entry.error.split('\n')[0]!)}`)
    this.errorsSeen = errors.length
  }

  private poolsWords(): string {
    const now = (this.ink as unknown as { charPool: unknown }).charPool
    if (now !== this.pools) this.poolsSeen++
    this.pools = now
    return `the ${this.poolsSeen}. set`
  }

  async step(title: string, act?: () => unknown): Promise<void> {
    note(`> ${title}`)
    if (act) {
      try {
        await act()
      } catch (error) {
        note(`  thrown to the caller: ${escaped(wordsOf(error))}`)
      }
    }
    await settle()
    this.state()
  }

  async wait(ms: number): Promise<void> {
    note(`> ${ms} ms pass`)
    await advance(ms)
    this.state()
  }

  async paint(title: string, node: ReactNode, ms = 16): Promise<void> {
    await this.step(title, () => this.show(node))
    await this.wait(ms)
  }

  press(col: number, row: number, alt = false): void {
    this.keys.sends(sgr(alt ? 8 : 0, col, row))
  }

  release(col: number, row: number): void {
    this.keys.sends(sgr(0, col, row, true))
  }

  drag(col: number, row: number): void {
    this.keys.sends(sgr(32, col, row))
  }

  hover(col: number, row: number): void {
    this.keys.sends(sgr(35, col, row))
  }

  click(col: number, row: number): void {
    this.press(col, row)
    this.release(col, row)
  }

  async end(): Promise<void> {
    await this.step('the screen is unmounted', () => this.ink.unmount())
    await this.wait(600)
  }
}

function Listens({ p, name = 'the app' }: { p: Play; name?: string }): ReactNode {
  p.the.useInput((input, key) => {
    const held = Object.entries(key as unknown as Record<string, unknown>)
      .filter(([, value]) => value === true)
      .map(([flag]) => flag)
      .join('+')
    note(`  ${name} hears ${escaped(JSON.stringify(input))}${held ? ` ${held}` : ''}`)
  })
  return null
}

function Field({ p, line, column, active, label }: { p: Play; line: number; column: number; active: boolean; label: string }): ReactNode {
  const ref = p.the.useDeclaredCursor({ line, column, active })
  return p.h(p.the.Box, { ref }, p.h(p.the.Text, null, label))
}

const PAINTS: Record<string, Record<string, unknown>> = {
  '!': { color: 'ansi:red', bold: true },
  '~': { color: '#3366cc', backgroundColor: 'ansi256(236)', italic: true },
  '_': { underline: true, dim: true },
}

const line = (p: Play, text: string, key?: number): ReactNode => {
  const paint = PAINTS[text[0] ?? '']
  return p.h(p.the.Text, { key, ...(paint ?? {}) }, paint === undefined ? text : text.slice(1))
}

const lines = (p: Play, texts: readonly string[], props: Record<string, unknown> = {}): ReactNode =>
  p.h(p.the.Box, { flexDirection: 'column', ...props }, ...texts.map((text, index) => line(p, text, index)))

const alt = (p: Play, child: ReactNode, mouseTracking = false): ReactNode => p.h(p.the.AlternateScreen, { mouseTracking }, child)

async function firstPaint(p: Play): Promise<void> {
  p.mount(24, 6)
  await p.step('a tree of two lines is given', () => p.show(lines(p, ['one', 'two'])))
  await p.wait(99)
  await p.wait(1)
  await p.paint('the same tree is given again', lines(p, ['one', 'two']))
  await p.wait(40)
  await p.step('a third line is given after the frame window has passed', () => p.show(lines(p, ['one', 'two', 'three'])))
  await p.end()
}

async function mainScreenUpdates(p: Play): Promise<void> {
  p.mount(24, 6)
  await p.paint('three lines are given', lines(p, ['alpha', 'beta', '!gamma']), 100)
  await p.paint('one cell changes', lines(p, ['alpha', 'bela', '!gamma']))
  await p.paint('one line changes', lines(p, ['alpha', '~BETA TWO', '!gamma']))
  await p.paint('a line changes its paint only', lines(p, ['alpha', '_BETA TWO', '!gamma']))
  await p.paint('a line is added', lines(p, ['alpha', '_BETA TWO', 'gamma', '~delta']))
  await p.paint('two lines leave', lines(p, ['alpha', 'BETA TWO']))
  await p.paint('the whole screen changes', lines(p, ['1111', '2222', '3333']))
  await p.paint('wide letters come and a text holds another', p.h(p.the.Box, { flexDirection: 'column' }, line(p, '\u4e16\u754c 1111'), p.h(p.the.Text, null, 'outer ', p.h(p.the.Text, { bold: true }, 'inner')), line(p, '3333')))
  await p.paint('more lines than the terminal has rows', lines(p, ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']))
  await p.paint('a line changes above the fold', lines(p, ['R1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']))
  await p.paint('back under the rows', lines(p, ['r1', 'r2']))
  await p.step('the line count is reset, as after a clear from outside', () => p.ink.resetLineCount())
  await p.paint('a line after the reset', lines(p, ['r1', 'r2', 'r3']))
  await p.step('a full redraw is forced', () => p.ink.forceRedraw())
  await p.step('a repaint is asked for', () => p.ink.repaint())
  await p.step('the alternate screen is asked to repaint where none is', () => p.ink.repaintAltScreen())
  await p.step('the frame before is declared invalid', () => p.ink.invalidatePrevFrame())
  await p.paint('a cell after it', lines(p, ['r1', 'r2', 'r4']))
  await p.step('the doors of the alternate screen are tried where none is', () => {
    p.ink.overwriteScreen()
    p.ink.repaintAfterNestedAltScreenClose()
    p.ink.confirmWheelReporting()
    p.ink.handleSelectionStart(1, 1)
    p.ink.handleMultiClick(1, 1, 2)
    p.ink.handleSelectionDrag(2, 1)
    p.ink.moveSelectionFocus('right')
    note(`  a click finds ${yn(p.ink.dispatchClick(1, 1))}, a link ${String(p.ink.getHyperlinkAt(1, 1))}`)
    p.ink.dispatchHover(1, 1)
  })
  await p.wait(16)
  await p.end()
}

async function altScreenUpdates(p: Play): Promise<void> {
  p.mount(24, 6)
  await p.paint('the alternate screen is entered with three lines', alt(p, lines(p, ['alpha', 'beta', '!gamma'])), 100)
  await p.paint('one cell changes', alt(p, lines(p, ['alpha', 'bela', '!gamma'])))
  await p.paint('one line changes', alt(p, lines(p, ['alpha', '~BETA TWO', '!gamma'])))
  await p.paint('a line changes its paint only', alt(p, lines(p, ['alpha', '_BETA TWO', '!gamma'])))
  await p.paint('a line is added', alt(p, lines(p, ['alpha', '_BETA TWO', 'gamma', '~delta'])))
  await p.paint('two lines leave', alt(p, lines(p, ['alpha', 'BETA TWO'])))
  await p.paint('the whole screen changes', alt(p, lines(p, ['111111', '222222', '333333', '444444', '555555', '666666'])))
  await p.paint('nothing changes', alt(p, lines(p, ['111111', '222222', '333333', '444444', '555555', '666666'])))
  await p.paint('more lines than the terminal has rows', alt(p, lines(p, ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8'], { flexShrink: 0 })))
  await p.step('a full redraw is forced', () => p.ink.forceRedraw())
  await p.step('a repaint is asked for', () => p.ink.repaint())
  await p.step('the alternate screen is asked to repaint', () => p.ink.repaintAltScreen())
  await p.step('the frame before is declared invalid', () => p.ink.invalidatePrevFrame())
  await p.paint('a cell after it', alt(p, lines(p, ['r1', 'r2', 'r9'])))
  await p.step('the line count is reset, which the alternate screen does not take', () => p.ink.resetLineCount())
  await p.paint('the alternate screen is left', lines(p, ['back on the main screen']))
  await p.paint('and entered again', alt(p, lines(p, ['again'])))
  await p.end()
}

async function nestedAltScreen(p: Play): Promise<void> {
  p.mount(24, 6)
  const inner = (words: string): ReactNode => alt(p, lines(p, [words]))
  await p.paint('an alternate screen holds another', alt(p, p.h(p.the.Box, { flexDirection: 'column' }, p.h(p.the.Text, null, 'outer'), inner('inner'))), 100)
  await p.paint('the inner one closes', alt(p, lines(p, ['outer', 'alone'])))
  await p.paint('an inner one opens over a painted outer one', alt(p, p.h(p.the.Box, { flexDirection: 'column' }, p.h(p.the.Text, null, 'outer'), inner('second'))))
  await p.paint('both close at once', lines(p, ['main']))
  await p.end()
}

async function launcherHeldAltScreen(p: Play): Promise<void> {
  p.mount(24, 6)
  await p.paint('the alternate screen the launcher holds is taken over', alt(p, lines(p, ['taken over'])), 100)
  await p.paint('a cell changes', alt(p, lines(p, ['taken 0ver'])))
  await p.step('a takeover is armed by hand', () => p.ink.armAltScreenTakeover())
  await p.paint('a cell changes after it', alt(p, lines(p, ['taken over'])))
  await p.end()
}

async function resizeBetweenFrames(p: Play): Promise<void> {
  p.mount(24, 6)
  const tree = alt(p, lines(p, ['a line that is long enough to wrap', 'second'], { width: '100%' }))
  await p.step('the alternate screen is given, and the terminal moves to 26 by 6 before the first paint', () => {
    p.show(tree)
    p.out.resizes(26, 6)
  })
  await p.wait(120)
  await p.wait(100)
  await p.step('the terminal moves back to 24 by 6', () => p.out.resizes(24, 6))
  await p.wait(120)
  await p.wait(16)
  await p.step('the terminal grows to 30 by 8', () => p.out.resizes(30, 8))
  await p.step('a frame is asked for while the size settles', () => p.ink.onRender())
  await p.step('a tree is given while the size settles', () => p.show(tree))
  await p.wait(119)
  await p.wait(1)
  await p.wait(16)
  await p.step('the terminal shrinks to 16 by 4', () => p.out.resizes(16, 4))
  await p.wait(120)
  await p.wait(16)
  await p.step('the terminal moves to 20 by 5', () => p.out.resizes(20, 5))
  await p.wait(60)
  await p.step('and to 24 by 6 before the first has settled', () => p.out.resizes(24, 6))
  await p.wait(60)
  await p.wait(60)
  await p.wait(16)
  await p.step('a resize is announced at the same size', () => p.out.emit('resize'))
  await p.step('the frame loop is paused, and the terminal moves to 28 by 7', () => {
    p.ink.pause()
    p.out.resizes(28, 7)
  })
  await p.wait(120)
  await p.step('the frame loop is resumed at the new size', () => p.ink.resume())
  await p.wait(16)
  await p.step('the terminal grows, and the tree is unmounted before it settles', () => p.out.resizes(40, 10))
  await p.end()
  await p.step('the terminal resizes after the unmount', () => p.out.resizes(50, 12))
  await p.wait(200)
}

async function resizeOnTheMainScreen(p: Play): Promise<void> {
  p.mount(24, 6)
  const tree = lines(p, ['a line that is long enough to wrap', 'second'])
  await p.paint('two lines on the main screen', tree, 100)
  await p.step('the terminal shrinks to 12 by 6', () => p.out.resizes(12, 6))
  await p.wait(120)
  await p.wait(16)
  await p.step('the terminal grows to 40 by 10', () => p.out.resizes(40, 10))
  await p.wait(120)
  await p.wait(16)
  await p.step('the size changes with no announcement and a tree is given', () => {
    p.out.becomes(20, 6)
    p.show(tree)
  })
  await p.wait(16)
  await p.end()
}

async function resizeDuringAFrame(p: Play): Promise<void> {
  p.mount(24, 6)
  const tree = (words: string): ReactNode => alt(p, lines(p, [words, 'second'], { width: '100%' }))
  await p.paint('the alternate screen is painted', tree('first'), 100)
  await p.step('the terminal grows to 30 by 8 while the next frame is being written', () => {
    p.out.onWrite = () => {
      p.out.onWrite = null
      p.out.resizes(30, 8)
      p.ink.onRender()
    }
    p.show(tree('written during the resize'))
  })
  await p.wait(16)
  await p.wait(120)
  await p.paint('the next tree is the first to see the new size', tree('after'))
  await p.step('the terminal shrinks to 18 by 5 with no announcement, and a frame is asked for', () => {
    p.out.becomes(18, 5)
    p.ink.onRender()
  })
  await p.wait(16)
  await p.end()
}

function AsksForAFrameInItsEffect({ p, turn }: { p: Play; turn: number }): ReactNode {
  p.the.React.useLayoutEffect(() => {
    if (turn === 0) return
    p.out.becomes(30, 8)
    p.ink.onRender()
  }, [turn])
  return p.h(p.the.Text, null, `turn ${turn}`)
}

async function resizeSeenInsideACommit(p: Play): Promise<void> {
  p.mount(24, 6)
  await p.paint('the alternate screen is painted', alt(p, p.h(AsksForAFrameInItsEffect, { p, turn: 0 })), 100)
  await p.step('a component asks for a frame from inside its commit, after the size has changed', () => p.show(alt(p, p.h(AsksForAFrameInItsEffect, { p, turn: 1 }))))
  await p.wait(16)
  await p.end()
}

async function windowSignal(p: Play): Promise<void> {
  p.mount(24, 6)
  const tree = alt(p, lines(p, ['window', 'signal']))
  await p.paint('the alternate screen is painted', tree, 100)
  await p.step('the window signal comes with the size unchanged, at once after a whole frame', () => process.emit('SIGWINCH'))
  await p.step('and again before the wait is over', () => process.emit('SIGWINCH'))
  await p.wait(249)
  await p.wait(1)
  await p.wait(16)
  await p.wait(300)
  await p.step('the window signal comes long after', () => process.emit('SIGWINCH'))
  await p.wait(16)
  await p.step('the window signal comes with a new size the stream had not announced', () => {
    p.out.windowSize = [30, 8]
    process.emit('SIGWINCH')
  })
  await p.step('and again while that size settles', () => process.emit('SIGWINCH'))
  await p.wait(120)
  await p.wait(16)
  await p.step('the screen is asked to overwrite itself by hand, twice', () => {
    p.ink.overwriteScreen()
    p.ink.overwriteScreen()
  })
  await p.wait(250)
  await p.wait(16)
  await p.step('the window signal comes when the stream already holds a size the screen has not seen', () => {
    p.out.becomes(28, 7)
    process.emit('SIGWINCH')
  })
  await p.paint('a tree is the first to see it', tree)
  await p.end()
  await p.step('the window signal comes after the unmount', () => {
    process.emit('SIGWINCH')
    p.ink.overwriteScreen()
  })
}

async function oldWindowsConsole(p: Play): Promise<void> {
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!
  const asWindows = (): void => void Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  asWindows()
  try {
    p.mount(24, 6)
    Object.defineProperty(process, 'platform', real)
    p.keys.holdsConsoleRead()
    const tree = (words: string): ReactNode => alt(p, p.h(p.the.Box, { flexDirection: 'column', width: '100%' }, p.h(Listens, { p }), p.h(p.the.Text, null, words)))
    await p.paint('the alternate screen is painted on a console that draws nothing atomically', tree('console'), 100)
    asWindows()
    await p.wait(250)
    await p.step('the window is maximized to 40 by 10, its buffer following', () => p.out.resizes(40, 10))
    await p.wait(120)
    await p.wait(16)
    await p.step('a tree is the first to see a restored window of 24 by 6', () => {
      p.out.becomes(24, 6)
      p.show(tree('restored'))
    })
    await p.wait(16)
    await p.wait(120)
    await p.wait(16)
    await p.wait(5000)
    await p.step('the console can no longer say its size, and the five seconds come again', () => {
      ;(p.out as unknown as { _refreshSize: unknown })._refreshSize = undefined
      p.out.becomes(30, 8)
    })
    await p.wait(5000)
    await p.wait(120)
    await p.wait(16)
    await p.step('the keys are lent to a child while the console reads', () => p.ink.suspendStdin())
    await p.step('and taken back', () => p.ink.resumeStdin())
    await p.step('the keys are drained by hand', () => p.ink.drainStdin())
    await p.end()
    await p.wait(5000)
  } finally {
    Object.defineProperty(process, 'platform', real)
  }
}

async function scrollRegion(p: Play): Promise<void> {
  p.mount(24, 8)
  let handle: ScrollBoxHandle | null = null
  const rows = Array.from({ length: 14 }, (_, index) => `row ${String(index + 1).padStart(2, '0')}`)
  const changes: string[] = []
  const tree = (texts: readonly string[]): ReactNode =>
    alt(
      p,
      p.h(
        p.the.Box,
        { flexDirection: 'column', height: 8, width: '100%' },
        p.h(Listens, { p }),
        p.h(p.the.Text, null, 'head'),
        p.h(p.the.ScrollBox, { ref: (value: ScrollBoxHandle | null) => void (handle = value), height: 5, flexDirection: 'column' }, ...texts.map((text, index) => p.h(p.the.Text, { key: index }, text))),
        p.h(p.the.Text, null, 'foot'),
      ),
      true,
    )
  p.ink.subscribeToSelectionChange(() => changes.push(selectionWords(p.ink)))
  const said = (): void => {
    for (const change of changes.splice(0)) note(`  the selection's listeners hear: ${change}`)
    note(`  the pane stands at ${handle!.getScrollTop()} of ${handle!.getScrollHeight()} with ${handle!.getPendingDelta()} to come`)
  }
  await p.paint('a pane of five rows over fourteen is painted', tree(rows), 100)
  await p.wait(250)
  await p.step('the pane scrolls by two', () => handle!.scrollBy(2))
  await p.wait(16)
  await p.wait(4)
  said()
  await p.step('the pane scrolls by nine at once', () => handle!.scrollBy(9))
  for (let turn = 0; turn < 6; turn++) await p.wait(4)
  said()
  await p.step('the pane scrolls back by three', () => handle!.scrollBy(-3))
  for (let turn = 0; turn < 4; turn++) await p.wait(4)
  said()
  await p.wait(600)
  await p.step('rows three and four of the pane are selected', () => {
    p.press(1, 3)
    p.drag(5, 4)
    p.release(5, 4)
  })
  said()
  await p.step('the pane scrolls by one under the selection', () => handle!.scrollBy(1))
  for (let turn = 0; turn < 4; turn++) await p.wait(4)
  said()
  await p.step('the pane scrolls back by seven, and the selection leaves it', () => handle!.scrollBy(-7))
  for (let turn = 0; turn < 6; turn++) await p.wait(4)
  said()
  await p.wait(600)
  await p.step('a press holds a drag in the pane while it scrolls by two', () => {
    p.press(1, 3)
    p.drag(4, 4)
    handle!.scrollBy(2)
  })
  for (let turn = 0; turn < 4; turn++) await p.wait(4)
  said()
  await p.step('the drag goes on after the scroll', () => p.drag(6, 5))
  said()
  await p.step('the button is let go', () => p.release(6, 5))
  said()
  await p.step('the selection is copied, with the rows that scrolled away', () => note(`  copied: ${escaped(JSON.stringify(p.ink.copySelection()))}`))
  said()
  await p.step('the pane jumps to the top', () => handle!.scrollTo(0))
  for (let turn = 0; turn < 4; turn++) await p.wait(4)
  said()
  await p.step('a row is added while the pane rests', () => p.show(tree([...rows, 'row 15'])))
  await p.wait(16)
  said()
  await p.end()
}

async function declaredCursor(p: Play, onAlt: boolean): Promise<void> {
  p.mount(24, 6)
  const frame = (child: ReactNode): ReactNode => (onAlt ? alt(p, child) : child)
  const tree = (column: number, active: boolean, second = false): ReactNode =>
    frame(
      p.h(
        p.the.Box,
        { flexDirection: 'column' },
        p.h(p.the.Text, null, 'above'),
        p.h(Field, { p, line: 0, column, active, label: 'field one' }),
        second ? p.h(Field, { p, line: 0, column: 2, active: false, label: 'field two' }) : null,
      ),
    )
  await p.paint('a field that declares nothing is painted', tree(3, false), 100)
  await p.paint('the field declares the cursor at its fourth cell', tree(3, true))
  await p.paint('the cursor moves two cells with nothing else changed', tree(5, true))
  await p.paint('a second field that declares nothing mounts', tree(5, true, true))
  await p.paint('the text changes while the cursor stays', frame(p.h(p.the.Box, { flexDirection: 'column' }, p.h(p.the.Text, null, 'ABOVE'), p.h(Field, { p, line: 0, column: 5, active: true, label: 'field one' }))))
  await p.paint('the field declares the cursor far beyond the right edge', tree(99, true))
  await p.paint('the field gives the cursor up', tree(5, false))
  await p.paint('and takes it again', tree(1, true))
  await p.paint('the field is hidden, and still declares', frame(p.h(p.the.Box, { flexDirection: 'column' }, p.h(p.the.Text, null, 'above'), p.h(p.the.Box, { display: 'none' }, p.h(Field, { p, line: 0, column: 1, active: true, label: 'field one' })))))
  await p.paint('the field leaves the tree', frame(lines(p, ['above'])))
  await p.end()
}

function pointerTree(p: Play, withLinks: boolean): ReactNode {
  const { Box, Text, Link, NoSelect } = p.the
  const box = (name: string, extra: Record<string, unknown> = {}, ...children: unknown[]): ReactNode =>
    p.h(
      Box,
      {
        width: 8,
        tabIndex: 0,
        onClick: (event: { localCol: number; localRow: number; cellIsBlank: boolean }) => note(`  ${name} is clicked at ${event.localCol},${event.localRow} of its own, on blank=${yn(event.cellIsBlank)}`),
        onMouseEnter: () => note(`  the pointer enters ${name}`),
        onMouseLeave: () => note(`  the pointer leaves ${name}`),
        onKeyDown: (event: { key: string; shift: boolean; ctrl: boolean; meta: boolean; preventDefault: () => void }) => {
          note(`  ${name} takes the key ${escaped(JSON.stringify(event.key))}${event.shift ? ' with shift' : ''}${event.ctrl ? ' with control' : ''}${event.meta ? ' with alt' : ''}`)
          if (event.key === 'tab' && !event.shift && name === 'the stubborn box') event.preventDefault()
        },
        onFocus: () => note(`  ${name} is focused`),
        onBlur: () => note(`  ${name} loses the focus`),
        ...extra,
      },
      ...(children.length > 0 ? children : [p.h(Text, null, name.slice(-1).toUpperCase())]),
    )
  return alt(
    p,
    p.h(
      Box,
      { flexDirection: 'column', width: '100%' },
      p.h(Listens, { p }),
      p.h(Box, { flexDirection: 'row' }, box('box a'), box('box b'), box('the stubborn box', { justifyContent: 'space-between' }, p.h(Text, { key: 'l' }, 'L'), p.h(Text, { key: 'r' }, 'R'))),
      p.h(Text, null, 'see https://example.test/a now'),
      withLinks ? p.h(Link, { url: 'https://example.test/linked' }, 'docs \u4e16\u754c') : p.h(Text, null, 'no link here'),
      p.h(NoSelect, null, p.h(Text, null, 'not for selecting')),
      p.h(Text, null, '\u4e16\u754c plain'),
    ),
    true,
  )
}

async function pointerAndKeys(p: Play): Promise<void> {
  p.mount(40, 6)
  await p.paint('boxes, a plain address, a link and a strip that is not selected', pointerTree(p, true), 100)
  await p.wait(250)
  await p.step('the key a is typed with nothing focused', () => p.keys.sends('a'))
  await p.step('tab is typed', () => p.keys.sends('\t'))
  await p.step('the key b is typed', () => p.keys.sends('b'))
  await p.step('tab again', () => p.keys.sends('\t'))
  await p.step('shift and tab', () => p.keys.sends('\u001b[Z'))
  await p.step('tab with the control key, and tab with the alt key', () => {
    p.keys.sends('\u001b[9;5u')
    p.keys.sends('\u001b[9;3u')
  })
  await p.step('tab twice, to the stubborn box', () => {
    p.keys.sends('\t')
    p.keys.sends('\t')
  })
  await p.step('tab once more, which the stubborn box keeps', () => p.keys.sends('\t'))
  await p.step('shift and tab leave it', () => p.keys.sends('\u001b[Z'))
  await p.step('a click lands on box a', () => p.click(0, 0))
  await p.wait(600)
  await p.step('a click lands on the blank of box b', () => p.click(12, 0))
  await p.wait(600)
  await p.step('a click lands in the gap between the two letters of the stubborn box', () => p.click(19, 0))
  await p.wait(600)
  await p.step('a click lands on the plain address', () => p.click(8, 1))
  await p.wait(499)
  await p.wait(1)
  await p.step('a click lands on the link', () => p.click(1, 2))
  await p.wait(500)
  await p.step('a click lands on the second cell of a wide letter of the link', () => p.click(6, 2))
  await p.wait(500)
  await p.step('a click lands where nothing is', () => p.click(30, 5))
  await p.wait(500)
  await p.step('two clicks land on the link before it opens', () => {
    p.click(1, 2)
    p.click(1, 2)
  })
  await p.wait(600)
  await p.step('the link has no opener, and a click lands on it', () => {
    p.ink.onHyperlinkClick = undefined
    p.click(1, 2)
  })
  await p.wait(500)
  await p.step('the pointer moves over the letter of box a', () => p.hover(0, 0))
  await p.step('over its blank', () => p.hover(1, 0))
  await p.step('to box b', () => p.hover(9, 0))
  await p.step('within box b', () => p.hover(10, 0))
  await p.step('to the address', () => p.hover(5, 1))
  await p.step('to the strip that is not selected', () => p.hover(2, 3))
  await p.step('to an empty cell', () => p.hover(30, 5))
  await p.step('outside the screen', () => p.ink.dispatchHover(-1, 99))
  await p.step('the doors are asked about cells by hand', () => {
    note(`  a link outside the screen: ${String(p.ink.getHyperlinkAt(99, 99))}; on the second cell of a wide letter that is no link: ${String(p.ink.getHyperlinkAt(1, 4))}; on the address: ${String(p.ink.getHyperlinkAt(8, 1))}`)
    note(`  a click outside the screen finds ${yn(p.ink.dispatchClick(99, 99))}`)
  })
  await p.step('the wheel turns down three notches as the terminal reports it', () => p.keys.sends(sgr(65, 3, 3) + sgr(65, 3, 3) + sgr(65, 3, 3)))
  await p.step('mouse tracking is switched off', () => p.ink.setMouseTrackingEnabled(false))
  await p.step('and off again', () => p.ink.setMouseTrackingEnabled(false))
  await p.step('and on', () => p.ink.setMouseTrackingEnabled(true))
  await p.step('the pointer moves over the address, and tracking is switched off', () => {
    p.hover(5, 1)
    p.ink.setMouseTrackingEnabled(false)
  })
  await p.step('tracking is switched on, the pointer moves along the address, and the alternate screen is left', () => {
    p.ink.setMouseTrackingEnabled(true)
    p.hover(6, 1)
    p.show(lines(p, ['on the main screen']))
  })
  await p.wait(16)
  await p.end()
  await p.step('mouse tracking is switched on after the unmount', () => p.ink.setMouseTrackingEnabled(true))
}

async function pointerOnAPlainTerminal(p: Play): Promise<void> {
  p.mount(40, 6)
  await p.step('mouse tracking is refused before any screen', () => p.ink.setMouseTrackingEnabled(false))
  await p.paint('the screen of boxes is painted, with tracking asked for and refused', pointerTree(p, false), 100)
  await p.wait(250)
  await p.step('a click lands on box a', () => p.click(0, 0))
  await p.wait(600)
  await p.step('a click lands on the plain address', () => p.click(8, 1))
  await p.wait(500)
  await p.step('the pointer moves over box a and off', () => {
    p.hover(0, 0)
    p.hover(30, 5)
  })
  await p.step('mouse tracking is switched on', () => p.ink.setMouseTrackingEnabled(true))
  await p.step('the wheel turns up as the terminal reports it', () => p.keys.sends(sgr(64, 3, 3)))
  await p.end()
}

async function selection(p: Play): Promise<void> {
  p.mount(40, 6)
  const { Box, Text } = p.the
  const gestures: string[] = []
  const claims = { value: true }
  const tree = alt(
    p,
    p.h(
      Box,
      { flexDirection: 'column', width: '100%' },
      p.h(Listens, { p }),
      p.h(Text, null, 'the quick brown fox'),
      p.h(Text, null, 'jumps over the lazy dog'),
      p.h(Box, { height: 1 }),
      p.h(
        Box,
        {
          onTextGesture: (gesture: { kind: string; localCol: number; localRow: number; clickCount: number }) => {
            gestures.push(`${gesture.kind} at ${gesture.localCol},${gesture.localRow} count ${gesture.clickCount}`)
            return claims.value
          },
        },
        p.h(Text, null, 'a field that takes text gestures'),
      ),
      p.h(Text, null, 'last row'),
    ),
    true,
  )
  const heard: string[] = []
  const stop = p.ink.subscribeToSelectionChange(() => heard.push(selectionWords(p.ink)))
  const said = (): void => {
    for (const change of heard.splice(0)) note(`  the selection's listeners hear: ${change}`)
    for (const gesture of gestures.splice(0)) note(`  the field's handler hears: ${gesture}`)
  }
  await p.paint('five rows of text are painted', tree, 100)
  await p.wait(250)
  await p.step('a press at the fifth cell of the first row', () => p.press(4, 0))
  said()
  await p.step('a drag to the same cell', () => p.drag(4, 0))
  said()
  await p.step('a drag along the row', () => p.drag(8, 0))
  said()
  await p.step('two drags in one read: only the last is taken', () => p.keys.sends(sgr(32, 9, 0) + sgr(32, 3, 1)))
  said()
  await p.step('the same drag again', () => p.drag(3, 1))
  said()
  await p.step('the button is let go', () => p.release(3, 1))
  said()
  await p.step('the selection is copied and kept', () => note(`  copied: ${escaped(JSON.stringify(p.ink.copySelectionNoClear()))}`))
  await p.step('the focus of the selection is moved every way', () => {
    for (const move of ['left', 'right', 'up', 'down', 'lineStart', 'left', 'lineEnd', 'right', 'down', 'down', 'down', 'down', 'down', 'lineEnd', 'right', 'up', 'up', 'up', 'up', 'up', 'up', 'lineStart', 'left'] as const) {
      p.ink.moveSelectionFocus(move)
      note(`  ${move}: focus=${at(p.ink.selection.focus)}`)
    }
  })
  said()
  await p.step('the selection is copied and cleared', () => note(`  copied: ${escaped(JSON.stringify(p.ink.copySelection()))}`))
  said()
  await p.step('a copy with nothing selected', () => note(`  copied: ${escaped(JSON.stringify(p.ink.copySelection()))} and ${escaped(JSON.stringify(p.ink.copySelectionNoClear()))}`))
  await p.step('the focus is moved with nothing selected, and the selection cleared', () => {
    p.ink.moveSelectionFocus('left')
    p.ink.clearTextSelection()
  })
  await p.step('a text is copied by hand, and an empty one', () => {
    p.ink.copyText('copied by hand')
    p.ink.copyText('')
  })
  await p.wait(600)
  await p.step('two presses on a word', () => {
    p.click(5, 0)
    p.press(5, 0)
  })
  said()
  await p.step('a drag from the word to the next row', () => p.drag(8, 1))
  said()
  await p.step('the button is let go', () => p.release(8, 1))
  said()
  await p.wait(600)
  await p.step('three presses on the second row', () => {
    p.click(2, 1)
    p.click(2, 1)
    p.press(2, 1)
  })
  said()
  await p.step('the button is let go', () => p.release(2, 1))
  said()
  await p.wait(600)
  await p.step('two presses on the empty row', () => {
    p.click(10, 2)
    p.press(10, 2)
  })
  said()
  await p.step('the button is let go', () => p.release(10, 2))
  said()
  await p.wait(600)
  await p.step('the colour of the selection is set', () => p.ink.setSelectionBgColor('#3366cc'))
  await p.wait(600)
  await p.step('a press and a drag under the new colour', () => {
    p.press(0, 4)
    p.drag(3, 4)
  })
  said()
  await p.step('the colour is set to a word that is no colour', () => p.ink.setSelectionBgColor('no colour at all'))
  await p.step('a drag under no colour', () => p.drag(5, 4))
  said()
  await p.step('the colour is set again', () => p.ink.setSelectionBgColor('ansi:blue'))
  await p.step('the terminal loses the focus during the drag', () => p.keys.sends('\u001b[O'))
  said()
  await p.step('and has it again', () => p.keys.sends('\u001b[I'))
  await p.wait(300)
  await p.step('a press with the alt key held', () => {
    p.press(1, 0, true)
    p.release(1, 0)
  })
  said()
  await p.wait(600)
  await p.step('a press on the field, which takes it', () => p.press(3, 3))
  said()
  await p.step('a drag on the field', () => p.drag(6, 3))
  said()
  await p.step('the button is let go on the field', () => p.release(6, 3))
  said()
  await p.wait(600)
  await p.step('a selection stands, and a press on the field takes it away', () => {
    p.press(0, 0)
    p.drag(4, 0)
    p.release(4, 0)
    p.press(3, 3)
    p.release(3, 3)
  })
  said()
  await p.wait(600)
  await p.step('two presses on the field, which takes them', () => {
    p.click(2, 3)
    p.click(2, 3)
  })
  said()
  await p.wait(600)
  await p.wait(600)
  await p.step('the field stops taking gestures, and a press lands on it', () => {
    claims.value = false
    p.press(3, 3)
    p.drag(7, 3)
    p.release(7, 3)
  })
  said()
  await p.wait(600)
  await p.step('a press and a release beyond the screen', () => {
    p.press(60, 20)
    p.release(60, 20)
  })
  said()
  await p.wait(600)
  await p.step('two presses beyond the screen', () => {
    p.click(60, 20)
    p.press(60, 20)
    p.release(60, 20)
  })
  said()
  await p.wait(600)
  await p.step('the blank end of a row is selected, copied and kept, and its focus moved a way no key names', () => {
    p.press(30, 4)
    p.drag(35, 4)
    p.release(35, 4)
    note(`  copied: ${escaped(JSON.stringify(p.ink.copySelectionNoClear()))}`)
    p.ink.moveSelectionFocus('sideways' as never)
  })
  said()
  await p.step('the listener leaves, and the selection is cleared', () => {
    stop()
    p.ink.clearTextSelection()
  })
  said()
  await p.end()
}

async function searchHighlight(p: Play): Promise<void> {
  p.mount(24, 6)
  let pane: DOMElement | null = null
  const tree = alt(
    p,
    p.h(
      p.the.Box,
      { flexDirection: 'column', width: '100%' },
      p.h(p.the.Text, null, 'hello yellow fellow'),
      p.h(p.the.Box, { ref: (value: DOMElement | null) => void (pane = value), flexDirection: 'column' }, p.h(p.the.Text, null, 'mellow cello'), p.h(p.the.Text, null, 'no match')),
      p.h(p.the.Text, null, 'bellow'),
    ),
  )
  await p.step('a scan is asked for before any screen and any query', () => note(`  found ${p.ink.scanElementSubtree({} as DOMElement).length}`))
  await p.paint('four rows are painted', tree, 100)
  await p.step('the query "ello" is set', () => p.ink.setSearchHighlight('ello'))
  await p.wait(16)
  await p.step('the same query is set again', () => p.ink.setSearchHighlight('ello'))
  await p.wait(16)
  await p.step('the pane is scanned for the query', () => {
    const found = p.ink.scanElementSubtree(pane!)
    note(`  found ${JSON.stringify(found)}`)
    p.ink.setSearchPositions({ positions: found, rowOffset: 1, colOffset: 0, currentIdx: 1 })
  })
  await p.wait(16)
  await p.step('the current match moves', () => p.ink.setSearchPositions({ positions: p.ink.scanElementSubtree(pane!), rowOffset: 1, colOffset: 0, currentIdx: 0 }))
  await p.wait(16)
  await p.paint('a row changes under the highlight', alt(p, lines(p, ['hello yellow fellow', 'jello', 'bellow'], { width: '100%' })))
  await p.step('an element with no layout and one of no size are scanned', () => {
    note(`  found ${p.ink.scanElementSubtree({} as DOMElement).length} and ${p.ink.scanElementSubtree({ layoutNode: { getComputedWidth: () => 0, getComputedHeight: () => 3 } } as unknown as DOMElement).length}`)
  })
  await p.step('the positions are dropped', () => p.ink.setSearchPositions(null))
  await p.wait(16)
  await p.step('the query is emptied', () => p.ink.setSearchHighlight(''))
  await p.wait(16)
  await p.end()
}

async function renderFaults(p: Play, onAlt: boolean): Promise<void> {
  p.mount(24, 6)
  let turn = 0
  const tree = (words: string): ReactNode => (onAlt ? alt(p, lines(p, [words, 'steady'])) : lines(p, [words, 'steady']))
  const refusal = (): Error => new Error('the terminal refuses the frame')
  const frames = async (count: number): Promise<void> => {
    for (let at = 0; at < count; at++) {
      if (!onAlt) p.show(tree(`changed ${++turn}`))
      await p.wait(16)
    }
  }
  await p.paint('two lines are painted', tree('first'), 100)
  await p.step('the terminal refuses the next frame once', () => {
    p.out.failures.push(refusal())
    p.show(tree('second'))
  })
  await frames(3)
  await p.step('the terminal refuses four frames in a row', () => {
    p.out.failures.push(refusal(), refusal(), refusal(), refusal())
    p.show(tree('third'))
  })
  await frames(6)
  await p.paint('a tree is given after the loud fault', tree('fourth'))
  await p.step('three refusals, a frame that lands, and three more: the count starts again', () => {
    p.out.failures.push(refusal(), refusal(), refusal())
    p.show(tree('fifth'))
  })
  await frames(5)
  await p.step('three more', () => {
    p.out.failures.push(refusal(), refusal(), refusal())
    p.show(tree('sixth'))
  })
  await frames(5)
  await p.step('the one who listens to frames throws after the frame is written', () => {
    p.frameHook = () => {
      p.frameHook = null
      throw new Error('the frame listener of the options throws')
    }
    p.show(tree('seventh'))
  })
  await frames(2)
  await p.step('a fault that is no error object, thrown by a frame asked for by hand', () => {
    p.frameHook = () => {
      p.frameHook = null
      throw 'a bare string'
    }
    p.ink.forceRedraw()
  })
  await frames(1)
  note(`  the terminal still holds ${p.out.failures.length} refusals`)
  await p.end()
}

async function editorHandover(p: Play, onAlt: boolean): Promise<void> {
  p.mount(24, 6)
  const body = (words: string): ReactNode => p.h(p.the.Box, { flexDirection: 'column' }, p.h(Listens, { p }), p.h(p.the.Text, null, words))
  const tree = (words: string): ReactNode => (onAlt ? alt(p, body(words), true) : body(words))
  await p.step('the terminal queries are awaited before any were sent', async () => {
    await p.ink.awaitTerminalQueries()
  })
  await p.paint('a screen that listens to keys is painted', tree('before the editor'), 100)
  await p.step('the terminal is handed to an editor while its queries are unanswered', () => p.ink.enterAlternateScreen())
  await p.step('a tree is given, a redraw forced and the modes asked for while the editor has it', () => {
    p.show(tree('changed under the editor'))
    p.ink.forceRedraw()
    p.ink.repaintAltScreen()
    p.ink.reassertTerminalModes(true)
    p.ink.onRender()
  })
  await p.wait(300)
  await p.step('the editor ends', () => p.ink.exitAlternateScreen())
  await p.wait(16)
  await p.step('the terminal queries are awaited after they settled', async () => {
    await p.ink.awaitTerminalQueries()
  })
  await p.wait(5000)
  await p.step('a key comes after five quiet seconds', () => p.keys.sends('k'))
  await p.wait(16)
  await p.step('and another at once after it', () => p.keys.sends('l'))
  await p.step('the editor is entered twice', () => {
    p.ink.enterAlternateScreen()
    p.ink.enterAlternateScreen()
  })
  await p.step('and left once', () => p.ink.exitAlternateScreen())
  await p.step('and left again', () => p.ink.exitAlternateScreen())
  await p.wait(16)
  await p.step('and left a third time, with nothing entered', () => p.ink.exitAlternateScreen())
  await p.wait(16)
  await p.step('the frame loop is paused and a tree given', () => {
    p.ink.pause()
    p.show(tree('given while paused'))
  })
  await p.wait(16)
  await p.step('the frame loop is resumed', () => p.ink.resume())
  await p.step('the keys are lent and taken back', () => {
    p.ink.suspendStdin()
    p.ink.resumeStdin()
  })
  await p.wait(16)
  await p.step('the keys are taken back with nothing lent', () => p.ink.resumeStdin())
  await p.wait(16)
  await p.step('the modes are asserted again, without and with the alternate screen', () => {
    p.ink.reassertTerminalModes()
    p.ink.reassertTerminalModes(true)
  })
  await p.wait(16)
  await p.step('the screen state is asserted again without a repaint', () => p.ink.reassertScreenState('asked by the scene', { repaint: false }))
  await p.wait(16)
  await p.step('the terminal stops taking writes, and the modes are asked for', () => {
    p.out.destroyed = true
    p.ink.reassertTerminalModes(true)
    p.out.destroyed = false
  })
  await p.end()
  await p.step('the doors are tried after the unmount', () => {
    p.ink.reassertScreenState('after the unmount')
    p.ink.reassertTerminalModes(true)
    p.ink.forceRedraw()
    p.ink.repaintAltScreen()
  })
}

async function queriesAwaited(p: Play): Promise<void> {
  p.mount(30, 10)
  const tree = alt(p, p.h(p.the.Box, { flexDirection: 'column' }, p.h(Listens, { p }), p.h(p.the.Text, null, 'asks the terminal')), true)
  await p.step('a screen that listens to keys is given', () => p.show(tree))
  await p.step('the queries are awaited, and the terminal never answers', async () => {
    const waited = p.ink.awaitTerminalQueries().then(() => note('  the wait for the queries is over'))
    await advance(100)
    await advance(64)
    await advance(100)
    await waited
  })
  await p.wait(300)
  await p.end()
}

async function queriesAnswered(p: Play): Promise<void> {
  p.mount(30, 10)
  const tree = alt(p, p.h(p.the.Box, { flexDirection: 'column' }, p.h(Listens, { p }), p.h(p.the.Text, null, 'asks the terminal')), true)
  await p.step('a screen that listens to keys is given', () => p.show(tree))
  await p.wait(100)
  await p.wait(16)
  await p.step('the terminal says it draws atomically, speaks the extended keys, and names itself', () => p.keys.sends('\u001bP>|scripted 1.0\u001b\\\u001b[?2026;2$y\u001b[?1u\u001b[?62;4c'))
  await p.wait(16)
  await p.step('the terminal answers the width questions', () => p.keys.sends('\u001b[2;3R\u001b[3;3R\u001b[4;3R\u001b[5;3R\u001b[6;2R\u001b[7;1R\u001b[8;2R\u001b[9;2R\u001b[?62;4c'))
  await p.wait(250)
  await p.paint('a line is added', alt(p, p.h(p.the.Box, { flexDirection: 'column' }, p.h(Listens, { p }), p.h(p.the.Text, null, 'asks the terminal'), p.h(p.the.Text, null, 'and is answered')), true))
  await p.end()
}

const STOPS: Record<string, string> = { SIGTSTP: 'the stop of the foreground', SIGTTIN: 'the stop of a background read', SIGTTOU: 'the stop of a background write' }

async function stopAndContinue(p: Play, onAlt: boolean): Promise<void> {
  const kill = process.kill
  process.kill = ((pid: number, signal?: string | number) => {
    note(`  the process sends ${pid === process.pid ? 'itself' : 'another process'} ${STOPS[String(signal)] ?? 'another signal'}`)
    return true
  }) as typeof process.kill
  try {
    p.mount(24, 6)
    const body = (words: string): ReactNode => p.h(p.the.Box, { flexDirection: 'column' }, p.h(Listens, { p }), p.h(p.the.Text, null, words))
    const tree = (words: string): ReactNode => (onAlt ? alt(p, body(words), true) : body(words))
    await p.paint('a screen that listens to keys is painted', tree('running'), 100)
    await p.wait(250)
    await p.step('the continue comes with nothing stopped', () => process.emit('SIGCONT'))
    await p.wait(16)
    await p.step('the stop of the foreground comes', () => process.emit('SIGTSTP', 'SIGTSTP'))
    await p.step('a signal that is no stop reaches the same listener', () => process.emit('SIGTSTP', 'SIGHUP'))
    await p.step('the continue comes', () => process.emit('SIGCONT'))
    await p.wait(16)
    await p.step('the stop of a background read comes', () => process.emit('SIGTTIN', 'SIGTTIN'))
    await p.step('the continue comes while the terminal takes no writes', () => {
      p.out.destroyed = true
      process.emit('SIGCONT')
      p.out.destroyed = false
    })
    await p.wait(16)
    await p.step('the stop of a background write comes, and the continue', () => {
      process.emit('SIGTTOU', 'SIGTTOU')
      process.emit('SIGCONT')
    })
    await p.wait(16)
    await p.step('the stop of the foreground comes where raw mode cannot be given up', () => {
      const setRawMode = p.keys.setRawMode
      p.keys.setRawMode = () => {
        throw new Error('raw mode is not this stream\'s to change')
      }
      process.emit('SIGTSTP', 'SIGTSTP')
      p.keys.setRawMode = setRawMode
    })
    await p.step('the continue comes', () => process.emit('SIGCONT'))
    await p.wait(16)
    await p.step('the stop of the foreground comes where the process cannot signal itself', () => {
      const stubbed = process.kill
      process.kill = (() => {
        throw new Error('the process may not signal itself')
      }) as typeof process.kill
      process.emit('SIGTSTP', 'SIGTSTP')
      process.kill = stubbed
    })
    await p.step('the continue comes where raw mode cannot be taken again', () => {
      const setRawMode = p.keys.setRawMode
      p.keys.setRawMode = () => {
        throw new Error('raw mode is not this stream\'s to change')
      }
      process.emit('SIGCONT')
      p.keys.setRawMode = setRawMode
    })
    await p.wait(16)
    await p.end()
    await p.step('the stop and the continue come after the unmount', () => {
      process.emit('SIGTSTP', 'SIGTSTP')
      process.emit('SIGCONT')
    })
  } finally {
    process.kill = kill
  }
}

async function stdinRecovery(p: Play): Promise<void> {
  p.mount(24, 6)
  const tree = p.h(p.the.Box, { flexDirection: 'column' }, p.h(Listens, { p }), p.h(p.the.Text, null, 'reads keys'))
  await p.paint('a screen that listens to keys is painted', tree, 100)
  await p.wait(250)
  await p.step('the reader faults while raw mode is still on', () => p.ink.recoverStdin('EIO', 'read'))
  await p.step('and faults again before the first is mended', () => p.ink.recoverStdin('EIO', 'read'))
  await p.wait(50)
  await p.step('the reader faults and raw mode is off', () => {
    p.keys.isRaw = false
    p.ink.recoverStdin('EAGAIN', 'read')
  })
  await p.wait(50)
  await p.step('the reader faults and raw mode is refused twice', () => {
    p.keys.isRaw = false
    p.keys.rawRefusals = 2
    p.ink.recoverStdin('EIO', 'read')
  })
  await p.wait(50)
  await p.wait(50)
  await p.wait(50)
  await p.step('the reader faults and raw mode is refused every time', () => {
    p.keys.isRaw = false
    p.keys.rawRefusals = 99
    p.ink.recoverStdin('EIO', 'read')
  })
  for (let turn = 0; turn < 9; turn++) await p.wait(50)
  await p.step('the product\'s own fault door reaches this screen while the console is lent', () => {
    p.keys.rawRefusals = 0
    p.the.doors.registerProcessInputErrorHandler(
      code => note(`  the process hears its input is gone: ${code}`),
      (code, syscall) => note(`  the process hears a fault of the hand-over: ${syscall} ${code}`),
    )
    p.the.doors.markConsoleLent()
    process.stdin.emit('error', Object.assign(new Error('the read failed'), { code: 'EIO', syscall: 'read' }))
    p.the.doors.markConsoleReturned()
  })
  await p.wait(50)
  await p.step('the reader is destroyed by the hand-over, and a fresh one is opened', () => {
    p.keys.destroyed = true
    p.ink.recoverStdin('EBADF', 'read')
  })
  await p.wait(50)
  await p.step('the reader faults, and the screen is unmounted before the mend', () => {
    p.ink.recoverStdin('EIO', 'read')
    p.ink.unmount()
  })
  await p.wait(50)
  await p.step('the reader faults after the unmount, through the product\'s door and by hand', () => {
    p.the.doors.markConsoleLent()
    process.stdin.emit('error', Object.assign(new Error('the read failed'), { code: 'EIO', syscall: 'read' }))
    p.the.doors.markConsoleReturned()
    p.ink.recoverStdin('EIO', 'read')
  })
  await p.wait(600)
}

async function unmountAndExit(p: Play): Promise<void> {
  p.mount(24, 6)
  await p.paint('the alternate screen is painted', alt(p, p.h(p.the.Box, { flexDirection: 'column' }, p.h(Listens, { p }), p.h(p.the.Text, null, 'leaving')), true), 100)
  await p.wait(250)
  const first = p.ink.waitUntilExit()
  const second = p.ink.waitUntilExit()
  note(`  two waits for the exit before it are one promise: ${yn(first === second)}`)
  void first.then(
    () => note('  the wait for the exit is over'),
    error => note(`  the wait for the exit is refused: ${wordsOf(error)}`),
  )
  await p.step('the screen is unmounted', () => p.ink.unmount())
  await p.step('and unmounted again', () => p.ink.unmount())
  await p.step('the exit is awaited after it', async () => {
    await p.ink.waitUntilExit()
    note('  a wait after the exit is over at once')
  })
  await p.step('a tree is given, a frame asked for and the keys lent after the unmount', () => {
    p.show(lines(p, ['after the unmount']))
    p.ink.onRender()
    p.ink.repaint()
    p.ink.pause()
    p.ink.resume()
  })
  await p.wait(600)
}

async function unmountWithAnError(p: Play): Promise<void> {
  p.mount(24, 6)
  await p.paint('two lines on the main screen', lines(p, ['about', 'to fail']), 100)
  void p.ink.waitUntilExit().then(
    () => note('  the wait for the exit is over'),
    error => note(`  the wait for the exit is refused: ${wordsOf(error)}`),
  )
  await p.step('the screen is unmounted with an error', () => p.ink.unmount(new Error('the app failed')))
  await p.step('the exit is awaited after it', async () => {
    await p.ink.waitUntilExit().catch(error => note(`  a wait after the exit is refused at once: ${wordsOf(error)}`))
  })
  await p.wait(600)
  const second = p.mount(24, 6, { silentFrames: true, ttyIn: false })
  await p.paint('a second screen, whose frames nobody listens to and whose keys are no terminal, is painted', lines(p, ['second']), 100)
  await p.step('it is unmounted with an error before anything waits for its exit', () => second.unmount(new Error('the second app failed')))
  await p.step('its exit is awaited after it', async () => {
    await second.waitUntilExit().catch(error => note(`  a wait after the exit is refused at once: ${wordsOf(error)}`))
  })
  await p.wait(600)
}

async function noTree(p: Play): Promise<void> {
  p.mount(24, 6)
  await p.step('the terminal resizes before any tree is given', () => p.out.resizes(30, 8))
  await p.wait(120)
  await p.step('the size changes with no announcement, and a frame is asked for', () => {
    p.out.becomes(24, 6)
    p.ink.onRender()
  })
  await p.step('the reader is destroyed by a hand-over, and a fresh one is opened', () => {
    p.keys.destroyed = true
    p.ink.recoverStdin('EBADF', 'read')
  })
  await p.wait(50)
  await p.step('the screen leaves the register of screens, and is unmounted with a number, as the exit hook gives it', () => {
    p.the.instances.delete(p.out as never)
    p.ink.unmount(0)
  })
  await p.step('the exit is awaited after it', async () => {
    await p.ink.waitUntilExit()
    note('  a wait after the exit is over at once')
  })
  await p.wait(600)
}

async function exitHook(p: Play): Promise<void> {
  p.mount(24, 6)
  await p.paint('the alternate screen is painted', alt(p, lines(p, ['the process', 'is ending'])), 100)
  await p.step('the process announces its exit, and the exit hook unmounts the screen', () => process.emit('exit', 0))
  await p.wait(600)
  const other = p.mount(24, 6)
  await p.paint('a second screen is painted', lines(p, ['second']), 100)
  await p.step('its exit hook is taken away, and the process announces its exit', () => {
    other.unsubscribeExit()
    process.emit('exit', 0)
  })
  await p.end()
}

async function waitGivenByTheOptions(p: Play): Promise<void> {
  p.mount(24, 6, { waitUntilExit: () => Promise.resolve(note('  the options\' own wait is asked')) })
  await p.paint('a line is painted', lines(p, ['waits elsewhere']), 100)
  await p.step('the exit is awaited', async () => {
    await p.ink.waitUntilExit()
  })
  await p.end()
}

async function detachForShutdown(p: Play): Promise<void> {
  p.mount(24, 6)
  await p.paint('the alternate screen is painted', alt(p, p.h(p.the.Box, { flexDirection: 'column' }, p.h(Listens, { p }), p.h(p.the.Text, null, 'shutting down')), true), 100)
  await p.wait(250)
  await p.step('the terminal resizes, and the screen is detached for shutdown before it settles', () => {
    p.out.resizes(30, 8)
    p.ink.detachForShutdown()
  })
  await p.wait(200)
  await p.step('a tree is given after the detach, and an unmount asked for', () => {
    p.show(lines(p, ['after the detach']))
    p.ink.unmount()
  })
  await p.wait(600)
  await p.step('the stop of the foreground and the continue come to the detached screen', () => {
    const kill = process.kill
    process.kill = (() => {
      note('  the process sends itself a stop')
      return true
    }) as typeof process.kill
    process.emit('SIGTSTP', 'SIGTSTP')
    process.emit('SIGCONT')
    process.kill = kill
  })
  const again = p.mount(24, 6)
  await p.paint('a second screen is painted', lines(p, ['second']), 100)
  await p.step('it is detached where raw mode cannot be given up', () => {
    p.keys.isRaw = true
    p.keys.setRawMode = () => {
      throw new Error('raw mode is not this stream\'s to change')
    }
    again.detachForShutdown()
  })
  await p.wait(600)
  const third = p.mount(24, 6)
  await p.paint('a third screen is painted', lines(p, ['third']), 100)
  await p.step('it is detached with raw mode off', () => third.detachForShutdown())
  await p.wait(600)
}

async function patchedConsole(p: Play): Promise<void> {
  const before = { log: console.log, error: console.error, assert: console.assert, dirxml: console.dirxml }
  ;(console as unknown as Record<string, unknown>).dirxml = undefined
  ;(console as unknown as Record<string, unknown>).trace = 'not a function'
  p.mount(24, 6, { patchConsole: true })
  await p.paint('the alternate screen is painted over a patched console', alt(p, lines(p, ['console', 'patched'])), 100)
  await p.step('the console is spoken to', () => {
    console.log('a log line', 1, { two: 2 })
    console.info('an info line')
    console.debug('a debug line')
    console.table('a table')
    console.warn('a warning')
    console.error('an error line')
    console.assert(true, 'an assertion that holds')
    console.assert(false, 'an assertion that fails')
  })
  await p.step('something writes to the error stream', () => {
    note(`  the write answers ${String(p.err.write('a leak onto the screen\n'))}`)
  })
  await p.wait(16)
  await p.step('something writes there with a callback, and with an encoding and a callback', () => {
    p.err.write('a second leak', () => note('  the first callback is called'))
    p.err.write(Buffer.from('a third leak'), 'utf8', () => note('  the second callback is called'))
  })
  await p.wait(16)
  await p.step('something writes a thing there that cannot be read as text', () => {
    const unreadable = { toString: () => { throw new Error('this chunk has no text') } }
    note(`  the write answers ${String((p.err.write as (chunk: unknown) => boolean)(unreadable))}`)
  })
  await p.wait(16)
  await p.step('something writes there while the frame loop is paused', () => {
    p.ink.pause()
    p.err.write('a leak under the pause')
    p.ink.resume()
  })
  await p.wait(16)
  await p.step('the console is patched a second time by hand, and put back', () => {
    const restore = p.ink.patchConsole()
    console.log('through two patches')
    p.err.write('through two intercepts')
    restore()
    console.log('through one patch')
  })
  await p.wait(16)
  await p.end()
  note(`  the console is its own again: log ${yn(console.log === before.log)}, error ${yn(console.error === before.error)}, assert ${yn(console.assert === before.assert)}`)
  await p.step('something writes to the error stream after the unmount', () => void p.err.write('written after the unmount'))
  ;(console as unknown as Record<string, unknown>).dirxml = before.dirxml
}

async function patchedConsoleOnTheMainScreen(p: Play): Promise<void> {
  p.mount(24, 6, { patchConsole: true })
  const write = p.err.write
  let sent = 0
  sendDebugLinesTo(line => {
    if (sent++ === 0) p.err.write(`${line}\n`, () => {})
    else p.err.write(`${line}\n`, 'utf8', () => {})
  })
  await p.paint('a line on the main screen, where the debug lines go to the stream the screen watches', lines(p, ['main']), 100)
  await p.step('something writes to the error stream', () => void p.err.write('a leak that the main screen lets pass\n'))
  await p.wait(16)
  await p.step('the console is spoken to', () => {
    console.log('a log line that becomes a debug line')
    console.count('a counter')
  })
  await p.step('another hand replaces the stream\'s write before the unmount', () => {
    sendDebugLinesTo(null)
    const patched = p.err.write
    p.err.write = ((chunk: string) => patched.call(p.err, chunk)) as typeof p.err.write
  })
  await p.end()
  note(`  the stream's write is the one from before the screen: ${yn(p.err.write === write)}`)
}

async function smallDoors(p: Play): Promise<void> {
  p.mount(24, 6)
  const tree = (words: string): ReactNode => alt(p, lines(p, [words]), true)
  const stopLayout = p.ink.subscribeLayout(() => note('  a layout listener hears a layout'))
  p.ink.subscribeLayout(() => {
    throw new Error('a layout listener throws')
  })
  const stopFrame = p.ink.subscribeFrame(() => note('  a frame listener hears a frame'))
  p.ink.subscribeFrame(() => {
    throw new Error('a frame listener throws')
  })
  await p.paint('a line is painted with listeners on layout and on frames', tree('doors'), 100)
  await p.step('the first listeners leave, and a line changes', () => {
    stopLayout()
    stopFrame()
    p.show(tree('d00rs'))
  })
  await p.wait(16)
  await p.step('the transcript\'s scroll target and the owners of the arrow keys', () => {
    note(`  a transcript scrolls: ${yn(p.ink.hasScrollableTranscriptTarget())}, the arrows are owned: ${yn(p.ink.arrowKeysOwned())}`)
    const first = p.ink.registerTranscriptScrollTarget(() => true)
    note(`  with a target: ${yn(p.ink.hasScrollableTranscriptTarget())}`)
    const second = p.ink.registerTranscriptScrollTarget(() => false)
    note(`  with a second that does not scroll: ${yn(p.ink.hasScrollableTranscriptTarget())}`)
    first()
    note(`  after the first leaves: ${yn(p.ink.hasScrollableTranscriptTarget())}`)
    const third = p.ink.registerTranscriptScrollTarget(() => true)
    second()
    third()
    note(`  after the last leaves: ${yn(p.ink.hasScrollableTranscriptTarget())}`)
    const idle = p.ink.registerArrowKeyOwner(() => false)
    const owner = p.ink.registerArrowKeyOwner(() => true)
    note(`  with an owner: ${yn(p.ink.arrowKeysOwned())}`)
    owner()
    note(`  with only an idle one: ${yn(p.ink.arrowKeysOwned())}`)
    idle()
  })
  await p.step('the wheel is confirmed, and the alternate screen is set active where it is', () => {
    p.ink.confirmWheelReporting()
    p.ink.setAltScreenActive(true)
  })
  await p.step('the watchdog is armed, and five frames change nothing', () => p.ink.armScreenWatchdog())
  for (let turn = 0; turn < 12; turn++) await p.step('a frame is asked for', () => p.ink.onRender())
  await p.step('the watchdog is armed, and a frame changes a cell among them', () => p.ink.armScreenWatchdog())
  for (let turn = 0; turn < 3; turn++) await p.step('a frame is asked for', () => p.ink.onRender())
  await p.paint('a cell changes', tree('doors'))
  for (let turn = 0; turn < 12; turn++) await p.step('a frame is asked for', () => p.ink.onRender())
  await p.wait(30_000)
  await p.paint('a cell changes after thirty idle seconds to the millisecond', tree('d00rs'))
  await p.wait(29_985)
  await p.paint('a cell changes one millisecond later than that', tree('doors'))
  await p.wait(31_000)
  await p.paint('a cell changes after thirty-one idle seconds', tree('d00rs'))
  await p.wait(300_000)
  await p.paint('a cell changes after five idle minutes', tree('doors'))
  await p.step('methods are called loose from the instance', () => {
    const { arrowKeysOwned, isMouseTrackingEnabled, hasTextSelection, lastFrameText, isAltEntryPending } = p.ink
    note(`  owned ${yn(arrowKeysOwned())}, tracking ${yn(isMouseTrackingEnabled())}, selected ${yn(hasTextSelection())}, pending ${yn(isAltEntryPending())}, the frame ${escaped(JSON.stringify(lastFrameText().replace(ANSI, '').trim()))}`)
  })
  await p.step('the pools are reset by hand', () => p.ink.resetPools())
  await p.paint('a cell changes after it', tree('d00rs'))
  await p.step('a frame is asked for from inside a frame', () => {
    p.frameHook = () => {
      p.frameHook = null
      p.ink.onRender()
      p.ink.scheduleRender()
    }
    p.ink.forceRedraw()
  })
  await p.wait(16)
  await p.end()
}

async function notATerminal(p: Play): Promise<void> {
  p.mount(0, 0, { ttyOut: false, ttyIn: false })
  await p.paint('two lines are given to a stream that is no terminal and says no size', lines(p, ['piped', 'output']), 100)
  await p.paint('a line changes', lines(p, ['piped', 'OUTPUT']))
  await p.step('the stream announces a resize and the window signal comes', () => {
    p.out.resizes(40, 10)
    process.emit('SIGWINCH')
  })
  await p.wait(200)
  await p.step('the doors of a terminal are tried', () => {
    p.ink.resetLineCount()
    p.ink.forceRedraw()
    p.ink.repaintAltScreen()
    p.ink.reassertTerminalModes(true)
    p.ink.suspendStdin()
    p.ink.resumeStdin()
    p.ink.drainStdin()
    p.ink.recoverStdin('EIO', 'read')
    p.ink.reconcileSize()
  })
  await p.wait(200)
  await p.paint('the alternate screen is asked for', alt(p, lines(p, ['alt on a pipe'])))
  await p.step('the editor is entered and left', () => {
    p.ink.enterAlternateScreen()
    p.ink.exitAlternateScreen()
  })
  await p.wait(16)
  await p.end()
}

async function testEnvironment(p: Play): Promise<void> {
  p.mount(24, 6)
  await p.step('a tree is given, and the commit paints at once', () => p.show(alt(p, lines(p, ['painted', 'at once']))))
  await p.step('a line changes', () => p.show(alt(p, lines(p, ['painted', 'AT ONCE']))))
  await p.step('the size changes with no announcement, and a tree is given', () => {
    p.out.becomes(30, 8)
    p.show(alt(p, lines(p, ['painted', 'at a new size'])))
  })
  await p.wait(16)
  await p.end()
}

async function everyTee(p: Play): Promise<void> {
  p.mount(24, 8)
  let handle: ScrollBoxHandle | null = null
  const deep = (depth: number): ReactNode => (depth === 0 ? p.h(p.the.Text, null, 'deep') : p.h(p.the.Box, null, deep(depth - 1)))
  const tree = (words: readonly string[], extra: ReactNode = null): ReactNode =>
    alt(
      p,
      p.h(
        p.the.Box,
        { flexDirection: 'column', width: '100%' },
        p.h(Listens, { p }),
        p.h(
          p.the.Box,
          { flexDirection: 'row' },
          p.h(p.the.Box, { width: 6 }, p.h(p.the.Text, null, 'rail')),
          p.h(p.the.Box, { flexDirection: 'column', flexGrow: 1 }, p.h(p.the.ScrollBox, { ref: (value: ScrollBoxHandle | null) => void (handle = value), height: 3, flexDirection: 'column' }, ...words.map((text, index) => p.h(p.the.Text, { key: index }, text)))),
        ),
        extra,
        p.h(p.the.Text, null, 'the needle is here'),
      ),
      true,
    )
  await p.paint('a rail beside a pane is painted with every tee open', tree(['one', 'two', 'three', 'four', 'five']), 100)
  await p.wait(250)
  await p.paint('a row is put above the needle, and everything under it shifts', tree(['one', 'two', 'three', 'four', 'five'], p.h(p.the.Text, null, 'pushed in')))
  await p.step('the pane scrolls by one', () => handle!.scrollBy(1))
  await p.wait(16)
  await p.wait(4)
  await p.step('a word is selected and the query "needle" set', () => {
    p.click(8, 5)
    p.press(8, 5)
    p.release(8, 5)
    p.ink.setSearchHighlight('needle')
  })
  await p.wait(16)
  await p.paint('a chain of twenty boxes is put above the needle', tree(['one', 'two', 'three', 'four', 'five'], deep(20)))
  await p.paint('and taken away', tree(['one', 'two', 'three', 'four', 'five']))
  await p.end()
}

async function treeDumpAlone(p: Play): Promise<void> {
  p.mount(24, 6)
  const tree = (count: number): ReactNode => alt(p, lines(p, [...Array.from({ length: count }, (_, index) => `pushed ${index}`), 'the line that shifts']))
  await p.paint('a line is painted with only the tree dump open', tree(0), 100)
  for (let turn = 1; turn <= 26; turn++) {
    p.show(tree(turn % 2))
    await advance(16)
  }
  await p.step('twenty-six frames have shifted the layout, two more than the dump allows', () => {})
  await p.end()
}

async function topLevelDoors(p: Play): Promise<void> {
  const { drainStdin, renderFaultRecoveryPlan, RENDER_FAULT_RETRY_BUDGET } = p.the.unit
  p.mount(24, 6)
  await p.step('the plan after a fault, by its count', () => {
    note(`  the budget is ${RENDER_FAULT_RETRY_BUDGET}`)
    for (let streak = 0; streak <= 5; streak++) note(`  after ${streak}: ${renderFaultRecoveryPlan(streak)}; with a budget of 1: ${renderFaultRecoveryPlan(streak, 1)}`)
  })
  await p.step('the keys are drained of what they hold', () => {
    p.keys.sends('left over')
    p.keys.sends('and more')
    note(`  the keys hold ${p.keys.readableLength} chars`)
    drainStdin(p.keys as never)
    note(`  the keys hold ${p.keys.readableLength} chars`)
  })
  await p.step('keys in raw mode are drained', () => {
    p.keys.isRaw = true
    drainStdin(p.keys as never)
    p.keys.isRaw = false
  })
  await p.step('keys that are no terminal are drained, and the process\'s own, which are none', () => {
    drainStdin(new StageKeys(false) as never)
    drainStdin()
  })
  await p.step('keys whose read throws, and keys that refuse raw mode, are drained', () => {
    const broken = new StageKeys()
    broken.read = () => {
      throw new Error('the read throws')
    }
    drainStdin(broken as never)
    const stubborn = new StageKeys()
    stubborn.setRawMode = () => {
      throw new Error('raw mode is refused')
    }
    drainStdin(stubborn as never)
  })
  await p.end()
}

async function firstPaintHeldForTheAnswer(p: Play): Promise<void> {
  p.mount(24, 6)
  const tree = p.h(p.the.Box, { flexDirection: 'column' }, p.h(Listens, { p }), p.h(p.the.Text, null, 'held for the answer'))
  await p.step('a screen that listens to keys is given', () => p.show(tree))
  await p.wait(100)
  await p.wait(16)
  await p.wait(16)
  await p.wait(16)
  await p.wait(16)
  await p.wait(200)
  await p.end()
}

async function accessibleCursor(p: Play): Promise<void> {
  const kill = process.kill
  process.kill = (() => true) as typeof process.kill
  try {
    p.mount(24, 6)
    await p.paint('a field declares the cursor where the cursor is never hidden', p.h(p.the.Box, { flexDirection: 'column' }, p.h(Listens, { p }), p.h(Field, { p, line: 0, column: 2, active: true, label: 'shown' })), 100)
    await p.wait(250)
    await p.step('the stop of the foreground comes, and the continue', () => {
      process.emit('SIGTSTP', 'SIGTSTP')
      process.emit('SIGCONT')
    })
    await p.wait(16)
    await p.end()
  } finally {
    process.kill = kill
  }
}

async function copyOverOsc52(p: Play): Promise<void> {
  p.mount(24, 6)
  const tree = alt(p, p.h(p.the.Box, { flexDirection: 'column', width: '100%' }, p.h(Listens, { p }), p.h(p.the.Text, null, 'copy me over the wire')), true)
  await p.paint('a row is painted where the clipboard is the terminal\'s own', tree, 100)
  await p.wait(250)
  await p.step('a word is selected', () => {
    p.click(1, 0)
    p.press(1, 0)
    p.release(1, 0)
  })
  await p.wait(600)
  await p.step('the selection is copied and kept', () => note(`  copied: ${escaped(JSON.stringify(p.ink.copySelectionNoClear()))}`))
  await p.step('the selection is copied and cleared', () => note(`  copied: ${escaped(JSON.stringify(p.ink.copySelection()))}`))
  await p.step('a text is copied by hand', () => p.ink.copyText('by hand'))
  await p.end()
}

const thrownBy = { error: null as Error | null, once: false }

function Throws({ p, now }: { p: Play; now: boolean }): ReactNode {
  if (now && thrownBy.error !== null) throw thrownBy.error
  return p.h(p.the.Text, null, 'steady')
}

async function componentThrows(p: Play): Promise<void> {
  const tree = (now: boolean): ReactNode => alt(p, p.h(p.the.Box, { flexDirection: 'column' }, p.h(p.the.Text, null, 'above'), p.h(Throws, { p, now })))
  const mounted = (): void => {
    p.mount(200, 12)
    void p.ink.waitUntilExit().then(
      () => note('  the wait for the exit is over'),
      error => note(`  the wait for the exit is refused: ${wordsOf(error)}`),
    )
  }
  mounted()
  await p.paint('a component is painted', tree(false), 100)
  await p.step('the component throws while rendering', () => {
    thrownBy.error = new Error('the component cannot render')
    p.show(tree(true))
  })
  await p.wait(600)
  mounted()
  await p.paint('a second screen is painted', tree(false), 100)
  await p.step('its component throws an error that carries no stack', () => {
    thrownBy.error = new Error('an error with no stack')
    thrownBy.error.stack = undefined
    p.show(tree(true))
  })
  await p.wait(600)
}

let turnTo: ((turn: number) => void) | null = null

function ThrowsOnce({ p }: { p: Play }): ReactNode {
  const [turn, setTurn] = p.the.React.useState(0)
  turnTo = setTurn
  if (turn > 0 && !thrownBy.once) {
    thrownBy.once = true
    const error = new Error(`thrown once on turn ${turn}`)
    if (turn > 1) error.stack = undefined
    throw error
  }
  return p.h(p.the.Text, null, `turn ${turn}`)
}

async function componentRecovers(p: Play): Promise<void> {
  p.mount(24, 6)
  await p.paint('a component is painted', alt(p, p.h(ThrowsOnce, { p })), 100)
  await p.step('its next turn, taken as a transition, throws once and is rendered again', () => p.the.React.startTransition(() => turnTo!(1)))
  await p.wait(16)
  await p.step('and once more, with an error that carries no stack', () => {
    thrownBy.once = false
    p.the.React.startTransition(() => turnTo!(2))
  })
  await p.wait(16)
  await p.end()
}

async function commitTeeShapes(p: Play): Promise<void> {
  p.mount(24, 8)
  const { Box, Text, ScrollBox } = p.the
  const deep = (depth: number, leaf: ReactNode): ReactNode => (depth === 0 ? leaf : p.h(Box, null, deep(depth - 1, leaf)))
  await p.paint('a tree with no row of fixed widths is painted with the commit tee open', alt(p, lines(p, ['plain', 'column'])), 100)
  await p.paint('a row whose children are all of fixed width', alt(p, p.h(Box, { flexDirection: 'row' }, p.h(Box, { width: 4 }, p.h(Text, null, 'a')), p.h(Box, { width: 4 }, p.h(Text, null, 'b')))))
  await p.paint('a row with a free child that holds no pane', alt(p, p.h(Box, { flexDirection: 'row' }, p.h(Box, { width: 4 }, p.h(Text, null, 'a')), p.h(Box, { flexGrow: 1 }, p.h(Text, null, 'free')))))
  await p.paint('a row whose free child holds a pane fourteen boxes down', alt(p, p.h(Box, { flexDirection: 'row' }, p.h(Box, { width: 4 }, p.h(Text, null, 'a')), p.h(Box, { flexGrow: 1 }, deep(14, p.h(ScrollBox, { height: 2, flexDirection: 'column' }, p.h(Text, null, 'far down')))))))
  await p.paint('a row whose free child holds two panes', alt(p, p.h(Box, { flexDirection: 'row' }, p.h(Box, { width: 4 }, p.h(Text, null, 'a')), p.h(Box, { flexGrow: 1, flexDirection: 'column' }, p.h(ScrollBox, { height: 1, flexDirection: 'column' }, p.h(Text, null, 'first')), p.h(ScrollBox, { height: 1, flexDirection: 'column' }, p.h(Text, null, 'second'))))))
  await p.end()
}

export const SCENES: readonly Scene[] = [
  { name: 'the first paint on the main screen', world: 'plain', play: firstPaint },
  { name: 'the first paint on the main screen of an atomic terminal', world: 'atomic', play: firstPaint },
  { name: 'the main screen: a cell, a line, lines more and fewer, the whole screen', world: 'plain', play: mainScreenUpdates },
  { name: 'the main screen of an atomic terminal: a cell, a line, lines more and fewer, the whole screen', world: 'atomic', play: mainScreenUpdates },
  { name: 'the alternate screen: entered, a cell, a line, the whole screen, left', world: 'plain', play: altScreenUpdates },
  { name: 'the alternate screen of an atomic terminal: entered, a cell, a line, the whole screen, left', world: 'atomic', play: altScreenUpdates },
  { name: 'an alternate screen inside another', world: 'plain', play: nestedAltScreen },
  { name: 'the alternate screen the launcher holds', world: 'atomic', env: () => ({ MERCURY_ALT_HELD: '1' }), play: launcherHeldAltScreen },
  { name: 'a resize between frames: larger, smaller, twice within the settle window', world: 'plain', play: resizeBetweenFrames },
  { name: 'a resize between frames on an atomic terminal', world: 'atomic', play: resizeBetweenFrames },
  { name: 'a resize on the main screen', world: 'plain', play: resizeOnTheMainScreen },
  { name: 'a resize during a frame', world: 'plain', play: resizeDuringAFrame },
  { name: 'a resize during a frame on an atomic terminal', world: 'atomic', play: resizeDuringAFrame },
  { name: 'a resize seen from inside a commit', world: 'plain', play: resizeSeenInsideACommit },
  { name: 'the window signal', world: 'plain', play: windowSignal },
  { name: 'the old console of Windows', world: 'plain', play: oldWindowsConsole },
  { name: 'a scroll region', world: 'atomic', play: scrollRegion },
  { name: 'a scrolled pane on a terminal with no atomic drawing', world: 'plain', play: scrollRegion },
  { name: 'the cursor declared on the alternate screen', world: 'plain', play: p => declaredCursor(p, true) },
  { name: 'the cursor declared on the main screen', world: 'plain', play: p => declaredCursor(p, false) },
  { name: 'the cursor declared where it is never hidden', world: 'plain', env: () => ({ MERCURY_ACCESSIBILITY: '1' }), play: accessibleCursor },
  { name: 'clicks, hovers and keys', world: 'atomic', play: pointerAndKeys },
  { name: 'clicks, hovers and keys on a plain terminal', world: 'plain', play: pointerOnAPlainTerminal },
  { name: 'a selection started, dragged, released and copied', world: 'atomic', play: selection },
  { name: 'a copy offered to the terminal', world: 'plain', env: () => ({ MERCURY_CLIPBOARD_FILE: '', SSH_CONNECTION: 'scripted' }), play: copyOverOsc52 },
  { name: 'search highlight', world: 'plain', play: searchHighlight },
  { name: 'frames the terminal refuses, on the alternate screen', world: 'plain', play: p => renderFaults(p, true) },
  { name: 'frames the terminal refuses, on the main screen', world: 'atomic', play: p => renderFaults(p, false) },
  { name: 'an editor is given the terminal from the alternate screen', world: 'atomic', play: p => editorHandover(p, true) },
  { name: 'an editor is given the terminal from the main screen', world: 'plain', play: p => editorHandover(p, false) },
  { name: 'the terminal queries are awaited and never answered', world: 'plain', play: queriesAwaited },
  { name: 'the terminal answers its queries', world: 'plain', play: queriesAnswered },
  { name: 'the first paint is held for the terminal\'s answer', world: 'plain', play: firstPaintHeldForTheAnswer },
  { name: 'stop and continue on the alternate screen', world: 'atomic', play: p => stopAndContinue(p, true) },
  { name: 'stop and continue on the main screen', world: 'plain', play: p => stopAndContinue(p, false) },
  { name: 'the reader of keys faults', world: 'plain', play: stdinRecovery },
  { name: 'unmount on the alternate screen, and the waits for the exit', world: 'atomic', play: unmountAndExit },
  { name: 'unmount with an error', world: 'plain', play: unmountWithAnError },
  { name: 'a screen that is given no tree', world: 'plain', play: noTree },
  { name: 'the exit hook of the process', world: 'plain', play: exitHook },
  { name: 'a wait for the exit given by the options', world: 'plain', play: waitGivenByTheOptions },
  { name: 'detached for shutdown', world: 'plain', play: detachForShutdown },
  { name: 'the console patched on the alternate screen', world: 'plain', play: patchedConsole },
  { name: 'the console patched on the main screen, with the debug lines on the stream it watches', world: 'plain', play: patchedConsoleOnTheMainScreen },
  { name: 'listeners, owners, the watchdog and the idle resets', world: 'plain', play: smallDoors },
  { name: 'a stream that is no terminal', world: 'plain', play: notATerminal },
  { name: 'the test environment', world: 'test', play: testEnvironment },
  { name: 'every tee open', world: 'atomic', tees: TEE_NAMES, probe: 'needle', play: everyTee },
  { name: 'the tree dump alone, and a tee that cannot be written', world: 'plain', tees: ['INK_TREE_DUMP'], env: folder => ({ INK_COMMIT_TEE: join(folder, 'no such folder', 'tee') }), play: treeDumpAlone },
  { name: 'the write tee and the composed tee on the main screen', world: 'plain', tees: ['INK_WRITE_TEE', 'INK_COMPOSED_TEE'], play: mainScreenUpdates },
  { name: 'a frame that burns a cost pad', world: 'plain', env: () => ({ MERCURY_FRAME_COST_PAD_MS: '0.001' }), play: firstPaint },
  { name: 'the commit tee over trees of other shapes', world: 'plain', tees: ['INK_COMMIT_TEE'], play: commitTeeShapes },
  { name: 'a component throws while rendering', world: 'plain', play: componentThrows },
  { name: 'a component throws once in a transition', world: 'plain', play: componentRecovers },
  { name: 'the doors beside the class', world: 'plain', play: topLevelDoors },
]

export async function playScene(name: string, fd1File: string | null, folder: string): Promise<string[]> {
  const scene = SCENES.find(candidate => candidate.name === name)
  if (scene === undefined) throw new Error(`no scene is named "${name}"`)
  enterWorld(scene.world)
  const clipboard = join(folder, 'clipboard')
  const home = join(folder, 'home')
  mkdirSync(home)
  Object.assign(process.env, { MERCURY_CONFIG_DIR: home, MERCURY_CLIPBOARD_FILE: clipboard, MERCURY_FLUX_PROBE: '1' }, scene.env?.(folder) ?? {})
  for (const tee of scene.tees ?? []) process.env[tee] = join(folder, tee)
  if (scene.probe !== undefined) process.env.INK_TEE_PROBE = scene.probe
  installStage(fd1File)
  const the = await loadProduct()
  note(`world: ${scene.world}, ${WORLDS[scene.world].says}`)
  const play = new Play(the, folder)
  await scene.play(play)
  for (const tee of scene.tees ?? []) {
    const file = join(folder, tee)
    const held = existsSync(file) ? readFileSync(file, 'utf8').replace(/\n$/, '').split('\n') : []
    note(`the tee ${tee} holds ${held.length} lines`)
    for (const line of held) note(`  ${escaped(line)}`)
  }
  if (existsSync(clipboard)) note(`the clipboard file holds ${escaped(JSON.stringify(readFileSync(clipboard, 'utf8')))}`)
  const milestones = join(home, 'launch-milestones.json')
  const reached = existsSync(milestones) ? (JSON.parse(readFileSync(milestones, 'utf8')) as { rows: Array<{ milestone: string }> }).rows.map(row => row.milestone) : []
  note(`the launch milestones written: ${reached.join(', ') || 'none'}`)
  const dump = the.flux.fluxProbeDump()
  const marks = new Map<string, number>()
  for (const mark of dump.allMarks) marks.set(`${mark.k}=${mark.v}`, (marks.get(`${mark.k}=${mark.v}`) ?? 0) + 1)
  note(`the probe counted: ${Object.entries(dump.counters).map(([name, count]) => `${name} ${count}`).join(', ') || 'nothing'}`)
  note(`the probe marked: ${[...marks].map(([mark, count]) => `${mark} x${count}`).join(', ') || 'nothing'}`)
  note(`the probe saw ${dump.frames.total} frames, the longest of ${ticks(dump.frames.maxMs)} clock reads`)
  const facts = the.governor.motionGovernorFacts()
  note(`the motion governor: ${facts.framesSeen} frames seen, level ${facts.level}, trip ${String(facts.trip)}`)
  const out = recorded().join('\n').split('\n')
  leaveStage()
  return out
}
