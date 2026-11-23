import React from 'react'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mountOffscreen, pinScratchHome, releaseScratchHome, type Mounted } from '../lib/settingsPopupHarness.js'

const home = pinScratchHome('virtual-scroll-recording')
const TRACE = join(home, 'pin-trace.jsonl')
process.env['MERCURY_CONNECTOR_TRACE'] = TRACE
;(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true
const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()
const { Box } = await import('../../src/screen/themedRenderer.js')
const { InkInstanceContext } = await import('../../src/screen/renderer/elements/InkInstanceContext.js')
const { useVirtualScroll } = await import('../../src/screen/virtual-message-list/useVirtualScroll.js')

const SELF = 'scripts/scroll/prove-virtual-scroll-recording.ts'
const RECORDING = join(import.meta.dirname, 'recordings', 'virtual-scroll.txt')
const UNIT = 'useVirtualScroll'
const REFS = [
  'heightCache', 'elements', 'refCallbacks', 'offsetsVersion', 'offsetsBuffer', 'offsetsBuiltVersion', 'offsetsBuiltCount', 'offsetsBuiltKeys', 'listOrigin',
  'spacerElement', 'prevRange', 'prevColumns', 'prevItemKeys', 'measurementSkip', 'freezeRenders', 'prevScrollAtCommit', 'msPerItemEma', 'contentPin',
  'lastWrittenTop', 'keyIndex', 'minChangedIndex', 'reflowHold', 'outOfLayout', 'laidOut', 'listCommitting', 'painted', 'afterLayout', 'prevCommittedRange',
]

type Handle = import('../../src/screen/renderer/elements/ScrollBox.js').ScrollBoxHandle
type Result = ReturnType<typeof useVirtualScroll>
type HookCall = { name: string; args: unknown[]; out: unknown }
type Dispatcher = Record<string, (...args: unknown[]) => unknown>
type World = { keys: readonly string[]; columns: number; header: number; footer: number; hidden: boolean; pokes: number }
type Stage = {
  say: (line: string) => void
  step: (label: string, act: () => void) => Promise<void>
  world: () => World
  list: (next: Partial<World>) => void
  rows: (rowsOf: (key: string, columns: number) => number) => void
  grow: (key: string, rows: number) => void
  scroll: { top: number; pending: number; viewport: number; sticky: boolean }
  attach: (on: boolean) => void
  notify: () => void
  wheel: (rows: number) => void
  frame: () => void
  cost: (ms: number) => void
  ask: (label: string, read: (result: Result) => unknown) => void
  result: () => Result
  pinned: () => string
  poke: () => void
  append: (count: number) => void
  jump: (top: number) => void
  peek: (ref: string) => unknown
  close: () => Promise<void>
}

const internals = (React as unknown as Record<string, { H: Dispatcher | null }>)['__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE']!
const h = React.createElement
const digest = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 10)
const runsOf = (names: string[]): string[] => {
  const out: [string, number][] = []
  for (const name of names) {
    const last = out[out.length - 1]
    if (last !== undefined && last[0] === name) last[1]++
    else out.push([name, 1])
  }
  return out.map(([name, times]) => (times === 1 ? name : `${name}×${times}`))
}
const at = (key: string): number => Number(key.slice(1))
const keysOf = (count: number, from = 0): string[] => Array.from({ length: count }, (_, at) => `k${String(from + at).padStart(3, '0')}`)

async function stage(lines: string[], start: { world: World; rowsOf: (key: string, columns: number) => number; viewport: number; attached?: boolean; top?: number; cost?: number }): Promise<Stage> {
  const ids = new Map<object, string>()
  const counts = new Map<string, number>()
  const idOf = (kind: string, value: object): string => {
    const known = ids.get(value)
    if (known !== undefined) return known
    const next = (counts.get(kind) ?? 0) + 1
    counts.set(kind, next)
    const id = `${kind}#${next}`
    ids.set(value, id)
    return id
  }
  const say = (line: string): void => void lines.push(line)

  let world = start.world
  let rowsOf = start.rowsOf
  const grown = new Map<string, number>()
  const rowsNow = (key: string): number => grown.get(key) ?? rowsOf(key, world.columns)
  const listListeners = new Set<() => void>()
  const rowListeners = new Map<string, Set<() => void>>()
  const allRows = new Set<() => void>()

  const scroll = { top: start.top ?? 0, pending: 0, viewport: start.viewport, sticky: start.top === undefined }
  const scrollListeners = new Set<() => void>()
  let bounds: { min: number | undefined; max: number | undefined } = { min: undefined, max: undefined }
  let ink: { subscribeLayout: (listener: () => void) => () => void } | undefined
  let content: { layoutNode?: { getComputedHeight: () => number } } | null = null
  const notify = (): void => {
    for (const listener of [...scrollListeners]) listener()
  }
  const handle = {
    getScrollTop: () => scroll.top,
    getPendingDelta: () => scroll.pending,
    getViewportHeight: () => scroll.viewport,
    isSticky: () => scroll.sticky,
    subscribe: (listener: () => void) => {
      say('    handle.subscribe')
      scrollListeners.add(listener)
      return () => {
        say('    handle.subscribe ended')
        scrollListeners.delete(listener)
      }
    },
    subscribeLayout: (listener: () => void) => {
      say('    handle.subscribeLayout')
      const end = ink!.subscribeLayout(() => {
        const before = refsText()
        listener()
        const after = refsText()
        if (after !== before) saidRefs('    after the layout listener: ')
      })
      return () => {
        say('    handle.subscribeLayout ended')
        end()
      }
    },
    setClampBounds: (min: number | undefined, max: number | undefined) => {
      if (bounds.min !== min || bounds.max !== max) say(`    handle.setClampBounds(${min}, ${max === Number.MAX_SAFE_INTEGER ? 'MAX' : max})`)
      bounds = { min, max }
    },
    pinScrollTop: (y: number) => {
      say(`    handle.pinScrollTop(${y})`)
      scroll.top = Math.max(0, Math.floor(y))
    },
    scrollTo: (y: number) => {
      say(`    handle.scrollTo(${y})`)
      scroll.sticky = false
      scroll.pending = 0
      scroll.top = Math.max(0, Math.floor(y))
      notify()
    },
  } as unknown as Handle
  const scrollRef: { current: Handle | null } = { current: start.attached === false ? null : handle }

  const text = (value: unknown): string => {
    if (value === undefined) return 'undefined'
    if (value === null) return 'null'
    if (typeof value === 'number') return Number.isInteger(value) || !Number.isFinite(value) ? String(value) : value.toFixed(6)
    if (typeof value === 'function') return idOf('fn', value)
    if (typeof value !== 'object') return JSON.stringify(value)
    if (value === scrollRef) return 'scrollRef'
    if (value instanceof Float64Array) return `f64[${value.length}]@${digest(Array.from(value).join(','))}`
    if (value instanceof Map) {
      const entries = [...value].map(([key, held]) => `${key}:${typeof held === 'number' ? held : typeof held}`)
      return entries.length <= 8 ? `map{${entries.join(' ')}}` : `map[${entries.length}]@${digest(entries.join(' '))}`
    }
    if ('nodeName' in value) return idOf('element', value)
    if (Array.isArray(value)) {
      if (value.length === 2 && typeof value[0] === 'number') return `${idOf('range', value)}[${value[0]},${value[1]}]`
      return `${idOf('keys', value)}(${value.length})`
    }
    return `{${Object.entries(value).map(([key, held]) => `${key}:${text(held)}`).join(' ')}}`
  }

  const refs: { current: unknown }[] = []
  let refsSaid: string[] = []
  const held = (ref: { current: unknown }, at: number): string => (REFS[at] === 'prevCommittedRange' && Array.isArray(ref.current) ? `[${ref.current.join(',')}]` : text(ref.current))
  const refsText = (): string => refs.map(held).join('|')
  const saidRefs = (head: string): void => {
    const now = refs.map(held)
    const moved = now.flatMap((value, at) => (value === refsSaid[at] ? [] : [`${REFS[at] ?? `ref${at}`}=${value}`]))
    refsSaid = now
    if (moved.length > 0) say(`${head}${moved.join(' ')}`)
  }

  let traceRead = existsSync(TRACE) ? readFileSync(TRACE, 'utf-8').split('\n').filter(line => line !== '').length : 0
  const saidTrace = (): void => {
    if (!existsSync(TRACE)) return
    const all = readFileSync(TRACE, 'utf-8').split('\n').filter(line => line !== '')
    for (const line of all.slice(traceRead)) {
      const { t: _t, ev: _ev, ...rest } = JSON.parse(line) as Record<string, unknown>
      say(`    trace ${JSON.stringify(rest)}`)
    }
    traceRead = all.length
  }

  const clock = { now: 1000, cost: start.cost ?? 1 }
  const realNow = performance.now.bind(performance)
  const scripted = (on: boolean): void => {
    performance.now = on ? () => clock.now : realNow
  }

  let renders = 0
  let commits = 0
  let hooksSaid: string[] = []
  let latest: Result | null = null
  let doorsSaid = ''
  const saidHooks = (calls: HookCall[]): void => {
    const now = calls.map(call => {
      const deps = call.name === 'useCallback' || call.name === 'useMemo' || call.name === 'useEffect' || call.name === 'useLayoutEffect' ? call.args[1] : undefined
      const depsText = Array.isArray(deps) ? `[${deps.map(text).join(',')}]` : deps === undefined ? '' : `[${text(deps)}]`
      const outText = call.name === 'useRef' || call.name === 'useEffect' || call.name === 'useLayoutEffect' ? '' : call.name === 'useReducer' ? ` -> ${text((call.out as unknown[])[0])}` : ` -> ${text(call.out)}`
      return `${call.name}${depsText}${outText}`
    })
    if (hooksSaid.length === 0) say(`    hooks ${runsOf(now).join(' · ')}`)
    else if (now.length !== hooksSaid.length || now.some((line, at) => line.split(/[[ ]/)[0] !== hooksSaid[at]!.split(/[[ ]/)[0])) say(`    hooks IN ANOTHER ORDER ${now.join(' · ')}`)
    else {
      const moved = now.flatMap((line, at) => (line === hooksSaid[at] ? [] : [`${at + 1}:${line}`]))
      if (moved.length > 0) say(`    hooks ${moved.join(' · ')}`)
    }
    hooksSaid = now
    let at = 0
    for (const call of calls) {
      if (call.name !== 'useRef') continue
      const ref = call.out as { current: unknown }
      if (refs[at] === undefined) refs[at] = ref
      else if (refs[at] !== ref) say(`    ref ${REFS[at] ?? at} IS ANOTHER OBJECT`)
      at++
    }
  }

  function Item({ name, measureRef }: { name: string; measureRef: (el: unknown) => void }): React.ReactNode {
    const rows = React.useSyncExternalStore(
      listener => {
        const own = rowListeners.get(name) ?? new Set()
        rowListeners.set(name, own)
        own.add(listener)
        allRows.add(listener)
        return () => {
          own.delete(listener)
          allRows.delete(listener)
        }
      },
      () => rowsNow(name),
    )
    return h(Box, { ref: measureRef as never, flexShrink: 0, height: rows })
  }
  const Row = React.memo(Item)

  function Probe(): React.ReactNode {
    const shown = React.useSyncExternalStore(
      listener => {
        listListeners.add(listener)
        return () => listListeners.delete(listener)
      },
      () => world,
    )
    ink = React.useContext(InkInstanceContext) as typeof ink
    React.useLayoutEffect(() => {
      clock.now += clock.cost
      scripted(true)
    })
    renders++
    say(`  render ${renders}: keys=${text(shown.keys)} columns=${shown.columns} top=${scroll.top} pending=${scroll.pending} viewport=${scroll.viewport} sticky=${scroll.sticky}${scrollRef.current === null ? ' no handle' : ''}`)
    const calls: HookCall[] = []
    const real = internals?.H
    if (real === null || real === undefined) throw new Error(`${SELF}: React's dispatcher is not where React 19 keeps it, so the hook calls of ${UNIT} cannot be read`)
    internals.H = new Proxy(real, {
      get(target, name, receiver) {
        const member = Reflect.get(target, name, receiver) as unknown
        if (typeof member !== 'function' || typeof name !== 'string' || !name.startsWith('use')) return member
        return (...args: unknown[]): unknown => {
          const out = (member as (...given: unknown[]) => unknown).apply(target, args)
          calls.push({ name, args, out })
          return out
        }
      },
    })
    scripted(true)
    let result: Result
    try {
      result = useVirtualScroll(scrollRef, shown.keys, shown.columns)
    } finally {
      scripted(false)
      internals.H = real
    }
    latest = result
    saidHooks(calls)
    saidTrace()
    const offsets = Array.from({ length: shown.keys.length + 1 }, (_, at) => result.offsets[at])
    const doors = `measureRef=${text(result.measureRef)} spacerRef=${text(result.spacerRef)} getItemTop=${text(result.getItemTop)} getItemElement=${text(result.getItemElement)} getItemHeight=${text(result.getItemHeight)} scrollToIndex=${text(result.scrollToIndex)}`
    say(`    answers range=[${result.range[0]},${result.range[1]}] topSpacer=${result.topSpacer} bottomSpacer=${result.bottomSpacer} offsets=${offsets.length <= 12 ? `[${offsets.join(',')}]` : `${offsets.length}:${offsets[offsets.length - 1]}@${digest(offsets.join(','))}`}${doors === doorsSaid ? '' : ` ${doors}`}`)
    doorsSaid = doors
    saidRefs('    refs after the render: ')
    React.useLayoutEffect(() => {
      scripted(false)
      commits++
      saidTrace()
      saidRefs(`  commit ${commits}: `)
    })
    const [first, last] = result.range
    return h(
      Box,
      { flexDirection: 'column', width: shown.columns, flexShrink: 0, display: shown.hidden ? 'none' : 'flex', ref: ((el: typeof content) => void (content = el)) as never },
      shown.header > 0 ? h(Box, { flexShrink: 0, height: shown.header }) : null,
      h(Box, { flexShrink: 0, height: result.topSpacer, ref: result.spacerRef as never }),
      ...shown.keys.slice(first, last).map(key => h(Row, { key, name: key, measureRef: result.measureRef(key) as never })),
      result.bottomSpacer > 0 ? h(Box, { flexShrink: 0, height: result.bottomSpacer }) : null,
      shown.footer > 0 ? h(Box, { flexShrink: 0, height: shown.footer }) : null,
    )
  }

  let view: Mounted | null = null
  await React.act(async () => {
    view = await mountOffscreen(h(Probe), start.world.columns, start.viewport + 4)
  })
  saidTrace()
  saidRefs('  at rest: ')

  return {
    say,
    scroll,
    world: () => world,
    notify,
    step: async (label, act) => {
      say(`step: ${label}`)
      await React.act(async () => {
        act()
      })
      saidTrace()
      saidRefs('  at rest: ')
    },
    list: next => {
      world = { ...world, ...next }
      for (const listener of [...listListeners]) listener()
      for (const listener of [...allRows]) listener()
    },
    rows: next => {
      rowsOf = next
      grown.clear()
      for (const listener of [...allRows]) listener()
    },
    grow: (key, rows) => {
      grown.set(key, rows)
      for (const listener of [...(rowListeners.get(key) ?? [])]) listener()
    },
    attach: on => {
      scrollRef.current = on ? handle : null
    },
    wheel: rows => {
      scroll.sticky = false
      scroll.pending += rows
      notify()
    },
    frame: () => {
      const height = content?.layoutNode?.getComputedHeight() ?? 0
      const most = Math.max(0, height - scroll.viewport)
      if (scroll.sticky && scroll.pending >= 0) {
        scroll.top = most
        scroll.pending = 0
        return
      }
      const backlog = Math.abs(scroll.pending)
      const travel = Math.min(backlog, Math.max(1, scroll.viewport - 1))
      const wanted = scroll.top + Math.sign(scroll.pending) * travel
      scroll.top = Math.max(0, Math.min(wanted, most))
      scroll.pending = scroll.top === wanted ? scroll.pending - Math.sign(scroll.pending) * travel : 0
    },
    cost: ms => {
      clock.cost = ms
    },
    ask: (label, read) => {
      say(`  ask ${label}: ${latest === null ? 'no result' : JSON.stringify(read(latest)) ?? 'undefined'}`)
    },
    result: () => latest!,
    pinned: () => (refs[REFS.indexOf('contentPin')]?.current as { key: string } | null)?.key ?? 'no row',
    poke: () => {
      world = { ...world, pokes: world.pokes + 1 }
      for (const listener of [...listListeners]) listener()
    },
    append: count => {
      const keys = world.keys as string[]
      keys.push(...keysOf(count, keys.length === 0 ? 0 : at(keys[keys.length - 1]!) + 1))
      world = { ...world, pokes: world.pokes + 1 }
      for (const listener of [...listListeners]) listener()
    },
    jump: top => handle.scrollTo(top),
    peek: name => refs[REFS.indexOf(name)]?.current,
    close: async () => {
      await React.act(async () => {
        view?.unmount()
      })
      scripted(false)
    },
  }
}

const mixed = (key: string): number => 1 + (at(key) % 4)
const wide = (key: string, columns: number): number => Math.ceil((40 + (at(key) % 5) * 30) / columns)
const listOf = (count: number, over: Partial<World> = {}): World => ({ keys: keysOf(count), columns: 80, header: 0, footer: 0, hidden: false, pokes: 0, ...over })

async function atTheTail(lines: string[], world: World, rowsOf: (key: string, columns: number) => number, viewport = 20): Promise<Stage> {
  const s = await stage(lines, { world, rowsOf, viewport })
  await s.step('a frame follows the tail, and the list renders', () => {
    s.frame()
    s.poke()
  })
  return s
}

async function offTheTail(lines: string[], world: World, rowsOf: (key: string, columns: number) => number, up: number, viewport = 20): Promise<Stage> {
  const s = await atTheTail(lines, world, rowsOf, viewport)
  await s.step(`the wheel turns ${up} rows up`, () => s.wheel(-up))
  await s.step('the frames drain it, and the list renders', () => {
    for (let n = 0; n < 8; n++) s.frame()
    s.poke()
  })
  return s
}

const scenes: [name: string, run: (lines: string[]) => Promise<void>][] = [
  ['a short list at the tail, mounted before the pane has a height', async lines => {
    const s = await stage(lines, { world: listOf(12), rowsOf: mixed, viewport: 0 })
    await s.step('the pane gets its height', () => {
      s.scroll.viewport = 20
      s.poke()
    })
    await s.step('a frame follows the tail', () => {
      s.frame()
      s.poke()
    })
    await s.step('two rows arrive', () => s.list({ keys: keysOf(14) }))
    await s.step('every row leaves', () => s.list({ keys: [] }))
    await s.step('five rows arrive', () => s.list({ keys: keysOf(5, 20) }))
    await s.close()
  }],
  ['no scroll handle at the mount, then one', async lines => {
    const s = await stage(lines, { world: listOf(60), rowsOf: mixed, viewport: 20, attached: false })
    s.ask('scrollToIndex(3) with no handle', result => result.scrollToIndex(3))
    await s.step('the handle arrives, and the list renders', () => {
      s.attach(true)
      s.poke()
    })
    await s.step('the wheel turns, with nothing subscribed', () => s.wheel(-10))
    await s.step('the list renders', () => s.poke())
    await s.close()
  }],
  ['a long list follows the tail', async lines => {
    const s = await atTheTail(lines, listOf(200, { header: 3 }), key => (at(key) === 190 ? 60 : mixed(key)))
    await s.step('three rows arrive in a new keys list', () => s.list({ keys: keysOf(203) }))
    await s.step('a frame follows the tail, and the list renders', () => {
      s.frame()
      s.poke()
    })
    await s.step('two rows arrive in the same keys list', () => s.append(2))
    await s.step('a frame follows the tail, and one more row arrives in the same list', () => {
      s.frame()
      s.append(1)
    })
    await s.step('a row in the pane grows by its own state', () => s.grow('k201', 9))
    await s.step('the tall row collapses by its own state', () => s.grow('k190', 1))
    await s.step('a frame follows the tail, and the list renders', () => {
      s.frame()
      s.poke()
    })
    await s.step('the list renders again with nothing changed', () => s.poke())
    await s.close()
  }],
  ['the wheel up from the tail and back', async lines => {
    const s = await atTheTail(lines, listOf(200, { header: 3 }), mixed)
    for (const turn of [1, 2, 3]) {
      await s.step(`notch ${turn}: three rows up`, () => s.wheel(-3))
      await s.step('a frame drains it, and the list renders', () => {
        s.frame()
        s.poke()
      })
    }
    await s.step('forty rows up in one notch', () => s.wheel(-40))
    await s.step('one frame drains nineteen of them', () => s.frame())
    await s.step('the list renders in the middle of the drain', () => s.poke())
    await s.step('the frames drain the rest, and the list renders', () => {
      for (let n = 0; n < 4; n++) s.frame()
      s.poke()
    })
    await s.step('six rows down', () => s.wheel(6))
    await s.step('a frame drains it, and the list renders', () => {
      s.frame()
      s.poke()
    })
    await s.step('the list renders again with nothing changed', () => s.poke())
    await s.step('the view goes back to the tail', () => {
      s.scroll.sticky = true
      s.scroll.pending = 0
      s.notify()
    })
    await s.step('a frame follows the tail, and the list renders', () => {
      s.frame()
      s.poke()
    })
    await s.close()
  }],
  ['a flick of two hundred rows, on a fast machine and on a slow one', async lines => {
    for (const [machine, cost] of [['fast', 0.5], ['slow', 900]] as const) {
      lines.push(`machine: ${machine}`)
      const s = await stage(lines, { world: listOf(400, { header: 3 }), rowsOf: mixed, viewport: 20, cost })
      await s.step('a frame follows the tail, and the list renders', () => {
        s.frame()
        s.poke()
      })
      await s.step('one notch of fifty rows up', () => s.wheel(-50))
      await s.step('the frames drain it, and the list renders', () => {
        for (let n = 0; n < 3; n++) s.frame()
        s.poke()
      })
      for (const notch of [1, 2, 3, 4, 5]) {
        await s.step(`notch ${notch}: forty rows up`, () => s.wheel(-40))
        await s.step('one frame', () => s.frame())
      }
      await s.step('the frames drain the rest, and the list renders', () => {
        for (let n = 0; n < 12; n++) s.frame()
        s.poke()
      })
      await s.step('a flick of three hundred rows down', () => s.wheel(300))
      await s.step('the frames drain it, and the list renders', () => {
        for (let n = 0; n < 20; n++) s.frame()
        s.poke()
      })
      await s.close()
    }
  }],
  ['jumps by scrollToIndex', async lines => {
    const s = await atTheTail(lines, listOf(300, { header: 3 }), mixed)
    await s.step('scrollToIndex(0)', () => s.result().scrollToIndex(0))
    await s.step('the list renders', () => s.poke())
    await s.step('the view jumps above the list, to the first row of the pane', () => s.jump(0))
    await s.step('one row down, still above the list', () => s.wheel(1))
    await s.step('a frame drains it, and the list renders', () => {
      s.frame()
      s.poke()
    })
    await s.step('scrollToIndex(150)', () => s.result().scrollToIndex(150))
    await s.step('the list renders', () => s.poke())
    await s.step('scrollToIndex(-1), scrollToIndex(300) and scrollToIndex(299)', () => {
      s.result().scrollToIndex(-1)
      s.result().scrollToIndex(300)
      s.result().scrollToIndex(299)
    })
    await s.step('the list renders', () => s.poke())
    await s.close()
  }],
  ['rows change height around a view pinned off the tail', async lines => {
    const s = await offTheTail(lines, listOf(200, { header: 3 }), key => (at(key) === 160 ? 12 : mixed(key)), 78)
    s.ask('the row the pane opens on', () => s.pinned())
    await s.step('a row above the pane grows by its own state', () => s.grow('k150', 9))
    await s.step('the list renders', () => s.poke())
    await s.step('the same row shrinks again', () => s.grow('k150', 1))
    await s.step('a row under the pane grows', () => s.grow('k185', 30))
    await s.step('the row the pane opens on collapses to one line', () => s.grow(s.pinned(), 1))
    await s.step('the list renders', () => s.poke())
    await s.step('a row far above grows and one under shrinks in one commit', () => {
      s.grow('k140', 7)
      s.grow('k185', 2)
    })
    await s.step('the list renders again with nothing changed', () => s.poke())
    await s.close()
  }],
  ['rows arrive and leave around a view pinned off the tail', async lines => {
    const s = await offTheTail(lines, listOf(200, { header: 3 }), mixed, 60)
    await s.step('three rows arrive in the same keys list', () => s.append(3))
    await s.step('two more arrive in a new keys list', () => s.list({ keys: keysOf(205) }))
    await s.step('ten older rows arrive at the head', () => s.list({ keys: [...keysOf(10, 900), ...keysOf(205)] }))
    await s.step('the list renders', () => s.poke())
    await s.step('the row the pane opens on leaves the list', () => {
      const gone = s.pinned()
      s.list({ keys: s.world().keys.filter(key => key !== gone) })
    })
    await s.step('the list renders', () => s.poke())
    await s.step('forty rows leave at the tail', () => s.list({ keys: s.world().keys.slice(0, -40) }))
    await s.step('the list renders', () => s.poke())
    await s.step('the pane loses its height, the row it opened on leaves and a row grows', () => {
      const gone = s.pinned()
      s.scroll.viewport = 0
      s.list({ keys: s.world().keys.filter(key => key !== gone) })
      s.grow('k150', 6)
    })
    await s.step('the pane gets its height back', () => {
      s.scroll.viewport = 20
      s.poke()
    })
    await s.close()
  }],
  ['a re-wrap at the tail', async lines => {
    const s = await atTheTail(lines, listOf(120, { header: 2 }), wide)
    await s.step('the pane narrows to forty columns', () => s.list({ columns: 40 }))
    await s.step('a frame follows the tail, and the list renders', () => {
      s.frame()
      s.poke()
    })
    await s.step('the pane widens to a hundred and sixty', () => s.list({ columns: 160 }))
    await s.step('a frame follows the tail, and the list renders', () => {
      s.frame()
      s.poke()
    })
    await s.step('the pane narrows to eighty and the wheel turns sixty rows up in the same beat', () => {
      s.list({ columns: 80 })
      s.wheel(-60)
    })
    await s.step('the frames drain it, and the list renders', () => {
      for (let n = 0; n < 3; n++) s.frame()
      s.poke()
    })
    await s.step('the pane narrows to forty and twenty rows leave in the same beat', () => s.list({ columns: 40, keys: s.world().keys.slice(0, -20) }))
    await s.step('the list renders', () => s.poke())
    await s.close()
  }],
  ['a re-wrap off the tail', async lines => {
    const s = await offTheTail(lines, listOf(120, { header: 2 }), wide, 50)
    s.ask('the row the pane opens on', () => s.pinned())
    await s.step('the pane narrows to forty columns', () => s.list({ columns: 40 }))
    await s.step('the list renders', () => s.poke())
    await s.step('the view jumps to the last line of a row of four', () => s.jump(2 + s.result().offsets[94]! + 3))
    await s.step('the list renders', () => s.poke())
    await s.step('the pane widens to a hundred and sixty', () => s.list({ columns: 160 }))
    await s.step('the list renders', () => s.poke())
    await s.step('the pane narrows to eighty again, with a wheel notch in the same beat', () => {
      s.list({ columns: 80 })
      s.wheel(-3)
    })
    await s.step('a frame drains it, and the list renders', () => {
      s.frame()
      s.poke()
    })
    await s.close()
  }],
  ['the list leaves the layout and comes back', async lines => {
    const s = await offTheTail(lines, listOf(150, { header: 3 }), mixed, 50)
    s.ask('getItemTop of the row the pane opens on', result => result.getItemTop(s.world().keys.indexOf(s.pinned())))
    await s.step('the list is hidden', () => s.list({ hidden: true }))
    s.ask('getItemTop of that row, out of the layout', result => result.getItemTop(s.world().keys.indexOf(s.pinned())))
    await s.step('the wheel turns while it is hidden, and the list renders', () => {
      s.wheel(-12)
      s.frame()
      s.poke()
    })
    await s.step('a row grows by its own state while it is hidden', () => s.grow(s.pinned(), 8))
    await s.step('two rows arrive while it is hidden', () => s.list({ keys: keysOf(152) }))
    await s.step('the list is shown again', () => s.list({ hidden: false }))
    await s.step('the list renders', () => s.poke())
    await s.close()
  }],
  ['a list mounted out of sight is scrolled before it is ever laid out', async lines => {
    const s = await stage(lines, { world: listOf(120, { hidden: true }), rowsOf: mixed, viewport: 20 })
    await s.step('a jump to the head', () => s.result().scrollToIndex(0))
    await s.step('ninety rows down', () => s.wheel(90))
    await s.step('the view stands ninety rows down, and the list renders', () => {
      s.scroll.top = 90
      s.scroll.pending = 0
      s.poke()
    })
    await s.step('the list is shown', () => s.list({ hidden: false }))
    await s.step('the list renders', () => s.poke())
    await s.close()
  }],
  ['the view stands in a reply under the list', async lines => {
    const s = await atTheTail(lines, listOf(30, { header: 2, footer: 70 }), mixed)
    await s.step('ten rows up, still inside the reply', () => s.wheel(-10))
    await s.step('a frame drains it, and the list renders', () => {
      s.frame()
      s.poke()
    })
    await s.step('five more rows up', () => s.wheel(-5))
    await s.step('a frame drains it, and the list renders', () => {
      s.frame()
      s.poke()
    })
    await s.step('the view jumps to the first line under the list', () => s.jump(2 + s.result().offsets[s.world().keys.length]!))
    await s.step('the list renders', () => s.poke())
    await s.step('the reply grows by eight rows', () => s.list({ footer: 78 }))
    await s.step('the reply joins the list as one row', () => {
      s.rows(key => (at(key) === 30 ? 78 : mixed(key)))
      s.list({ keys: keysOf(31), footer: 0 })
    })
    await s.step('the list renders', () => s.poke())
    await s.step('sixty rows up, into the list', () => s.wheel(-60))
    await s.step('the frames drain it, and the list renders', () => {
      for (let n = 0; n < 4; n++) s.frame()
      s.poke()
    })
    await s.close()
  }],
  ['a list mounted off the tail', async lines => {
    const s = await stage(lines, { world: listOf(200, { header: 3 }), rowsOf: mixed, viewport: 20, top: 150 })
    await s.step('the list renders', () => s.poke())
    await s.step('four rows down', () => s.wheel(4))
    await s.step('a frame drains it, and the list renders', () => {
      s.frame()
      s.poke()
    })
    await s.step('a hundred and fifty rows down in one notch, through rows never measured', () => s.wheel(150))
    await s.step('the frames drain it, and the list renders', () => {
      for (let n = 0; n < 9; n++) s.frame()
      s.poke()
    })
    await s.close()
    lines.push('mounted on the first line under the list')
    const under = await stage(lines, { world: listOf(20, { footer: 40 }), rowsOf: mixed, viewport: 20, top: 60 })
    await under.step('the list renders', () => under.poke())
    await under.close()
  }],
  ['new rows wait unmeasured while the list is out of the layout', async lines => {
    const s = await atTheTail(lines, listOf(60, { header: 2, footer: 50 }), mixed)
    const measured = s.result().offsets[60]!
    await s.step('the list is hidden', () => s.list({ hidden: true }))
    await s.step('three rows arrive in the same keys list', () => s.append(3))
    await s.step('the view jumps four lines under the measured rows', () => s.jump(2 + measured + 4))
    await s.step('the list renders', () => s.poke())
    await s.step('the list is shown again', () => s.list({ hidden: false }))
    await s.step('the list renders', () => s.poke())
    await s.close()
  }],
  ['rows mounted out of the layout are kept until they are measured', async lines => {
    const s = await atTheTail(lines, listOf(200, { header: 3 }), mixed)
    await s.step('the list is hidden', () => s.list({ hidden: true }))
    await s.step('the view jumps to row seventy', () => s.jump(3 + s.result().offsets[70]!))
    await s.step('the list renders', () => s.poke())
    await s.step('the row the pane opens on leaves the list, and the view stands on row one hundred and thirty in the same beat', () => {
      const gone = s.pinned()
      s.scroll.top = 3 + s.result().offsets[130]!
      s.list({ keys: s.world().keys.filter(key => key !== gone) })
    })
    await s.step('the list renders', () => s.poke())
    await s.step('the list is shown again', () => s.list({ hidden: false }))
    await s.step('the list renders', () => s.poke())
    await s.close()
  }],
  ['a jump that lands one slide past the mounted rows', async lines => {
    const s = await atTheTail(lines, listOf(100), () => 10)
    await s.step('a jump to the hundredth line', () => s.jump(100))
    await s.step('the list renders', () => s.poke())
    await s.step('a jump to where the first row to mount is one slide under the last one mounted', () => {
      const mounted = s.peek('prevRange') as readonly [number, number]
      const slide = Math.min(60, Math.max(8, Math.round(8 / (s.peek('msPerItemEma') as number))))
      s.say(`  the mounted rows end at ${mounted[1]}, the slide is ${slide}`)
      s.jump(s.result().offsets[mounted[1] + slide]! + 80)
    })
    await s.step('the list renders', () => s.poke())
    await s.close()
  }],
  ['a jump above the list while it is out of the layout', async lines => {
    const s = await atTheTail(lines, listOf(80, { header: 5 }), mixed)
    await s.step('the list is hidden', () => s.list({ hidden: true }))
    await s.step('the view jumps to the second row of the pane, above the list', () => s.jump(1))
    await s.step('the list renders', () => s.poke())
    await s.step('the list is shown again', () => s.list({ hidden: false }))
    await s.step('the list renders', () => s.poke())
    await s.close()
  }],
  ['rows of no height', async lines => {
    const s = await atTheTail(lines, listOf(90), key => (at(key) % 3 === 0 ? 0 : 2))
    s.ask('getItemHeight of a row of no height, of a row of two, of none', result => [result.getItemHeight(87), result.getItemHeight(88), result.getItemHeight(90)])
    await s.step('a row of no height gets three lines by its own state', () => s.grow('k087', 3))
    await s.step('it loses them again', () => s.grow('k087', 0))
    await s.step('the wheel turns thirty rows up', () => s.wheel(-30))
    await s.step('the frames drain it, and the list renders', () => {
      for (let n = 0; n < 3; n++) s.frame()
      s.poke()
    })
    await s.close()
  }],
  ['a pane taller than three hundred rows', async lines => {
    const s = await stage(lines, { world: listOf(1000), rowsOf: () => 1, viewport: 400 })
    await s.step('the list renders before any frame', () => s.poke())
    await s.step('a frame follows the tail, and the list renders', () => {
      s.frame()
      s.poke()
    })
    await s.step('the handle goes and the pane narrows in one beat', () => {
      s.attach(false)
      s.list({ columns: 40 })
    })
    await s.step('the list renders', () => s.poke())
    await s.close()
    lines.push('the same pane, wheeled off the tail')
    const wheeled = await atTheTail(lines, listOf(1000), () => 1, 400)
    await wheeled.step('fifty rows up', () => wheeled.wheel(-50))
    await wheeled.step('a frame drains it, and the list renders', () => {
      wheeled.frame()
      wheeled.poke()
    })
    await wheeled.close()
  }],
  ['what the callbacks answer', async lines => {
    const s = await offTheTail(lines, listOf(100, { header: 3 }), mixed, 30)
    const first = s.result()
    s.ask('getItemTop of a mounted row, of a row not mounted, of no row', result => [result.getItemTop(result.range[0]), result.getItemTop(0), result.getItemTop(100)])
    s.ask('getItemElement of a mounted row, of a row not mounted, of no row', result => [result.getItemElement(result.range[0]) !== null, result.getItemElement(0), result.getItemElement(100)])
    s.ask('getItemHeight of a mounted row, of a row not mounted, of no row', result => [result.getItemHeight(result.range[0]), result.getItemHeight(0), result.getItemHeight(100)])
    s.ask('measureRef answers one callback a key', result => result.measureRef('k050') === result.measureRef('k050'))
    await s.step('the keys are a new list of the same rows', () => s.list({ keys: keysOf(100) }))
    s.ask('the callbacks that hold the keys are new, the others are the first ones', result => ({
      measureRef: result.measureRef === first.measureRef,
      spacerRef: result.spacerRef === first.spacerRef,
      scrollToIndex: result.scrollToIndex === first.scrollToIndex,
      getItemTop: result.getItemTop === first.getItemTop,
      getItemElement: result.getItemElement === first.getItemElement,
      getItemHeight: result.getItemHeight === first.getItemHeight,
      oneRowsCallback: result.measureRef('k050') === first.measureRef('k050'),
    }))
    await s.close()
  }],
]

async function record(): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (const [name, run] of scenes) {
    const lines: string[] = []
    if (existsSync(TRACE)) writeFileSync(TRACE, '')
    await run(lines)
    out.set(name, lines)
  }
  return out
}

const written = (recorded: Map<string, string[]>): string => `refs in the order the hook asks for them: ${REFS.join(' ')}\n\n${[...recorded].map(([name, lines]) => `## ${name}\n${lines.join('\n')}\n`).join('\n')}`

function read(text: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  let lines: string[] | null = null
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) out.set(line.slice(3), (lines = []))
    else if (lines !== null) lines.push(line)
  }
  for (const held of out.values()) while (held.length > 0 && held[held.length - 1] === '') held.pop()
  return out
}

const cut = (line: string | undefined): string => (line === undefined ? '(no line)' : line.length > 240 ? `${line.slice(0, 240)}…` : line)

function firstDifference(stood: string[], stands: string[]): string | null {
  const reach = Math.max(stood.length, stands.length)
  for (let at = 0; at < reach; at++) {
    if (stood[at] !== stands[at]) return `line ${at + 1}\n      stood:  ${cut(stood[at])}\n      stands: ${cut(stands[at])}`
  }
  return null
}

let failures = 0
const fail = (line: string): void => {
  failures++
  console.log(`  [FAIL] ${line}`)
}

const source = Bun.resolveSync('../../src/screen/virtual-message-list/useVirtualScroll.js', import.meta.dirname)
if (useVirtualScroll.name === UNIT && source.replaceAll('\\', '/').endsWith('/src/screen/virtual-message-list/useVirtualScroll.ts')) console.log(`  [PASS] the hook recorded is the product's own ${UNIT} of src/screen/virtual-message-list/useVirtualScroll.ts: no module is replaced; the scroll handle, the rows' heights and the clock are scripted`)
else fail(`the hook under the recording is not the product's own ${UNIT}: it is ${useVirtualScroll.name} of ${source}`)

const first = await record()
const second = await record()
await releaseScratchHome(home)

for (const [name, lines] of first) {
  const twice = firstDifference(lines, second.get(name) ?? [])
  if (twice !== null) fail(`${name}: two recordings in one process differ, so nothing can be compared with it: ${twice}`)
}

if (process.argv.includes('--write')) {
  if (failures === 0) {
    const stood = existsSync(RECORDING) ? read(readFileSync(RECORDING, 'utf-8')) : new Map<string, string[]>()
    for (const [name, lines] of first) {
      const moved = firstDifference(stood.get(name) ?? [], lines)
      if (moved !== null) console.log(`  wrote ${name}: ${stood.has(name) ? moved : `${lines.length} lines, new`}`)
    }
    for (const name of stood.keys()) if (!first.has(name)) console.log(`  dropped ${name}: no scene records it`)
    mkdirSync(dirname(RECORDING), { recursive: true })
    writeFileSync(RECORDING, written(first))
    console.log(`\n${first.size} scenes, ${[...first.values()].reduce((n, lines) => n + lines.length, 0)} lines written to ${RECORDING}`)
  }
  process.exit(failures === 0 ? 0 : 1)
}

if (!existsSync(RECORDING)) fail(`no recording stands at ${RECORDING}: run \`bun run ${SELF} --write\` on a tree whose behaviour is the one to hold, and commit it`)
else {
  const stood = read(readFileSync(RECORDING, 'utf-8'))
  for (const [name, lines] of first) {
    const held = stood.get(name)
    if (held === undefined) {
      fail(`${name}: the scene has no recording; run \`bun run ${SELF} --write\` and commit the recording with the scene`)
      continue
    }
    const moved = firstDifference(held, lines)
    if (moved === null) console.log(`  [PASS] ${name} (${lines.length} lines)`)
    else fail(`the recorded behaviour of ${UNIT} changed in "${name}" at ${moved}\n      if nobody asked for the change, the change is the fault; if it was asked for, run \`bun run ${SELF} --write\`, read the difference it prints, and commit the recording with the change`)
  }
  for (const name of stood.keys()) if (!first.has(name)) fail(`${name}: a recording stands that no scene records; run \`bun run ${SELF} --write\` to drop it`)
}

console.log(`\n${failures === 0 ? '✅' : '❌'} prove-virtual-scroll-recording — ${first.size} scenes, ${failures === 0 ? 'equal to the recording' : `${failures} failed`}`)
process.exit(failures === 0 ? 0 : 1)
