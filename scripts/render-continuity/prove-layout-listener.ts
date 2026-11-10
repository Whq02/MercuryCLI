#!/usr/bin/env bun
import { EventEmitter } from 'node:events'

const React = await import('react')
const h = React.createElement
const { default: Ink } = await import('../../src/ink/ink.tsx')
const { default: instances } = await import('../../src/ink/instances.ts')
const { Box, Text, flushPendingSyncWork } = await import('../../src/ink.ts')
const { AlternateScreen } = await import('../../src/ink/components/AlternateScreen.tsx')
type Node = import('../../src/ink/dom.ts').DOMElement

const COLS = 48
const ROWS = 16
const TALL = ['row line 1', 'row line 2', 'row line 3', 'row line 4', 'row line 5', 'row line 6']
const SHUT = 'row shut'

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

class Terminal extends EventEmitter {
  isTTY = true
  columns = COLS
  rows = ROWS
  write(): boolean {
    return true
  }
}

class Keyboard extends EventEmitter {
  isTTY = true
  isRaw = false
  readableLength = 0
  setEncoding(): this {
    return this
  }
  setRawMode(value: boolean): this {
    this.isRaw = value
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

type Hooks = { row: { current: Node | null }; setTall: ((tall: boolean) => void) | null; hear: ((height: number) => void) | null; listRenders: number }
const hooks: Hooks = { row: { current: null }, setTall: null, hear: null, listRenders: 0 }

function Row(): React.ReactNode {
  const [tall, setTall] = React.useState(true)
  hooks.setTall = setTall
  const lines = tall ? TALL : [SHUT]
  return h(Box, { flexDirection: 'column', ref: hooks.row }, ...lines.map(line => h(Text, { key: line }, line)))
}

function List(): React.ReactNode {
  const [heard, hear] = React.useState(TALL.length)
  hooks.hear = hear
  hooks.listRenders++
  return h(Box, { flexDirection: 'column' }, h(Row), h(Text, null, `list heard ${heard}`))
}

let streamValue = 0
const streamListeners = new Set<() => void>()
const subscribeStream = (onChange: () => void): (() => void) => {
  const listener = (): void => {
    onChange()
    flushPendingSyncWork()
  }
  streamListeners.add(listener)
  return () => {
    streamListeners.delete(listener)
  }
}
const pump = (): void => {
  streamValue++
  for (const listener of streamListeners) listener()
}

function Stream(): React.ReactNode {
  const value = React.useSyncExternalStore(subscribeStream, () => streamValue)
  return h(Text, null, `stream ${value}`)
}

function Scene(): React.ReactNode {
  return h(AlternateScreen, { mouseTracking: false }, h(Box, { flexDirection: 'column', width: COLS, height: ROWS }, h(Stream), h(List)))
}

const settle = (ms = 220): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const shows = (frame: string, row: 'tall' | 'shut', heard: number): boolean => frame.includes(row === 'tall' ? TALL.at(-1)! : SHUT) && frame.includes(`list heard ${heard}`)
const torn = (frame: string): boolean => (frame.includes(SHUT) && !frame.includes('list heard 1')) || (frame.includes(TALL.at(-1)!) && !frame.includes(`list heard ${TALL.length}`))
const states = (painted: string[], before: string): string[] => painted.filter((frame, at) => frame !== (at === 0 ? before : painted[at - 1]))

const frames: string[] = []
const screen = new Terminal()
const ink = new Ink({
  stdout: screen as never,
  stdin: new Keyboard() as never,
  stderr: new Terminal() as never,
  patchConsole: false,
  exitOnCtrlC: false,
  onFrame: () => {
    frames.push(ink.lastFrameText())
  },
})
instances.set(screen as never, ink)
ink.render(h(Scene))
await settle(450)
t('§1 the painter runs on its own scheduler (a queued paint), not the immediate render of NODE_ENV=test', process.env.NODE_ENV !== 'test', String(process.env.NODE_ENV))
t('§1 the scene paints the tall row and the list', frames.length > 0 && shows(frames.at(-1)!, 'tall', TALL.length), frames.at(-1) ?? 'no frame')

const rendersAtRest = hooks.listRenders
hooks.setTall!(false)
await settle()
t('§1 a row that changes its own height commits without the list rendering: with no listener the list keeps its old answer', hooks.listRenders === rendersAtRest && shows(frames.at(-1)!, 'shut', TALL.length), `list renders ${rendersAtRest} → ${hooks.listRenders}\n${frames.at(-1)}`)
hooks.setTall!(true)
await settle()

const subscribeLayout = (ink as unknown as { subscribeLayout?: (listener: () => void) => () => void }).subscribeLayout
t('§2 the root takes a layout listener', typeof subscribeLayout === 'function')

if (typeof subscribeLayout === 'function') {
  const heights: number[] = []
  let heardHeight = TALL.length
  const stopList = subscribeLayout(() => {
    const height = hooks.row.current?.layoutNode?.getComputedHeight() ?? -1
    heights.push(height)
    if (height === heardHeight) return
    heardHeight = height
    hooks.hear!(height)
  })

  let mark = frames.length
  let calls = heights.length
  hooks.setTall!(false)
  await settle()
  let painted = frames.slice(mark)
  t('§2 it is called after the commit, with that commit\'s layout readable', heights.slice(calls).includes(1), JSON.stringify(heights.slice(calls)))
  t('§2 a render it asks for is in the frame of the same commit: no painted frame shows the shut row beside the old answer', painted.length > 0 && !painted.some(torn) && shows(painted.at(-1)!, 'shut', 1), painted.filter(torn)[0] ?? painted.at(-1) ?? 'no frame')
  t('§2 and the change is one painted state, not a wrong frame and then a right one', states(painted, frames[mark - 1]!).length === 1, `${states(painted, frames[mark - 1]!).length} states`)

  mark = frames.length
  hooks.setTall!(true)
  await settle()
  painted = frames.slice(mark)
  t('§2 the same on the way back: the tall row and the new answer arrive in one painted state', !painted.some(torn) && shows(painted.at(-1)!, 'tall', TALL.length) && states(painted, frames[mark - 1]!).length === 1, painted.filter(torn)[0] ?? `${states(painted, frames[mark - 1]!).length} states`)

  mark = frames.length
  const stream = setInterval(pump, 5)
  for (let round = 0; round < 10; round++) {
    await settle(37)
    hooks.setTall!(round % 2 === 1)
  }
  await settle(120)
  clearInterval(stream)
  await settle()
  painted = frames.slice(mark)
  const streamSteps = new Set(painted.map(frame => /stream (\d+)/.exec(frame)?.[1])).size
  const rowStates = states(painted.map(frame => (frame.includes(SHUT) ? 'shut' : 'tall')), 'tall').length
  t('§3 while another component commits every 5 ms and flushes synchronously, the row still changes height ten times on screen', streamSteps > 20 && rowStates === 10, `${streamSteps} stream steps painted, ${rowStates} row changes painted`)
  t('§3 and no painted frame shows the row at one height and the list\'s answer for the other', !painted.some(torn), `${painted.filter(torn).length} of ${painted.length} frames torn; first:\n${painted.filter(torn)[0]}`)

  let later = 0
  const stopThrower = subscribeLayout(() => {
    throw new Error('a layout listener that throws')
  })
  const stopLater = subscribeLayout(() => {
    later++
  })
  mark = frames.length
  hooks.setTall!(false)
  await settle()
  painted = frames.slice(mark)
  t('§4 a listener that throws stops neither the commit, nor the listeners beside it, nor the frame', later > 0 && !painted.some(torn) && shows(painted.at(-1)!, 'shut', 1), `later listener calls ${later}\n${painted.at(-1)}`)

  stopThrower()
  stopLater()
  stopList()
  calls = heights.length
  const laterCalls = later
  hooks.setTall!(true)
  await settle()
  t('§4 a listener that unsubscribed is not called again', heights.length === calls && later === laterCalls && shows(frames.at(-1)!, 'tall', 1), `calls ${calls} → ${heights.length}, ${laterCalls} → ${later}`)
}

const exited = ink.waitUntilExit()
ink.unmount()
await exited
instances.delete(screen as never)

console.log(failures === 0 ? 'LAYOUT LISTENER: ALL PASS' : 'LAYOUT LISTENER: RED')
process.exit(failures)
