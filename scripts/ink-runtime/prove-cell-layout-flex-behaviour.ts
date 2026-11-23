#!/usr/bin/env bun
import fc from 'fast-check'
import { resolveFlexibleLengths } from '../../src/screen/renderer/layout/cell-layout/flex.ts'

const WHERE = 'resolveFlexibleLengths in src/screen/renderer/layout/cell-layout/flex.ts'
type Item = { flexGrow: number; flexShrink: number; min?: number; max?: number }
type Entry = { node: Item; basis: number; targetMain: number }
const bounded = (item: Item, value: number): number => Math.max(item.min ?? Number.NEGATIVE_INFINITY, Math.min(item.max ?? Number.POSITIVE_INFINITY, value))
const line = (items: Array<Item & { basis: number }>): Entry[] => items.map(({ basis, ...node }) => ({ node, basis, targetMain: Number.NaN }))
function sizes(items: Array<Item & { basis: number }>, available: number | undefined): number[] {
  const entries = line(items)
  resolveFlexibleLengths(entries, available, items.reduce((sum, item) => sum + item.basis, 0), bounded)
  return entries.map(entry => entry.targetMain)
}
const near = (got: number[], want: number[]): boolean => got.length === want.length && got.every((value, n) => Math.abs(value - want[n]!) < 1e-9)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const expectSizes = (label: string, items: Array<Item & { basis: number }>, available: number | undefined, want: number[]): void => {
  const got = sizes(items, available)
  check(label, near(got, want), `got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}; see ${WHERE}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const grow = (basis: number, flexGrow: number, more: Partial<Item> = {}): Item & { basis: number } => ({ basis, flexGrow, flexShrink: 1, ...more })
const shrink = (basis: number, flexShrink: number, more: Partial<Item> = {}): Item & { basis: number } => ({ basis, flexGrow: 0, flexShrink, ...more })

section('§1 no room known: every item keeps its basis')
{
  expectSizes('with the available length unknown, each item is its basis', [grow(10, 1), grow(20, 3), shrink(5, 2)], undefined, [10, 20, 5])
  expectSizes('held to its own bounds', [grow(10, 1, { min: 15 }), grow(20, 1, { max: 12 })], undefined, [15, 12])
  expectSizes('and never below zero', [grow(4, 1, { max: -3 })], undefined, [0])
  const empty: Entry[] = []
  resolveFlexibleLengths(empty, 50, 0, bounded)
  check('an empty line is left empty', empty.length === 0)
}

section('§2 room to spare is shared by growth')
{
  expectSizes('two equal growers share the spare room equally', [grow(10, 1), grow(20, 1)], 50, [20, 30])
  expectSizes('growth factors share it in their proportion', [grow(10, 1), grow(10, 3)], 60, [20, 40])
  expectSizes('an item that does not grow keeps its basis', [grow(10, 0), grow(10, 1)], 60, [10, 50])
  expectSizes('no grower at all: every basis is kept and the room stays unused', [grow(10, 0), grow(15, 0)], 60, [10, 15])
  expectSizes('exactly enough room changes nothing', [grow(10, 1), grow(20, 2)], 30, [10, 20])
  expectSizes('growth factors that add up to less than one take only that share of the room', [grow(10, 0.5)], 110, [60])
  expectSizes('the same with two items', [grow(10, 0.25), grow(10, 0.25)], 100, [30, 30])
  expectSizes('the order of the line is kept: results stand where their items stand', [grow(0, 2), grow(0, 1), grow(0, 1)], 40, [20, 10, 10])
}

section('§3 too little room is taken back by shrinking, in proportion to factor times basis')
{
  expectSizes('equal factors: the larger item gives up more', [shrink(40, 1), shrink(60, 1)], 50, [20, 30])
  expectSizes('an item that does not shrink keeps its basis', [shrink(40, 0), shrink(60, 1)], 50, [40, 10])
  expectSizes('a larger factor gives up more', [shrink(50, 1), shrink(50, 3)], 60, [40, 20])
  expectSizes('nothing shrinks when no item may: the line overflows', [shrink(40, 0), shrink(60, 0)], 50, [40, 60])
  expectSizes('shrink factors that add up to less than one give back only that share', [shrink(100, 0.5)], 60, [80])
  expectSizes('growth plays no part when room is short', [{ basis: 40, flexGrow: 5, flexShrink: 1 }, { basis: 60, flexGrow: 0, flexShrink: 1 }], 50, [20, 30])
}

section('§4 an item that hits its own bound stops there and the others take the rest')
{
  expectSizes('a grower capped by its maximum leaves the rest of the room to the other', [grow(10, 1, { max: 20 }), grow(10, 1)], 100, [20, 80])
  expectSizes('a grower lifted by its minimum takes that room first', [grow(10, 1, { min: 70 }), grow(10, 1)], 100, [70, 30])
  expectSizes('both capped: the room they cannot take stays unused', [grow(10, 1, { max: 20 }), grow(10, 1, { max: 30 })], 100, [20, 30])
  expectSizes('a shrinker held by its minimum makes the other give up more, down to zero and no further', [shrink(50, 1, { min: 45 }), shrink(50, 1)], 40, [45, 0])
  expectSizes('three items, one capped: the two free ones split what is left by their factors', [grow(0, 1, { max: 10 }), grow(0, 1), grow(0, 2)], 100, [10, 30, 60])
  expectSizes('an item with nothing to flex is still held to its bounds', [grow(10, 0, { min: 25 }), grow(10, 1)], 60, [25, 35])
}

section('§5 the laws, on generated lines')
{
  const growers = fc.array(fc.record({ basis: fc.integer({ min: 0, max: 50 }), flexGrow: fc.integer({ min: 1, max: 5 }) }), { minLength: 1, maxLength: 6 })
  const growLaw = fc.check(
    fc.property(growers, fc.integer({ min: 0, max: 200 }), (items, spare) => {
      const basisSum = items.reduce((sum, item) => sum + item.basis, 0)
      const got = sizes(items.map(item => ({ ...item, flexShrink: 1 })), basisSum + spare)
      const factorSum = items.reduce((sum, item) => sum + item.flexGrow, 0)
      return Math.abs(got.reduce((sum, value) => sum + value, 0) - (basisSum + spare)) < 1e-6 && got.every((value, n) => Math.abs(value - items[n]!.basis - (spare * items[n]!.flexGrow) / factorSum) < 1e-6)
    }),
    { numRuns: 500 },
  )
  check('unbounded growers with factors of one or more fill the available length exactly, each taking its share of the spare room', !growLaw.failed, `counterexample ${JSON.stringify(growLaw.counterexample)}; see ${WHERE}`)
  const shrinkers = fc.array(fc.record({ basis: fc.integer({ min: 1, max: 80 }), flexShrink: fc.integer({ min: 1, max: 4 }) }), { minLength: 1, maxLength: 6 })
  const shrinkLaw = fc.check(
    fc.property(shrinkers, fc.integer({ min: 0, max: 100 }), (items, percent) => {
      const basisSum = items.reduce((sum, item) => sum + item.basis, 0)
      const available = (basisSum * percent) / 100
      const got = sizes(items.map(item => ({ ...item, flexGrow: 0, min: 0 })), available)
      return got.every((value, n) => value >= 0 && value <= items[n]!.basis + 1e-9) && Math.abs(got.reduce((sum, value) => sum + value, 0) - available) < 1e-6
    }),
    { numRuns: 500 },
  )
  check('shrinkers held at zero from below never grow, never go below zero, and together take exactly the available length', !shrinkLaw.failed, `counterexample ${JSON.stringify(shrinkLaw.counterexample)}; see ${WHERE}`)
  const anyLine = fc.array(fc.record({ basis: fc.integer({ min: 0, max: 60 }), flexGrow: fc.constantFrom(0, 0.5, 1, 2), flexShrink: fc.constantFrom(0, 0.5, 1, 2), min: fc.option(fc.integer({ min: 0, max: 40 }), { nil: undefined }), max: fc.option(fc.integer({ min: 40, max: 120 }), { nil: undefined }) }), { maxLength: 6 })
  const boundLaw = fc.check(
    fc.property(anyLine, fc.option(fc.integer({ min: 0, max: 300 }), { nil: undefined }), (items, available) => {
      const got = sizes(items, available)
      return got.every((value, n) => Number.isFinite(value) && value >= 0 && value >= (items[n]!.min ?? 0) - 1e-9 && value <= (items[n]!.max ?? Number.POSITIVE_INFINITY) + 1e-9)
    }),
    { numRuns: 1000 },
  )
  check('whatever the line, every result is a finite length, not below zero and inside its item\'s own bounds', !boundLaw.failed, `counterexample ${JSON.stringify(boundLaw.counterexample)}; see ${WHERE}`)
}

if (failures > 0) {
  console.error(`\nprove-cell-layout-flex-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-cell-layout-flex-behaviour: all green')
