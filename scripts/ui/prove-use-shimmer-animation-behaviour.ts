#!/usr/bin/env bun
import { mountOffscreen, pinScratchHome, releaseScratchHome, type Mounted } from '../lib/settingsPopupHarness.ts'
import { untilAsync } from '../lib/untilAsync.ts'

const home = pinScratchHome('use-shimmer-animation')
const React = await import('react')
const { Box, Text } = await import('../../src/screen/themedRenderer.ts')
const { ClockContext } = await import('../../src/screen/renderer/elements/ClockContext.tsx')
const { useShimmerAnimation } = await import('../../src/screen/spinner/useShimmerAnimation.ts')

const WHERE = 'useShimmerAnimation in src/screen/spinner/useShimmerAnimation.ts'
const STALLED = -10_000
type Mode = Parameters<typeof useShimmerAnimation>[0]
type Shown = { mode: Mode; message: string; stalled: boolean }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

type Stage = {
  at: (ms: number, expected: number) => Promise<number>
  show: (next: Shown, expected: number) => Promise<number>
  distinct: () => number[]
  refs: () => number
  keptAlive: () => number
  listening: () => number
  close: () => void
}
async function stage(first: Shown, startMs: number, withClock = true): Promise<Stage> {
  let time = startMs
  const listeners = new Map<() => void, boolean>()
  const clock = {
    now: (): number => time,
    subscribe: (onChange: () => void, keepAlive: boolean): (() => void) => {
      listeners.set(onChange, keepAlive)
      return () => {
        listeners.delete(onChange)
      }
    },
    setInterval: (): void => undefined,
  }
  const seen: number[] = []
  const refs = new Set<unknown>()
  function Probe(props: Shown): React.ReactNode {
    const [ref, index] = useShimmerAnimation(props.mode, props.message, props.stalled)
    refs.add(ref)
    seen.push(index)
    return React.createElement(Box, { ref }, React.createElement(Text, null, `index ${index}`))
  }
  const element = (shown: Shown): React.ReactNode => (withClock ? React.createElement(ClockContext.Provider, { value: clock as never }, React.createElement(Probe, shown)) : React.createElement(Probe, shown))
  const scene: Mounted = await mountOffscreen(element(first), 40, 6)
  const last = (): number => seen[seen.length - 1] ?? Number.NaN
  const reach = async (expected: number): Promise<number> => {
    await untilAsync(() => last() === expected, 3_000, 5)
    return last()
  }
  await untilAsync(() => seen.length > 0, 3_000, 5)
  return {
    at: (ms, expected) => {
      time = ms
      for (const tell of [...listeners.keys()]) tell()
      return reach(expected)
    },
    show: (next, expected) => {
      scene.resize(element(next), 40, 6)
      return reach(expected)
    },
    distinct: () => seen.filter((index, at) => at === 0 || index !== seen[at - 1]),
    refs: () => refs.size,
    keptAlive: () => [...listeners.values()].filter(Boolean).length,
    listening: () => listeners.size,
    close: () => scene.unmount(),
  }
}
const range = (from: number, to: number): number[] => Array.from({ length: Math.abs(to - from) + 1 }, (_, n) => (to >= from ? from + n : from - n))
const same = (got: number[], want: number[]): boolean => got.length === want.length && got.every((index, at) => index === want[at])

try {
  section('§1 while a request is on its way the index walks up, one step every 80 ms')
  {
    const hello = await stage({ mode: 'requesting', message: 'hello', stalled: false }, 0)
    check('at the start it stands ten places before the message', (await hello.at(0, -10)) === -10, `${hello.distinct().join(',')}; see ${WHERE}`)
    for (let step = 0; step <= 26; step++) {
      await hello.at(step * 80, (step % 25) - 10)
      await hello.at(step * 80 + 79, (step % 25) - 10)
    }
    const want = [...range(-10, 14), -10, -9]
    check('a message five cells wide: from -10 up to 14, a new place at each full 80 ms and none between, then -10 again', same(hello.distinct(), want), `walked ${hello.distinct().join(',')}; expected ${want.join(',')}; see ${WHERE}`)
    check('while it runs it keeps the clock going with one listener', hello.listening() === 1 && hello.keptAlive() === 1, `${hello.listening()} listening, ${hello.keptAlive()} keeping the clock alive`)
    check('the ref it hands out is one function from render to render', hello.refs() === 1, `${hello.refs()} different refs over ${hello.distinct().length} renders`)
    check('a jump of many rounds lands on the place of that moment', (await hello.at(1_000_000, -10)) === -10 && (await hello.at(1_000_080 + 80 * 7, -2)) === -2, hello.distinct().slice(-3).join(','))
    hello.close()
    check('taken off the screen it lets go of the clock', hello.listening() === 0, `${hello.listening()} still listening`)
  }

  section('§2 in every other mode the index walks down, one step every 160 ms')
  for (const mode of ['responding', 'thinking', 'tool-use', 'tool-input'] as const) {
    const hello = await stage({ mode, message: 'hello', stalled: false }, 0)
    for (let step = 0; step <= 26; step++) {
      await hello.at(step * 160, 15 - (step % 25))
      await hello.at(step * 160 + 159, 15 - (step % 25))
    }
    const want = [...range(15, -9), 15, 14]
    check(`${mode}: from 15 down to -9, a new place at each full 160 ms and none between, then 15 again`, same(hello.distinct(), want), `walked ${hello.distinct().join(',')}; expected ${want.join(',')}; see ${WHERE}`)
    hello.close()
  }

  section('§3 the round is as long as the message is wide, in terminal cells, plus twenty places')
  {
    const widths: Array<[string, number, string]> = [['', 0, 'an empty message'], ['hello world', 11, 'eleven letters'], ['\u65e5\u672c', 4, 'two wide characters'], ['cafe\u0301', 4, 'four letters, one under a combining accent'], ['\u{1F600} ok', 5, 'an emoji, a space and two letters']]
    for (const [message, width, name] of widths) {
      const up = await stage({ mode: 'requesting', message, stalled: false }, 0)
      for (let step = 0; step <= width + 21; step++) await up.at(step * 80, (step % (width + 20)) - 10)
      const wantUp = [...range(-10, width + 9), -10, -9]
      const down = await stage({ mode: 'responding', message, stalled: false }, 0)
      for (let step = 0; step <= width + 21; step++) await down.at(step * 160, width + 10 - (step % (width + 20)))
      const wantDown = [...range(width + 10, -9), width + 10, width + 9]
      check(`${name}, ${width} cells: up from -10 to ${width + 9}, down from ${width + 10} to -9`, same(up.distinct(), wantUp) && same(down.distinct(), wantDown), `up ${up.distinct().join(',')}; down ${down.distinct().join(',')}; see ${WHERE}`)
      up.close()
      down.close()
    }
  }

  section('§4 the place depends on the clock alone')
  {
    const late = await stage({ mode: 'requesting', message: 'hello', stalled: false }, 12_345)
    check('put on the screen at 12,345 ms while requesting, it starts at -6', same(late.distinct(), [-6]), `${late.distinct().join(',')}; see ${WHERE}`)
    late.close()
    const lateDown = await stage({ mode: 'thinking', message: 'hello', stalled: false }, 12_345)
    check('and in another mode at 13', same(lateDown.distinct(), [13]), `${lateDown.distinct().join(',')}; see ${WHERE}`)
    lateDown.close()
    const still = await stage({ mode: 'requesting', message: 'hello', stalled: false }, 0, false)
    const stillDown = await stage({ mode: 'responding', message: 'hello', stalled: false }, 0, false)
    check('with no clock on the stage it stands at the first place: -10 while requesting, 15 otherwise', same(still.distinct(), [-10]) && same(stillDown.distinct(), [15]), `${still.distinct().join(',')} and ${stillDown.distinct().join(',')}`)
    still.close()
    stillDown.close()
  }

  section('§5 a stalled shimmer')
  {
    const stalled = await stage({ mode: 'requesting', message: 'hello', stalled: true }, 0)
    check('put on the screen stalled, the index is -10000', same(stalled.distinct(), [STALLED]), `${stalled.distinct().join(',')}; see ${WHERE}`)
    check('and it does not listen to the clock at all', stalled.listening() === 0, `${stalled.listening()} listening; a stalled shimmer must not keep the clock going`)
    await stalled.at(4_000, STALLED)
    await stalled.at(8_000, STALLED)
    const woke = await stalled.show({ mode: 'requesting', message: 'hello', stalled: false }, -10)
    check('time passing changes nothing; when the stall ends it listens again and keeps the clock going', stalled.distinct()[0] === STALLED && woke !== STALLED && stalled.listening() === 1 && stalled.keptAlive() === 1, `${stalled.distinct().join(',')}; ${stalled.listening()} listening`)
    check('and at the next step it stands on the place of that moment', (await stalled.at(8_240, -7)) === -7, `${stalled.distinct().join(',')}; see ${WHERE}`)
    const again = await stalled.show({ mode: 'requesting', message: 'hello', stalled: true }, STALLED)
    check('a running shimmer that stalls shows -10000 at once and stops listening', again === STALLED && stalled.listening() === 0, `${again}; ${stalled.listening()} listening`)
    for (const mode of ['responding', 'thinking', 'tool-use', 'tool-input'] as const) {
      const other = await stage({ mode, message: 'a longer message', stalled: true }, 3_333)
      check(`${mode}: stalled is -10000 whatever the mode, the message and the time`, same(other.distinct(), [STALLED]) && other.listening() === 0, other.distinct().join(','))
      other.close()
    }
    stalled.close()
  }

  section('§6 a new mode or a new message')
  {
    const moving = await stage({ mode: 'requesting', message: 'hello', stalled: false }, 0)
    await moving.at(400, -5)
    await moving.show({ mode: 'responding', message: 'hello', stalled: false }, -5)
    check('after the mode changes, the next step is the new mode\'s place for that moment, at the new pace', (await moving.at(480, 12)) === 12 && (await moving.at(639, 12)) === 12 && (await moving.at(640, 11)) === 11, `${moving.distinct().join(',')}; see ${WHERE}`)
    await moving.show({ mode: 'responding', message: 'hello world', stalled: false }, 11)
    check('after the message changes, the next step follows the new width', (await moving.at(800, 16)) === 16 && (await moving.at(31 * 160, 21)) === 21, `${moving.distinct().join(',')}; see ${WHERE}`)
    check('through both changes it kept one listener on the clock and one ref', moving.listening() === 1 && moving.refs() === 1, `${moving.listening()} listening, ${moving.refs()} refs`)
    moving.close()
  }
} finally {
  await releaseScratchHome(home)
}

if (failures > 0) {
  console.error(`\nprove-use-shimmer-animation-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-use-shimmer-animation-behaviour: all green')
process.exit(0)
