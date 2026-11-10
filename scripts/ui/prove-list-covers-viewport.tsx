import React from 'react'
import { mountOffscreen, pinScratchHome, pinSourceRef, releaseScratchHome, settle, waitFor, type Mounted } from '../lib/settingsPopupHarness.js'

pinSourceRef()
const home = pinScratchHome('list-covers-viewport')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const { Box, Text } = await import('../../src/ink.js')
const { default: ScrollBox } = await import('../../src/ink/components/ScrollBox.js')
const { default: instances } = await import('../../src/ink/instances.js')
const { VirtualMessageList } = await import('../../src/components/VirtualMessageList.js')
const { AppStateProvider } = await import('../../src/state/AppState.js')
const { ThemeProvider } = await import('../../src/components/design-system/ThemeProvider.js')
const { createUserMessage } = await import('../../src/utils/messages/factories.js')
const { AnsiEmulator } = await import('../ink-runtime/ansiEmulator.js')
type Scroll = import('../../src/ink/components/ScrollBox.js').ScrollBoxHandle
type Row = ReturnType<typeof createUserMessage>

const VIEWPORT = 20
const VERBOSE = process.argv.includes('--frames')
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : undefined
const WIDTH_PROBE_WRITE = /\x1b7.*\x1b\[6n/s
const PROBE_CSI = /\x1b\[(?:[<>=][0-9;]*[a-zA-Z]|\?[0-9;]*\$p|\?[0-9;]*u|[0-9;]*c|6n)/g

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok || detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures++
}

type World = { rows: number; tallAt: number; open: number; shut: number; wide?: boolean; mountMs?: number; ownState?: boolean; cursorOnTall?: boolean }
type Shown = { lines: number; rows: Row[]; columns: number }
type Stage = {
  view: Mounted
  scroll: React.RefObject<Scroll | null>
  writes: string[]
  shown: () => Shown
  listRenders: () => number
  armOwnCommit: () => number
  listRendersAtOwnCommit: () => number | null
  poke: () => void
  set: (open: boolean) => void
  resize: (lines: number) => void
  drop: (count: number) => void
  wrap: (columns: number) => void
}

const label = (at: number): string => `ROW ${String(at).padStart(3, '0')}`
const FILL = ' the ledger sweep holds steady against the recorded baseline'

const Line = React.memo(function Line({ words, mountMs }: { words: string; mountMs: number }): React.ReactNode {
  const until = performance.now() + mountMs
  while (performance.now() < until) {
  }
  return <Text>{words}</Text>
})

function Group({ lines, world }: { lines: number; world: World }): React.ReactNode {
  const word = lines > world.shut ? 'open' : 'shut'
  return (
    <Box flexDirection="column">
      {Array.from({ length: lines }, (_, k) => (
        <Text key={k}>{`GROUP ${word} ${String(k).padStart(3, '0')}`}</Text>
      ))}
    </Box>
  )
}

function SelfSizedGroup({ startLines, world, hand, committed }: { startLines: number; world: World; hand: (set: (lines: number) => void) => void; committed: () => void }): React.ReactNode {
  const [lines, setLines] = React.useState(startLines)
  React.useLayoutEffect(() => hand(setLines), [hand])
  React.useLayoutEffect(committed, [lines, committed])
  return <Group lines={lines} world={world} />
}

async function stage(world: World, start: { lines: number; rows?: number; columns: number }): Promise<Stage> {
  const scroll = React.createRef<Scroll>()
  const all: Row[] = Array.from({ length: world.rows }, (_, i) => createUserMessage({ content: `row ${i}` }))
  const indexOf = new Map(all.map((row, i) => [row.uuid, i]))
  const listeners = new Set<() => void>()
  let state: Shown = { lines: start.lines, rows: all.slice(0, start.rows ?? world.rows), columns: start.columns }
  const publish = (next: Shown): void => {
    state = next
    for (const listener of listeners) listener()
  }
  let setOwn: (lines: number) => void = () => {}
  const hand = (set: (lines: number) => void): void => {
    setOwn = set
  }
  const resize = (lines: number): void => {
    if (!world.ownState) return publish({ ...state, lines })
    state = { ...state, lines }
    setOwn(lines)
  }
  let listRenders = 0
  let listRendersAtOwnCommit: number | null = null
  const committed = (): void => {
    listRendersAtOwnCommit ??= listRenders
  }
  function Pane(): React.ReactNode {
    const shown = React.useSyncExternalStore(
      listener => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      () => state,
    )
    const listedLines = world.ownState ? start.lines : shown.lines
    const renderItem = React.useCallback(
      (row: Row): React.ReactNode => {
        const at = indexOf.get(row.uuid)!
        if (at !== world.tallAt) return <Line words={world.wide ? `${label(at)}${FILL}` : label(at)} mountMs={world.mountMs ?? 0} />
        listRenders++
        return world.ownState ? <SelfSizedGroup startLines={listedLines} world={world} hand={hand} committed={committed} /> : <Group lines={listedLines} world={world} />
      },
      [listedLines],
    )
    return (
      <Box width={shown.columns} height={VIEWPORT + 1} flexDirection="column">
        <ScrollBox ref={scroll} height={VIEWPORT} flexDirection="column" stickyScroll>
          <Box flexDirection="column" width="100%">
            <VirtualMessageList
              messages={shown.rows as never}
              scrollRef={scroll}
              columns={shown.columns}
              itemKey={row => row.uuid}
              selectedIndex={world.cursorOnTall ? world.tallAt : undefined}
              selectedExpanded={world.cursorOnTall === true && shown.lines > world.shut}
              renderItem={renderItem as never}
            />
          </Box>
        </ScrollBox>
        <Text>FLOOR</Text>
      </Box>
    )
  }
  const tree = (
    <AppStateProvider>
      <ThemeProvider>
        <Pane />
      </ThemeProvider>
    </AppStateProvider>
  )
  const before = new Set(instances.keys())
  const view = await mountOffscreen(tree, start.columns, VIEWPORT + 1)
  const stdout = [...instances.keys()].find(key => !before.has(key)) as unknown as { writes: string[] }
  return {
    view,
    scroll,
    writes: stdout.writes,
    shown: () => state,
    listRenders: () => listRenders,
    armOwnCommit: () => {
      listRendersAtOwnCommit = null
      return listRenders
    },
    listRendersAtOwnCommit: () => listRendersAtOwnCommit,
    poke: () => publish({ ...state }),
    set: open => resize(open ? world.open : world.shut),
    resize,
    drop: count => publish({ ...state, rows: state.rows.slice(0, state.rows.length - count) }),
    wrap: columns => {
      publish({ ...state, columns })
      view.resize(tree, columns, VIEWPORT + 1)
    },
  }
}

function framesFrom(writes: readonly string[], from: number, columns: number): string[][] {
  const emulator = new AnsiEmulator(columns, VIEWPORT + 1, true)
  const frames: string[][] = []
  writes.forEach((write, at) => {
    if (WIDTH_PROBE_WRITE.test(write)) return
    emulator.feed(write.replace(PROBE_CSI, ''))
    if (at >= from) frames.push(emulator.lines().slice(0, VIEWPORT))
  })
  return frames
}

const pane = (view: Mounted): string[] => view.lines().slice(0, VIEWPORT)

type Spot = { row: number; inner: number }

function spotOf(line: string, world: World): Spot | null {
  const plain = /^ROW (\d+)/.exec(line)
  if (plain) return { row: Number(plain[1]), inner: 0 }
  const inside = /^GROUP (?:open|shut) (\d+)$/.exec(line)
  return inside ? { row: world.tallAt, inner: Number(inside[1]) } : null
}

function holes(frame: readonly string[], world: World, lastRow: number): number[] {
  const floor = frame.findIndex(line => spotOf(line, world)?.row === lastRow)
  const reach = floor === -1 ? frame.length : floor
  return frame.flatMap((line, at) => (at < reach && line.trim() === '' ? [at] : []))
}

async function rest(view: Mounted): Promise<string[]> {
  let last = pane(view).join('\n')
  let stable = 0
  const deadline = Date.now() + 4000
  while (Date.now() < deadline && stable < 4) {
    await settle(50)
    const now = pane(view).join('\n')
    stable = now === last ? stable + 1 : 0
    last = now
  }
  return pane(view)
}

function rowsBetween(from: Spot, to: Spot, world: World, lines: number): number {
  const depth = (spot: Spot): number => spot.row + (spot.row > world.tallAt ? lines - 1 : 0) + spot.inner
  return depth(to) - depth(from)
}

async function seat(live: Stage, world: World, want: Spot): Promise<boolean> {
  for (let attempt = 0; attempt < 14; attempt++) {
    const seen = spotOf(pane(live.view)[0] ?? '', world)
    if (seen && seen.row === want.row && seen.inner === want.inner) return true
    const scroll = live.scroll.current!
    const step = seen ? rowsBetween(seen, want, world, live.shown().lines) : -VIEWPORT
    scroll.scrollTo(Math.max(0, scroll.getScrollTop() + (step === 0 ? -1 : step)))
    await rest(live.view)
  }
  return false
}

type Case = {
  name: string
  world: World
  startOpen: boolean
  top: Spot | 'tail' | 'cursor'
  act: (live: Stage) => void | Promise<void>
  busyMs?: number
  lands?: Spot
  headAt?: number
  listRenders?: number
  outOfSight?: true
}

const OWN: World = { rows: 120, tallAt: 40, open: 240, shut: 1, ownState: true }

const show = (title: string, frame: readonly string[]): void => {
  if (VERBOSE) console.log(`--- ${title}\n${frame.map(line => `  │${line}`).join('\n')}`)
}

async function place(live: Stage, world: World, top: Case['top']): Promise<boolean> {
  return top === 'tail' || top === 'cursor' ? true : seat(live, world, top)
}

async function run(scene: Case): Promise<void> {
  const live = await stage(scene.world, { lines: scene.startOpen ? scene.world.open : scene.world.shut, columns: 80 })
  let fresh: Stage | null = null
  const lastRow = (): number => live.shown().rows.length - 1
  try {
    await waitFor(() => pane(live.view).some(line => spotOf(line, scene.world) !== null), 3000)
    await rest(live.view)
    const seated = await place(live, scene.world, scene.top)
    await rest(live.view)
    live.poke()
    const placed = await rest(live.view)
    check(`${scene.name}: the pane is whole before the change`, seated && holes(placed, scene.world, lastRow()).length === 0, `seated ${seated}, blank rows ${holes(placed, scene.world, lastRow()).join(',')}`)
    show(`${scene.name} before`, placed)
    const mark = live.writes.length
    const columnsBefore = live.shown().columns
    const rendersBefore = live.armOwnCommit()
    await scene.act(live)
    if (scene.busyMs !== undefined) {
      const until = Date.now() + scene.busyMs
      while (Date.now() < until) {
        await settle(8)
        live.poke()
      }
      const busy = pane(live.view)
      check(`${scene.name}: the pane is whole while the screen above it keeps rendering`, holes(busy, scene.world, lastRow()).length === 0, `${holes(busy, scene.world, lastRow()).length} blank rows after ${scene.busyMs} ms of renders`)
      show(`${scene.name} busy`, busy)
    }
    const settled = await rest(live.view)
    if (scene.world.ownState) {
      check(`${scene.name}: the row committed its new height by its own state, with no render of the list`, live.listRendersAtOwnCommit() === rendersBefore, `the list had rendered the row ${rendersBefore} times before the change and ${live.listRendersAtOwnCommit()} times by the row's own commit`)
    }
    if (scene.listRenders !== undefined) {
      check(`${scene.name}: the list rendered ${scene.listRenders} times for it`, live.listRenders() - rendersBefore === scene.listRenders, `${live.listRenders() - rendersBefore} renders of the list`)
    }
    if (scene.lands !== undefined) {
      const landed = spotOf(settled[0] ?? '', scene.world)
      check(`${scene.name}: the pane's first line is the row's line ${scene.lands.inner}`, landed !== null && landed.row === scene.lands.row && landed.inner === scene.lands.inner, `the pane opens on ${settled[0] === '' ? '(blank)' : settled[0]}`)
    }
    if (scene.headAt !== undefined) {
      const head = settled.findIndex(line => /^GROUP (?:open|shut) 000$/.test(line))
      check(`${scene.name}: the row's head stands on pane row ${scene.headAt}`, head === scene.headAt, `the head stands on pane row ${head}; the pane opens on ${settled[0]}`)
    }
    const columns = live.shown().columns
    const frames = framesFrom(live.writes, columns === columnsBefore ? mark : 0, columns)
    const torn = frames.map((frame, at) => ({ at, rows: holes(frame, scene.world, lastRow()) })).filter(entry => entry.rows.length > 0)
    check(
      `${scene.name}: every frame painted after the change shows a row on every row of the pane above the list's end`,
      (frames.length > 0 || scene.outOfSight === true) && torn.length === 0,
      frames.length === 0 ? 'no frame was painted' : `${torn.length} of ${frames.length} frames torn; frame ${(torn[0]?.at ?? 0) + 1} has ${torn[0]?.rows.length} blank rows from pane row ${torn[0]?.rows[0]}`,
    )
    frames.forEach((frame, at) => show(`${scene.name} frame ${at + 1}/${frames.length}`, frame))
    const sticky = live.scroll.current!.isSticky()
    const topSpot = spotOf(settled[0] ?? '', scene.world)
    fresh = await stage(scene.world, { lines: live.shown().lines, rows: live.shown().rows.length, columns })
    await waitFor(() => pane(fresh!.view).some(line => spotOf(line, scene.world) !== null), 3000)
    await rest(fresh.view)
    const reseated = sticky ? true : topSpot !== null && (await seat(fresh, scene.world, topSpot))
    const mounted = await rest(fresh.view)
    check(
      `${scene.name}: the settled pane equals a fresh mount at the same position`,
      reseated && settled.join('\n') === mounted.join('\n'),
      `${sticky ? 'sticky' : `top ${settled[0] === '' ? '(blank)' : settled[0]}`}: live [${settled[0]} … ${settled[VIEWPORT - 1]}] fresh [${mounted[0]} … ${mounted[VIEWPORT - 1]}]`,
    )
    show(`${scene.name} settled`, settled)
    show(`${scene.name} fresh`, mounted)
  } finally {
    live.view.unmount()
    fresh?.view.unmount()
  }
}

const TALL: World = { rows: 120, tallAt: 40, open: 240, shut: 1 }
const reopened = async (live: Stage): Promise<void> => {
  live.set(false)
  await rest(live.view)
  live.set(true)
}
const openedThenShut = async (live: Stage): Promise<void> => {
  live.set(true)
  await rest(live.view)
  live.set(false)
}
const reopenedThenRendered = async (live: Stage): Promise<void> => {
  await reopened(live)
  await rest(live.view)
  live.poke()
}
const grownTenTimes = async (live: Stage): Promise<void> => {
  for (let step = 0; step < 10; step++) {
    live.resize(live.shown().lines + 1)
    await settle(30)
  }
}
const cases: Case[] = [
  { name: 'a tall row collapsed off the tail, its head in view', world: TALL, startOpen: true, top: { row: 37, inner: 0 }, act: live => live.set(false) },
  { name: 'a tall row collapsed off the tail from inside it', world: TALL, startOpen: true, top: { row: 40, inner: 150 }, act: live => live.set(false) },
  { name: 'a tall row collapsed at the tail', world: { ...TALL, tallAt: 110 }, startOpen: true, top: 'tail', act: live => live.set(false) },
  { name: 'a tall row collapsed off the tail under a running turn', world: { ...TALL, mountMs: 4 }, startOpen: true, top: { row: 37, inner: 0 }, act: live => live.set(false), busyMs: 700 },
  { name: 'a row expanded off the tail', world: TALL, startOpen: false, top: { row: 37, inner: 0 }, act: live => live.set(true) },
  { name: 'a row expanded at the tail', world: { ...TALL, tallAt: 110 }, startOpen: false, top: 'tail', act: live => live.set(true) },
  { name: 'rows leaving at the tail', world: TALL, startOpen: false, top: 'tail', act: live => live.drop(40) },
  { name: 'rows leaving under the pane off the tail', world: TALL, startOpen: false, top: { row: 95, inner: 0 }, act: live => live.drop(20) },
  { name: 'a tall row collapsed by its own state off the tail, its head in view', world: OWN, startOpen: true, top: { row: 37, inner: 0 }, act: live => live.set(false) },
  { name: 'a tall row collapsed by its own state off the tail from inside it', world: OWN, startOpen: true, top: { row: 40, inner: 150 }, act: live => live.set(false) },
  { name: 'a tall row collapsed by its own state at the tail', world: { ...OWN, tallAt: 110 }, startOpen: true, top: 'tail', act: live => live.set(false) },
  { name: 'a row expanded by its own state off the tail', world: OWN, startOpen: false, top: { row: 37, inner: 0 }, act: live => live.set(true) },
  { name: 'a row expanded by its own state at the tail', world: { ...OWN, tallAt: 110 }, startOpen: false, top: 'tail', act: live => live.set(true) },
  { name: 'a row expanded off the tail where it stands and collapsed again', world: TALL, startOpen: false, top: { row: 37, inner: 0 }, act: openedThenShut },
  { name: 'a tall row collapsed from inside it and expanded again', world: TALL, startOpen: true, top: { row: 40, inner: 150 }, act: reopened, lands: { row: 40, inner: 0 } },
  { name: 'a tall row collapsed by its own state from inside it and expanded again', world: OWN, startOpen: true, top: { row: 40, inner: 150 }, act: reopened, lands: { row: 40, inner: 0 } },
  { name: 'a tall row collapsed from inside it, expanded again, and the list rendered once more', world: TALL, startOpen: true, top: { row: 40, inner: 150 }, act: reopenedThenRendered, lands: { row: 40, inner: 0 } },
  { name: 'the row under the message cursor expanded by its key from above the pane', world: { ...TALL, cursorOnTall: true }, startOpen: false, top: 'cursor', act: live => live.set(true), lands: { row: 40, inner: 1 } },
  { name: 'the row under the message cursor collapsed by its key from above the pane', world: { ...TALL, cursorOnTall: true }, startOpen: true, top: 'cursor', act: live => live.set(false), lands: { row: 41, inner: 0 } },
  { name: 'the row under the message cursor expanded by its key from below the pane', world: { ...TALL, tallAt: 110, cursorOnTall: true }, startOpen: false, top: { row: 35, inner: 0 }, act: live => live.set(true), lands: { row: 110, inner: 1 } },
  { name: 'the row under the message cursor expanded by its key inside the pane', world: { ...TALL, cursorOnTall: true }, startOpen: false, top: { row: 35, inner: 0 }, act: live => live.set(true), lands: { row: 35, inner: 0 }, headAt: 5 },
  { name: 'the row under the message cursor collapsed by its key inside the pane', world: { ...TALL, cursorOnTall: true }, startOpen: true, top: { row: 35, inner: 0 }, act: live => live.set(false), lands: { row: 35, inner: 0 }, headAt: 5 },
  { name: 'the last row grows ten times through the list under the pane\'s top', world: { ...TALL, tallAt: 119 }, startOpen: true, top: { row: 119, inner: 150 }, act: grownTenTimes, lands: { row: 119, inner: 150 }, listRenders: 10, outOfSight: true },
  { name: 'the last row grows ten times by its own state under the pane\'s top', world: { ...OWN, tallAt: 119 }, startOpen: true, top: { row: 119, inner: 150 }, act: grownTenTimes, lands: { row: 119, inner: 150 }, listRenders: 0, outOfSight: true },
  { name: 'a re-wrap off the tail', world: { ...TALL, wide: true }, startOpen: false, top: { row: 37, inner: 0 }, act: live => live.wrap(40) },
  { name: 'a re-wrap at the tail', world: { ...TALL, wide: true }, startOpen: false, top: 'tail', act: live => live.wrap(40) },
]

try {
  for (const scene of cases) {
    if (ONLY !== undefined && !scene.name.includes(ONLY)) continue
    await run(scene)
  }
} finally {
  await releaseScratchHome(home)
}
console.log(`${checks} checks, ${failures} failed`)
process.exit(failures === 0 ? 0 : 1)
