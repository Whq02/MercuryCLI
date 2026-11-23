#!/usr/bin/env bun
// gate-watch: src/screen/themedRenderer.ts src/screen/renderer/frame.ts src/screen/renderer/root.ts src/screen/renderer/instances.ts src/screen/renderer/screenInstance.tsx
import { spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import React from 'react'
import ts from 'typescript'

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')
const CHILD = process.argv.includes('--debug-line') || process.argv.includes('--process-defaults')
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
if (!CHILD) process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'renderer-pins-home-'))
const HOME = process.env.MERCURY_CONFIG_DIR!
delete process.env.MERCURY_HOME
delete process.env.DEBUG
process.env.MERCURY_THEME_PIN = 'dark'

type Engine = {
  options: Record<string, unknown>
  isUnmounted: boolean
  unmount: (error?: Error | number | null) => void
  lastFrameText(): string
}

const stdinStub = (): NodeJS.ReadStream =>
  Object.assign(new EventEmitter(), {
    isTTY: true,
    isRaw: false,
    setRawMode() { return this },
    setEncoding() { return this },
    read() { return null },
    unref() { return this },
    ref() { return this },
    pause() { return this },
    resume() { return this },
  }) as unknown as NodeJS.ReadStream
const screen = (): NodeJS.WriteStream => {
  const stream = new PassThrough() as unknown as NodeJS.WriteStream & { columns?: number; rows?: number }
  stream.columns = 40
  stream.rows = 10
  stream.resume()
  return stream
}
const door = await import('../../src/screen/themedRenderer.ts')
const root = await import('../../src/screen/renderer/root.ts')
const instances = (await import('../../src/screen/renderer/instances.ts')).default
const line = (text: string) => React.createElement(door.Text, null, text)
const quiet = () => ({ stdin: stdinStub(), patchConsole: false, exitOnCtrlC: false })
const engineOn = (stream: NodeJS.WriteStream): Engine | undefined => instances.get(stream) as unknown as Engine | undefined

if (process.argv.includes('--debug-line')) {
  const report = process.argv[process.argv.indexOf('--debug-line') + 1]!
  const before = Math.floor(process.uptime() * 1000)
  const mounted = await root.default(line('debug'), { stdout: screen(), ...quiet() })
  const after = Math.ceil(process.uptime() * 1000)
  mounted.unmount()
  writeFileSync(report, JSON.stringify({ before, after }))
  process.exit(0)
}

if (process.argv.includes('--process-defaults')) {
  const report = process.argv[process.argv.indexOf('--process-defaults') + 1]!
  const mounted = root.renderSync(line('defaults'))
  const knobs = engineOn(process.stdout)?.options
  const facts = {
    registered: knobs !== undefined,
    stdout: knobs?.stdout === process.stdout,
    stdin: knobs?.stdin === process.stdin,
    stderr: knobs?.stderr === process.stderr,
    exitOnCtrlC: knobs?.exitOnCtrlC,
    patchConsole: knobs?.patchConsole,
    keys: knobs ? Object.keys(knobs).sort() : [],
  }
  mounted.unmount()
  writeFileSync(report, JSON.stringify(facts))
  process.exit(0)
}

let failures = 0
const pinsFailHint = 'change the code the section title names: src/screen/themedRenderer.ts (render, createRoot, re-exports), src/screen/renderer/root.ts (renderSync, render, createRoot) or src/screen/renderer/frame.ts (emptyFrame and the frame types); change this file only if the pinned behaviour was meant to change'
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok ? ' — ' + (detail ? detail + ' · ' : '') + pinsFailHint : ''}`)
  if (!ok) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
const scratch = mkdtempSync(join(tmpdir(), 'renderer-pins-'))

const frameMarks = () => {
  const waiting: Array<() => void> = []
  let frames = 0
  return {
    onFrame: () => {
      frames++
      waiting.splice(0).forEach(resolve => resolve())
    },
    painted: () => {
      door.flushPendingSyncWork()
      return new Promise<void>(resolve => waiting.push(resolve))
    },
    count: () => frames,
  }
}

const settleTick = async (start: () => Promise<unknown>): Promise<number> => {
  let tick = 0
  let settledAt = -1
  const run = start().then(
    () => { settledAt = tick },
    () => { settledAt = tick },
  )
  while (settledAt < 0 && tick < 64) {
    await null
    tick++
  }
  await run
  return settledAt
}

const DOOR: Array<[from: string, values: string[], types: string[]]> = [
  ['', ['render', 'createRoot'], ['Instance', 'RenderOptions', 'Root']],
  ['./renderer/reconciler.js', ['flushPendingSyncWork'], []],
  ['./theme/color.js', ['color'], []],
  ['./theme/ThemeProvider.js', ['ThemeProvider', 'usePreviewTheme', 'useTheme', 'useThemeSetting'], []],
  ['./theme/ThemedBox.js', ['Box=default'], ['BoxProps=Props']],
  ['./theme/ThemedText.js', ['Text=default'], ['TextProps=Props']],
  ['./renderer/Ansi.js', ['Ansi'], []],
  ['./renderer/elements/Box.js', ['BaseBox=default'], ['BaseBoxProps=Props']],
  ['./renderer/elements/Text.js', ['BaseText=default'], ['BaseTextProps=Props']],
  ['./renderer/elements/Button.js', ['Button=default'], ['ButtonState', 'ButtonProps=Props']],
  ['./renderer/elements/Link.js', ['Link=default'], ['LinkProps=Props']],
  ['./renderer/elements/MotionParkContext.js', ['MotionParkContext'], []],
  ['./renderer/elements/Newline.js', ['Newline=default'], ['NewlineProps=Props']],
  ['./renderer/elements/NoSelect.js', ['NoSelect'], []],
  ['./renderer/elements/RawAnsi.js', ['RawAnsi'], []],
  ['./renderer/elements/Spacer.js', ['Spacer=default'], []],
  ['./renderer/elements/AppContext.js', [], ['AppProps=Props']],
  ['./renderer/elements/StdinContext.js', [], ['StdinProps=Props']],
  ['./renderer/events/click-event.js', ['ClickEvent'], []],
  ['./renderer/events/emitter.js', ['EventEmitter'], []],
  ['./renderer/events/event.js', ['Event'], []],
  ['./renderer/events/input-event.js', ['InputEvent'], ['Key']],
  ['./renderer/events/terminal-focus-event.js', ['TerminalFocusEvent'], ['TerminalFocusEventType']],
  ['./renderer/focus.js', ['FocusManager'], []],
  ['./renderer/colorize.js', ['paletteCollapsed', 'truecolorActive'], []],
  ['./renderer/measure-element.js', ['measureElement=default', 'elementScreenLeft', 'elementScreenTop'], []],
  ['./renderer/termio/osc.js', ['supportsTabStatus'], []],
  ['./renderer/wrap-text.js', ['wrapText=default'], []],
  ['./renderer/dom.js', [], ['DOMElement']],
  ['./renderer/frame.js', [], ['FlickerReason']],
  ['./renderer/bindings/use-animation-frame.js', ['useAnimationFrame'], []],
  ['./renderer/bindings/use-animation-value.js', ['useAnimationValue'], []],
  ['./renderer/bindings/use-app.js', ['useApp=default'], []],
  ['./renderer/bindings/use-input.js', ['useInput=default'], []],
  ['./renderer/bindings/use-interval.js', ['useAnimationTimer', 'useInterval'], []],
  ['./renderer/bindings/use-selection.js', ['useSelection'], []],
  ['./renderer/bindings/use-stdin.js', ['useStdin=default'], []],
  ['./renderer/bindings/use-terminal-focus.js', ['useTerminalFocus'], []],
  ['./renderer/bindings/use-terminal-title.js', ['useTerminalTitle'], []],
  ['./renderer/bindings/use-terminal-viewport.js', ['useTerminalViewport'], []],
]
const doorRows = DOOR.flatMap(([from, values, types]) =>
  [...values.map(v => ['value', v] as const), ...types.map(t => ['type', t] as const)].map(([kind, spec]) => {
    const [name, source = name] = spec.split('=') as [string, string?]
    return { name, source, kind, from }
  }),
)

section('§1 the door: 61 exports, their kinds, their modules and their source names; the values are the modules\' own objects')
{
  const values = doorRows.filter(r => r.kind === 'value').map(r => r.name).sort()
  const live = Object.keys(door).sort()
  check('at run time the door carries the 44 values and nothing else', same(live, values), `${live.length}: ${live.filter(n => !values.includes(n)).join(' ')} / ${values.filter(n => !live.includes(n)).join(' ')}`)
  const strangers: string[] = []
  for (const row of doorRows.filter(r => r.kind === 'value' && r.from !== '')) {
    const owner = (await import(join(SRC, 'screen', row.from))) as Record<string, unknown>
    if ((door as Record<string, unknown>)[row.name] !== owner[row.source]) strangers.push(row.name)
  }
  check('every re-exported value is the very object its module exports', strangers.length === 0, strangers.join(' '))
}

section('§2 the door wraps every tree it mounts in the theme provider; the bare mount does not')
{
  type Seen = { theme: string; setter: unknown }
  const probe = (seen: Seen[], tag: string) => {
    function Probe(): React.ReactNode {
      const [theme, setter] = door.useTheme()
      seen.push({ theme, setter })
      return React.createElement(door.Text, null, `${tag}:${theme}`)
    }
    return React.createElement(Probe)
  }
  const bareA: Seen[] = []
  const bareB: Seen[] = []
  const outA = screen()
  const outB = screen()
  const a = root.renderSync(probe(bareA, 'bare'), { stdout: outA, ...quiet() })
  const b = root.renderSync(probe(bareB, 'bare'), { stdout: outB, ...quiet() })
  door.flushPendingSyncWork()
  check('a bare mount reads the default context (the stored-default appearance, true-black, despite the pin)', bareA.at(-1)?.theme === 'true-black', JSON.stringify(bareA.at(-1)?.theme))
  check('two bare mounts share the default context\'s one setter', bareA.length > 0 && bareA.at(-1)?.setter === bareB.at(-1)?.setter)
  a.unmount()
  b.unmount()

  const wrapped: Seen[] = []
  const out = screen()
  const marks = frameMarks()
  const mounted = await door.render(probe(wrapped, 'door'), { stdout: out, ...quiet(), onFrame: marks.onFrame })
  await marks.painted()
  check('door.render mounts on the given stream with the given knobs', engineOn(out)?.options.stdout === out && engineOn(out)?.options.onFrame === marks.onFrame)
  check('door.render mounts inside a provider: the pinned appearance (dark) and the provider\'s own setter', wrapped.at(-1)?.theme === 'dark' && wrapped.at(-1)?.setter !== bareA.at(-1)?.setter, JSON.stringify(wrapped.at(-1)?.theme))
  check('door.render answers an instance whose frame shows the wrapped tree', mounted.lastFrame().includes('door:dark'), mounted.lastFrame())
  check('door.render answers the five instance doors', same(Object.keys(mounted).sort(), ['cleanup', 'lastFrame', 'rerender', 'unmount', 'waitUntilExit']))
  mounted.unmount()
  mounted.cleanup()

  const rooted: Seen[] = []
  const outR = screen()
  const marksR = frameMarks()
  const made = await door.createRoot({ stdout: outR, ...quiet(), onFrame: marksR.onFrame })
  check('door.createRoot answers render, unmount and waitUntilExit', same(Object.keys(made).sort(), ['render', 'unmount', 'waitUntilExit']))
  check('door.createRoot\'s unmount is the engine\'s own door', made.unmount === engineOn(outR)?.unmount)
  made.render(probe(rooted, 'root'))
  await marksR.painted()
  check('door.createRoot\'s render wraps the tree in the provider', rooted.at(-1)?.theme === 'dark' && rooted.at(-1)?.setter !== bareA.at(-1)?.setter)
  const exited = made.waitUntilExit()
  made.unmount()
  await exited
  check('door.createRoot\'s waitUntilExit settles once unmounted', true)
}

section('§3 timing: the bare render and createRoot wait one microtask before mounting; the door adds no tick of its own')
{
  const out = screen()
  const pending = root.default(line('later'), { stdout: out, ...quiet() })
  check('the bare render has not mounted synchronously', engineOn(out) === undefined)
  const later = await pending
  check('and has mounted once it resolves', engineOn(out) !== undefined)
  later.unmount()
  const outC = screen()
  const pendingRoot = root.createRoot({ stdout: outC, ...quiet() })
  check('createRoot has not registered an engine synchronously', engineOn(outC) === undefined)
  const madeC = await pendingRoot
  check('and has once it resolves', engineOn(outC) !== undefined)
  madeC.unmount()
  const unmountAfter = (made: Promise<{ unmount: () => void }>) => made.then(instance => instance.unmount())
  const bareTick = await settleTick(() => unmountAfter(root.default(line('t'), { stdout: screen(), ...quiet() })))
  const doorTick = await settleTick(() => unmountAfter(door.render(line('t'), { stdout: screen(), ...quiet() })))
  const layeredTick = await settleTick(() => unmountAfter((async () => root.default(line('t'), { stdout: screen(), ...quiet() }))()))
  check('door.render settles on the same microtask as the bare render it hands back', bareTick === doorTick && bareTick > 0, `bare ${bareTick} · door ${doorTick}`)
  check('the tick count sees an extra async layer (the measure has teeth)', layeredTick > bareTick, `bare ${bareTick} · layered ${layeredTick}`)
  let thrown = false
  let rejected: unknown = null
  try {
    await root.default(line('x'), null as unknown as undefined).catch(error => {
      rejected = error
    })
  } catch {
    thrown = true
  }
  check('a mount that fails (null options) rejects the bare render after its tick; it never throws synchronously', !thrown && rejected instanceof TypeError, String(rejected))
}

section('§4 emptyFrame: a zero-row screen of the given columns, the raw viewport, a visible cursor at home, fresh objects every call')
{
  const frame = await import('../../src/screen/renderer/frame.ts')
  const { CharPool, HyperlinkPool, StylePool } = await import('../../src/screen/renderer/cell-grid.ts')
  check('the frame module\'s only run-time export is emptyFrame', same(Object.keys(frame), ['emptyFrame']), Object.keys(frame).join(' '))
  const styles = new StylePool()
  const chars = new CharPool()
  const links = new HyperlinkPool()
  const made = frame.emptyFrame(24, 80, styles, chars, links)
  check('it answers exactly screen, viewport and cursor (no scrollHint, no scrollDrainPending key)', same(Object.keys(made).sort(), ['cursor', 'screen', 'viewport']) && !('scrollHint' in made) && !('scrollDrainPending' in made))
  check('the screen is columns wide and zero rows tall', made.screen.width === 80 && made.screen.height === 0, `${made.screen.width}×${made.screen.height}`)
  check('the screen carries the given pools', made.screen.charPool === chars && made.screen.hyperlinkPool === links && made.screen.emptyStyleId === styles.none)
  check('the viewport is the columns by the rows, rows given first', same(made.viewport, { width: 80, height: 24 }))
  check('the cursor is visible at the origin', same(made.cursor, { x: 0, y: 0, visible: true }))
  const again = frame.emptyFrame(24, 80, styles, chars, links)
  check('every call answers fresh objects', again !== made && again.screen !== made.screen && again.viewport !== made.viewport && again.cursor !== made.cursor)
  const fractional = frame.emptyFrame(2.7, 10.9, styles, chars, links)
  check('fractions: the screen floors its width, the viewport keeps the raw numbers', fractional.screen.width === 10 && fractional.screen.height === 0 && same(fractional.viewport, { width: 10.9, height: 2.7 }))
  const broken = frame.emptyFrame(Number.NaN, -3, styles, chars, links)
  check('a negative width clamps to 0 on the screen; the viewport keeps -3 and NaN', broken.screen.width === 0 && broken.viewport.width === -3 && Number.isNaN(broken.viewport.height))
  const nothing = frame.emptyFrame(0, 0, styles, chars, links)
  check('a 0×0 frame is a 0×0 screen', nothing.screen.width === 0 && nothing.screen.height === 0 && same(nothing.viewport, { width: 0, height: 0 }))
}

section('§5 the mount: options resolve as the process defaults under the given knobs; a bare stream is the stdout')
{
  const out = screen()
  const stdin = stdinStub()
  const onFrame = () => {}
  const mounted = root.renderSync(line('knobs'), { stdout: out, stdin, patchConsole: false, exitOnCtrlC: false, onFrame })
  const knobs = engineOn(out)?.options ?? {}
  check('given knobs reach the engine; the stderr gap is the process stderr', knobs.stdout === out && knobs.stdin === stdin && knobs.stderr === process.stderr && knobs.exitOnCtrlC === false && knobs.patchConsole === false && knobs.onFrame === onFrame)
  check('the engine holds exactly the six knobs', same(Object.keys(knobs).sort(), ['exitOnCtrlC', 'onFrame', 'patchConsole', 'stderr', 'stdin', 'stdout']), Object.keys(knobs).join(' '))
  mounted.unmount()

  const outGap = screen()
  const gaps = root.renderSync(line('gaps'), { stdout: outGap, stdin: null as unknown as undefined, stderr: undefined, onFrame: undefined, patchConsole: false, exitOnCtrlC: false })
  const gapKnobs = engineOn(outGap)?.options ?? {}
  check('null and undefined knobs fall back to the process streams; an absent onFrame leaves no key', gapKnobs.stdin === process.stdin && gapKnobs.stderr === process.stderr && !('onFrame' in gapKnobs))
  gaps.unmount()

  const outExtra = screen()
  const own = async (): Promise<void> => {}
  const extra = root.renderSync(line('extra'), { stdout: outExtra, ...quiet(), waitUntilExit: own } as unknown as Parameters<typeof root.renderSync>[1])
  check('as shipped (proposal I-R2): a key outside the six still reaches the engine', engineOn(outExtra)?.options.waitUntilExit === own)
  extra.unmount()

  const bare = screen()
  const nested = screen()
  const streamWithKnobs = Object.assign(screen(), { stdout: nested })
  const direct = root.renderSync(line('stream'), bare)
  const bareKnobs = { ...(engineOn(bare)?.options ?? {}) }
  direct.unmount()
  const shaped = root.renderSync(line('shaped'), streamWithKnobs)
  const shapedOn = engineOn(streamWithKnobs)
  shaped.unmount()
  check('a bare stream is the stdout beside the process stdin and stderr with both switches on and no onFrame', bareKnobs.stdout === bare && bareKnobs.stdin === process.stdin && bareKnobs.stderr === process.stderr && bareKnobs.exitOnCtrlC === true && bareKnobs.patchConsole === true && !('onFrame' in bareKnobs))
  check('anything with a write member is taken as the stream itself, its own keys ignored', shapedOn !== undefined && shapedOn.options.stdout === streamWithKnobs && engineOn(nested) === undefined)

  let refused: unknown = null
  try {
    root.renderSync(line('null'), null as unknown as undefined)
  } catch (error) {
    refused = error
  }
  check('null options throw a TypeError before anything mounts', refused instanceof TypeError)

  const report = join(scratch, 'process-defaults.json')
  const child = spawnSync(process.execPath, [import.meta.path, '--process-defaults', report], { encoding: 'utf8', env: process.env, timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'] })
  let facts: Record<string, unknown> = {}
  try {
    facts = JSON.parse(readFileSync(report, 'utf8'))
  } catch {}
  check('no options at all: the process stdout, stdin and stderr with both switches on and no onFrame', child.status === 0 && facts.registered === true && facts.stdout === true && facts.stdin === true && facts.stderr === true && facts.exitOnCtrlC === true && facts.patchConsole === true && same(facts.keys, ['exitOnCtrlC', 'patchConsole', 'stderr', 'stdin', 'stdout']), `rc ${child.status} ${JSON.stringify(facts)}`)
}

section('§6 the seat: renderSync reuses the engine seated on its stdout, keeps its first knobs, and hands out bound doors')
{
  const out = screen()
  const first = frameMarks()
  const second = frameMarks()
  const one = root.renderSync(line('one'), { stdout: out, ...quiet(), onFrame: first.onFrame })
  await first.painted()
  const engine = engineOn(out)
  const two = root.renderSync(line('two'), { stdout: out, ...quiet(), onFrame: second.onFrame, exitOnCtrlC: true })
  await first.painted()
  check('a second mount on the same stream drives the seated engine', engineOn(out) === engine && engine !== undefined)
  check('the seated engine keeps its first knobs (the second onFrame and switch are ignored)', engine?.options.onFrame === first.onFrame && engine?.options.exitOnCtrlC === false && second.count() === 0)
  check('the instance answers exactly the five doors', same(Object.keys(one).sort(), ['cleanup', 'lastFrame', 'rerender', 'unmount', 'waitUntilExit']))
  check('unmount is the engine\'s own door', one.unmount === engine?.unmount && two.unmount === engine?.unmount)
  const { rerender, lastFrame } = one
  rerender(line('three'))
  await first.painted()
  check('the doors are bound: detached rerender and lastFrame still drive the engine', lastFrame().includes('three') && lastFrame() === engine?.lastFrameText(), lastFrame())
  const exited = one.waitUntilExit()
  one.unmount()
  await exited
  check('waitUntilExit settles once unmounted, and the unmount clears the seat by itself', engineOn(out) === undefined && engine?.isUnmounted === true)
  check('cleanup answers nothing', one.cleanup() === undefined)

  const kept = screen()
  const held = root.renderSync(line('held'), { stdout: kept, ...quiet() })
  check('cleanup forgets the seat of a live engine', held.cleanup() === undefined && engineOn(kept) === undefined)
  held.unmount()
}

section('§7 createRoot always seats a fresh engine; a replaced engine keeps running; an old cleanup or unmount leaves the newer seat (I-R1, P-5)')
{
  const out = screen()
  const held = root.renderSync(line('held'), { stdout: out, ...quiet() })
  const before = engineOn(out)
  const made = await root.createRoot({ stdout: out, ...quiet() })
  const after = engineOn(out)
  check('createRoot seats a new engine over the seated one', after !== undefined && after !== before)
  check('as shipped (proposal I-R3): the replaced engine is left running', before?.isUnmounted === false)
  check('a fresh root has painted nothing', after?.lastFrameText() === '')
  check('the root answers exactly render, unmount and waitUntilExit, unmount being the engine\'s own', same(Object.keys(made).sort(), ['render', 'unmount', 'waitUntilExit']) && made.unmount === after?.unmount)
  held.cleanup()
  check('I-R1: the old instance\'s cleanup leaves the seat the new root holds; it forgets only its own engine', engineOn(out) === after)
  held.unmount()
  check('P-5: the replaced engine\'s unmount leaves the seat the new root holds; an engine forgets only its own seat', before?.isUnmounted === true && engineOn(out) === after)
  made.unmount()
  check('the new root\'s own unmount clears the seat it holds', after?.isUnmounted === true && engineOn(out) === undefined)
}

section('§8 the mount line: "ink render mounted <ms>ms after process start" at debug level only')
{
  const writes: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    writes.push(String(chunk))
    return (original as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stderr.write
  const quietMount = await root.default(line('quiet'), { stdout: screen(), ...quiet() })
  quietMount.unmount()
  process.stderr.write = original
  check('outside debug mode the mount writes no mount line', !writes.join('').includes('ink render mounted'))
  const report = join(scratch, 'debug-line.json')
  const child = spawnSync(process.execPath, [import.meta.path, '--log-stderr', '--debug-line', report], { encoding: 'utf8', env: process.env, timeout: 60_000 })
  const said = /\[DEBUG\] ink render mounted (\d+)ms after process start/.exec(child.stderr ?? '')
  let span: { before?: number; after?: number } = {}
  try {
    span = JSON.parse(readFileSync(report, 'utf8'))
  } catch {}
  const ms = Number(said?.[1] ?? Number.NaN)
  check('in debug mode the mount writes the line once, with the whole milliseconds since process start', child.status === 0 && said !== null && ms >= (span.before ?? Infinity) && ms <= (span.after ?? -Infinity) && (child.stderr.match(/ink render mounted/g) ?? []).length === 1, `rc ${child.status} · ${said?.[0] ?? 'no line'} · span ${JSON.stringify(span)}`)
}

section('§9 the type contract: frame vocabulary, mount types and door types are identical to the pinned shapes')
{
  const dir = join(scratch, 'types')
  mkdirSync(dir, { recursive: true })
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'))
  const head = `import type { ReactNode } from 'react'
import type { Diff, FlickerReason, FlickerRecord, Frame, FrameEvent, FramePhases, Patch, emptyFrame } from '${SRC}/screen/renderer/frame.ts'
import type { CharPool, HyperlinkPool, Screen, StylePool } from '${SRC}/screen/renderer/cell-grid.ts'
import type { ScrollHint } from '${SRC}/screen/renderer/compose-walk.ts'
import type { Cursor } from '${SRC}/screen/renderer/cursor.js'
import type { Instance, RenderOptions, Root, createRoot, renderSync } from '${SRC}/screen/renderer/root.ts'
import type render from '${SRC}/screen/renderer/root.ts'
import type * as door from '${SRC}/screen/themedRenderer.ts'
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Expect<T extends true> = T
type IsAny<T> = 0 extends 1 & T ? true : false
type Opaque = Screen | ScrollHint | NodeJS.WriteStream | NodeJS.ReadStream
type Shape<T> = IsAny<T> extends true ? T : T extends Opaque ? T : T extends (...args: never[]) => unknown ? T : T extends (infer E)[] ? Shape<E>[] : T extends readonly (infer E)[] ? readonly Shape<E>[] : T extends object ? { [K in keyof T]: Shape<T[K]> } : T
type Tagged<P> = { [K in keyof P]: { type: K } & P[K] }[keyof P]
type Payloads = {
  stdout: { content: string }
  styleStr: { str: string }
  hyperlink: { uri: string }
  cursorMove: { x: number; y: number }
  cursorTo: { col: number }
  clear: { count: number }
  clearTerminal: { reason: 'resize' | 'offscreen' | 'clear'; debug?: { triggerY: number; prevLine: string; nextLine: string } }
  cursorHide: {}
  cursorShow: {}
  carriageReturn: {}
}
type PinnedFrame = Readonly<{ screen: Screen; viewport: Readonly<{ width: number; height: number }>; cursor: Cursor; scrollHint?: ScrollHint | null; scrollDrainPending?: boolean }>
type PinnedRecord = { desiredHeight: number; availableHeight: number; reason: 'resize' | 'offscreen' | 'clear' }
type PinnedPhases = Record<'renderer' | 'diff' | 'optimize' | 'write' | 'yoga' | 'commit' | 'patches' | 'yogaVisited' | 'yogaMeasured' | 'yogaCacheHits' | 'yogaLive', number>
type PinnedEvent = { durationMs: number; phases?: PinnedPhases; flickers: PinnedRecord[] }
type PinnedKnobs = { stdout?: NodeJS.WriteStream; stdin?: NodeJS.ReadStream; stderr?: NodeJS.WriteStream; exitOnCtrlC?: boolean; patchConsole?: boolean; onFrame?: (event: FrameEvent) => void }
type PinnedInstance = { rerender: (node: ReactNode) => void; unmount: (error?: Error | number | null) => void; waitUntilExit: () => Promise<void>; cleanup: () => void; lastFrame: () => string }
type PinnedRoot = { render: (node: ReactNode) => void; unmount: (error?: Error | number | null) => void; waitUntilExit: () => Promise<void> }
`
  const pins = `${head}
export type Pins = [
  Expect<Equal<FlickerReason, 'resize' | 'offscreen' | 'clear'>>,
  Expect<Equal<Patch['type'], keyof Payloads>>,
  Expect<Equal<Shape<Patch>, Shape<Tagged<Payloads>>>>,
  Expect<Equal<Diff, Patch[]>>,
  Expect<Equal<Shape<Frame>, Shape<PinnedFrame>>>,
  Expect<Equal<Frame['cursor'], Cursor>>,
  Expect<Equal<Shape<FlickerRecord>, Shape<PinnedRecord>>>,
  Expect<Equal<Shape<FramePhases>, Shape<PinnedPhases>>>,
  Expect<Equal<Shape<FrameEvent>, Shape<PinnedEvent>>>,
  Expect<Equal<typeof emptyFrame, (rows: number, columns: number, stylePool: StylePool, charPool: CharPool, hyperlinkPool: HyperlinkPool) => Frame>>,
  Expect<Equal<Shape<RenderOptions>, Shape<PinnedKnobs>>>,
  Expect<Equal<Shape<Instance>, Shape<PinnedInstance>>>,
  Expect<Equal<Shape<Root>, Shape<PinnedRoot>>>,
  Expect<Equal<typeof renderSync, (node: ReactNode, options?: NodeJS.WriteStream | RenderOptions) => Instance>>,
  Expect<Equal<typeof render, (node: ReactNode, options?: NodeJS.WriteStream | RenderOptions) => Promise<Instance>>>,
  Expect<Equal<typeof createRoot, (options?: RenderOptions) => Promise<Root>>>,
  Expect<Equal<typeof door.render, typeof render>>,
  Expect<Equal<typeof door.createRoot, typeof createRoot>>,
  Expect<Equal<door.Instance, Instance>>,
  Expect<Equal<door.RenderOptions, RenderOptions>>,
  Expect<Equal<door.Root, Root>>,
  Expect<Equal<door.FlickerReason, FlickerReason>>,
]
`
  const planted = [
    `Expect<Equal<FlickerReason, 'resize' | 'offscreen'>>`,
    `Expect<Equal<Shape<Patch>, Shape<Tagged<Omit<Payloads, 'carriageReturn'>>>>>`,
    `Expect<Equal<Shape<Patch>, Shape<Tagged<Omit<Payloads, 'cursorTo'> & { cursorTo: { column: number } }>>>>`,
    `Expect<Equal<Shape<Frame>, Shape<{ screen: Screen; viewport: Readonly<{ width: number; height: number }>; cursor: Cursor; scrollHint?: ScrollHint | null; scrollDrainPending?: boolean }>>>`,
    `Expect<Equal<Shape<FrameEvent>, Shape<{ durationMs: number; phases: PinnedPhases; flickers: PinnedRecord[] }>>>`,
    `Expect<Equal<typeof emptyFrame, (rows: number, columns: number, stylePool: StylePool, charPool: CharPool) => Frame>>`,
    `Expect<Equal<Shape<Instance>, Shape<Omit<PinnedInstance, 'lastFrame'>>>>`,
    `Expect<Equal<Shape<RenderOptions>, Shape<Omit<PinnedKnobs, 'stdout'> & { stdout: NodeJS.WriteStream }>>>`,
  ]
  const teeth = `${head}\n${planted.map((p, i) => `export type Planted${i} = ${p}`).join('\n')}\n`
  const pinsFile = join(dir, 'pins.ts')
  const teethFile = join(dir, 'teeth.ts')
  writeFileSync(pinsFile, pins)
  writeFileSync(teethFile, teeth)
  const config = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile)
  const options = { ...ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT).options, noEmit: true }
  const program = ts.createProgram([pinsFile, teethFile], options)
  const told = (file: string) => {
    const unit = program.getSourceFile(file)
    return unit ? [...program.getSyntacticDiagnostics(unit), ...program.getSemanticDiagnostics(unit)] : []
  }
  const pinNotes = told(pinsFile)
  check('all 22 type pins hold (frame vocabulary, the mount types, the door\'s types)', pinNotes.length === 0, pinNotes.map(d => ts.flattenDiagnosticMessageText(d.messageText, ' ')).slice(0, 3).join(' | ') + ' (the first three type errors; fix the exported type named in them in src/screen/renderer/frame.ts or src/screen/renderer/root.ts)')
  const teethNotes = told(teethFile)
  const caughtLines = new Set(teethNotes.map(d => (d.file ? d.file.getLineAndCharacterOfPosition(d.start ?? 0).line : -1)))
  check(`each of the ${planted.length} planted faults is caught on its own line (a dropped reason, kind, field rename, readonly, optional phases, pool, door, required stdout)`, teethNotes.length === planted.length && caughtLines.size === planted.length && teethNotes.every(d => d.code === 2344), `${teethNotes.length} notes: ${teethNotes.map(d => d.code).join(',')} (a planted fault passed or failed on the wrong line, so a pin in this file is too loose; tighten the Equal pin in the pins text of section 9)`)
}

rmSync(scratch, { recursive: true, force: true })
rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-renderer-pins: ALL PASS' : `\nprove-renderer-pins: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
