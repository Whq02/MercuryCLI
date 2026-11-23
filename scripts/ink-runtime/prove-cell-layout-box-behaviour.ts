#!/usr/bin/env bun
import fc from 'fast-check'
import { clampH, clampW, crossGapOf, hasMeasureFuncInSubtree, isReverse, mainAxis, mainGapOf, marginH, marginV, padBorderH, padBorderV, resolvedAlign } from '../../src/screen/renderer/layout/cell-layout/box.ts'

const WHERE = 'src/screen/renderer/layout/cell-layout/box.ts'
type Boxed = Parameters<typeof mainAxis>[0]
type Dim = Boxed['styleMinWidth']
const AUTO: Dim = { unit: 'auto' }
const point = (value: number): Dim => ({ unit: 'point', value })
const percent = (value: number): Dim => ({ unit: 'percent', value })
const box = (given: Partial<Boxed> = {}): Boxed => ({
  children: [],
  styleMinWidth: AUTO,
  styleMinHeight: AUTO,
  styleMaxWidth: AUTO,
  styleMaxHeight: AUTO,
  flexDirection: 'column',
  alignItems: 'stretch',
  alignSelf: 'auto',
  margin: {},
  padding: {},
  border: {},
  gap: {},
  measureFunc: null,
  ...given,
})

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

section('§1 the main axis and its direction')
{
  const axes = (['row', 'row-reverse', 'column', 'column-reverse'] as const).map(flexDirection => `${flexDirection}:${mainAxis(box({ flexDirection }))}:${isReverse(box({ flexDirection }))}`)
  check('row and row-reverse run along the row, column and column-reverse along the column; the two reverse directions say so', axes.join(' ') === 'row:row:false row-reverse:row:true column:column:false column-reverse:column:true', `${axes.join(' ')}; see mainAxis and isReverse in ${WHERE}`)
}

section('§2 clamping a width and a height')
for (const [name, clamp, min, max] of [['clampW', clampW, 'styleMinWidth', 'styleMaxWidth'], ['clampH', clampH, 'styleMinHeight', 'styleMaxHeight']] as const) {
  const where = `${name} in ${WHERE}`
  check(`${name}: with no bounds the value passes, but never below zero`, clamp(box(), 7, 100) === 7 && clamp(box(), 0, 100) === 0 && clamp(box(), -3, 100) === 0 && clamp(box(), 2.5, undefined) === 2.5, where)
  check(`${name}: a maximum in cells caps the value`, clamp(box({ [max]: point(10) }), 25, 100) === 10 && clamp(box({ [max]: point(10) }), 4, 100) === 4, where)
  check(`${name}: a minimum in cells lifts the value`, clamp(box({ [min]: point(10) }), 4, 100) === 10 && clamp(box({ [min]: point(10) }), 25, 100) === 25, where)
  check(`${name}: when the minimum is above the maximum, the minimum wins`, clamp(box({ [min]: point(30), [max]: point(10) }), 5, 100) === 30 && clamp(box({ [min]: point(30), [max]: point(10) }), 50, 100) === 30, `${clamp(box({ [min]: point(30), [max]: point(10) }), 5, 100)}; ${where}`)
  check(`${name}: bounds in percent are taken of the owner's size`, clamp(box({ [max]: percent(50) }), 80, 100) === 50 && clamp(box({ [min]: percent(25) }), 3, 80) === 20, where)
  check(`${name}: bounds in percent are ignored when the owner's size is not known`, clamp(box({ [max]: percent(50), [min]: percent(25) }), 80, undefined) === 80 && clamp(box({ [min]: percent(25) }), 3, Number.NaN) === 3, where)
  check(`${name}: a negative maximum still answers zero, not less`, clamp(box({ [max]: point(-5) }), 8, 100) === 0, String(clamp(box({ [max]: point(-5) }), 8, 100)))
  const bounds = fc.record({ low: fc.integer({ min: 0, max: 200 }), span: fc.integer({ min: 0, max: 200 }), value: fc.integer({ min: -300, max: 600 }) })
  const law = fc.check(
    fc.property(bounds, ({ low, span, value }) => {
      const self = box({ [min]: point(low), [max]: point(low + span) })
      const once = clamp(self, value, undefined)
      return once >= low && once <= low + span && clamp(self, once, undefined) === once && (value < low || value > low + span || once === value)
    }),
    { numRuns: 500 },
  )
  check(`${name}: the law — between a minimum and a maximum that is not below it, the answer lies within them, a value already within passes unchanged, and clamping twice changes nothing`, !law.failed, `counterexample ${JSON.stringify(law.counterexample)}; ${where}`)
  const rising = fc.check(fc.property(fc.integer({ min: -100, max: 400 }), fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 300 }), (value, step, cap) => clamp(box({ [max]: point(cap), [min]: point(20) }), value, undefined) <= clamp(box({ [max]: point(cap), [min]: point(20) }), value + step, undefined)), { numRuns: 500 })
  check(`${name}: the law — a larger value never gets a smaller answer`, !rising.failed, `counterexample ${JSON.stringify(rising.counterexample)}; ${where}`)
}

section('§3 margins, padding and borders summed along an axis')
{
  check('with nothing set every sum is zero', marginH(box()) === 0 && marginV(box()) === 0 && padBorderH(box()) === 0 && padBorderV(box()) === 0)
  check('marginH is left plus right, marginV top plus bottom', marginH(box({ margin: { left: 1, right: 2, top: 4, bottom: 8 } })) === 3 && marginV(box({ margin: { left: 1, right: 2, top: 4, bottom: 8 } })) === 12, `marginH and marginV in ${WHERE}`)
  check('start stands for left and end for right when those are not set', marginH(box({ margin: { start: 3, end: 5 } })) === 8 && marginH(box({ margin: { start: 3, end: 5, left: 1 } })) === 6 && marginH(box({ margin: { start: 3, end: 5, right: 1 } })) === 4, `${marginH(box({ margin: { start: 3, end: 5 } }))}`)
  check('start and end say nothing about top and bottom', marginV(box({ margin: { start: 3, end: 5 } })) === 0)
  check('horizontal fills both sides of the row, vertical both of the column', marginH(box({ margin: { horizontal: 2 } })) === 4 && marginV(box({ margin: { horizontal: 2 } })) === 0 && marginV(box({ margin: { vertical: 3 } })) === 6 && marginH(box({ margin: { vertical: 3 } })) === 0)
  check('all fills every side that nothing nearer names', marginH(box({ margin: { all: 1 } })) === 2 && marginV(box({ margin: { all: 1 } })) === 2 && marginH(box({ margin: { all: 1, horizontal: 4 } })) === 8 && marginH(box({ margin: { all: 1, left: 6 } })) === 7 && marginH(box({ margin: { all: 1, horizontal: 4, start: 9 } })) === 13, `${marginH(box({ margin: { all: 1, horizontal: 4, start: 9 } }))}; the nearest name wins: the side, then start or end, then the axis, then all`)
  check('a side set to zero is a set side', marginH(box({ margin: { all: 5, left: 0 } })) === 5 && marginV(box({ margin: { vertical: 5, top: 0 } })) === 5)
  check('padBorderH and padBorderV add padding and border on their axis', padBorderH(box({ padding: { left: 1, right: 2 }, border: { all: 1 } })) === 5 && padBorderV(box({ padding: { vertical: 2 }, border: { top: 1 } })) === 5 && padBorderH(box({ padding: { vertical: 2 }, border: { top: 1 } })) === 0, `padBorderH and padBorderV in ${WHERE}`)
  check('the margin is not part of them', padBorderH(box({ margin: { all: 9 }, padding: { all: 1 } })) === 2 && padBorderV(box({ margin: { all: 9 }, border: { all: 1 } })) === 2)
}

section('§4 alignment, measured content and gaps')
{
  check('a child that says auto takes its parent\'s alignment of items', resolvedAlign(box({ alignSelf: 'auto' }), box({ alignItems: 'center' })) === 'center' && resolvedAlign(box(), box()) === 'stretch', `resolvedAlign in ${WHERE}`)
  check('a child that says anything else keeps its own', resolvedAlign(box({ alignSelf: 'flex-end' }), box({ alignItems: 'center' })) === 'flex-end' && resolvedAlign(box({ alignSelf: 'stretch' }), box({ alignItems: 'flex-start' })) === 'stretch')
  const measure = (() => ({ width: 1, height: 1 })) as NonNullable<Boxed['measureFunc']>
  check('hasMeasureFuncInSubtree is true for a box that measures itself, or holds one at any depth, and false otherwise', hasMeasureFuncInSubtree(box({ measureFunc: measure })) && hasMeasureFuncInSubtree(box({ children: [box(), box({ children: [box({ measureFunc: measure })] })] })) && !hasMeasureFuncInSubtree(box()) && !hasMeasureFuncInSubtree(box({ children: [box(), box({ children: [box()] })] })), `hasMeasureFuncInSubtree in ${WHERE}`)
  const gaps = box({ gap: { column: 2, row: 5 } })
  check('along a row the main gap is the column gap and the cross gap the row gap; along a column the other way round', mainGapOf(gaps, 'row') === 2 && crossGapOf(gaps, 'row') === 5 && mainGapOf(gaps, 'column') === 5 && crossGapOf(gaps, 'column') === 2, `mainGapOf and crossGapOf in ${WHERE}`)
  const one = box({ gap: { all: 3 } })
  check('a gap set for all stands for both', mainGapOf(one, 'row') === 3 && crossGapOf(one, 'row') === 3 && mainGapOf(one, 'column') === 3 && crossGapOf(one, 'column') === 3)
  const mixed = box({ gap: { all: 3, row: 7 } })
  check('a gap named for its axis wins over all, zero included', mainGapOf(mixed, 'column') === 7 && crossGapOf(mixed, 'column') === 3 && mainGapOf(box({ gap: { all: 3, column: 0 } }), 'row') === 0)
  check('no gap set is zero', mainGapOf(box(), 'row') === 0 && crossGapOf(box(), 'column') === 0)
}

if (failures > 0) {
  console.error(`\nprove-cell-layout-box-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-cell-layout-box-behaviour: all green')
