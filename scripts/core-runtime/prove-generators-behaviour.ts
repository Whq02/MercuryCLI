#!/usr/bin/env bun
import fc from 'fast-check'
import { all, returnValue } from '../../src/platform/async/generators.ts'

const WHERE = 'src/platform/async/generators.ts'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve))
async function collect<A>(source: AsyncGenerator<A, void, unknown>): Promise<A[]> {
  const out: A[] = []
  for await (const value of source) out.push(value)
  return out
}

section('§1 returnValue: the value a generator ends with')
{
  let stepped = 0
  async function* counting(): AsyncGenerator<number, string, unknown> {
    for (let n = 0; n < 3; n++) {
      stepped++
      yield n
    }
    return 'done'
  }
  check('it runs the generator to its end and answers what it returned', (await returnValue(counting())) === 'done' && stepped === 3, `stepped ${stepped}; see returnValue in ${WHERE}`)
  async function* atOnce(): AsyncGenerator<never, number, unknown> {
    return 42
  }
  check('a generator that yields nothing answers its return value at once', (await returnValue(atOnce())) === 42)
  async function* failing(): AsyncGenerator<number, string, unknown> {
    yield 1
    throw new Error('generator failed')
  }
  let thrown = ''
  try {
    await returnValue(failing())
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error)
  }
  check('an error thrown inside reaches the caller', thrown === 'generator failed', thrown)
}

section('§2 all: several generators as one stream')
{
  async function* of<A>(...values: A[]): AsyncGenerator<A, void, unknown> {
    for (const value of values) yield value
  }
  check('no generator gives an empty stream', (await collect(all<number>([]))).length === 0)
  check('one generator comes through unchanged, in its own order', (await collect(all([of(1, 2, 3)]))).join(',') === '1,2,3')
  const merged = await collect(all([of('a1', 'a2', 'a3'), of('b1'), of('c1', 'c2')]))
  check('every value of every generator arrives exactly once', merged.length === 6 && [...merged].sort().join(',') === 'a1,a2,a3,b1,c1,c2', merged.join(','))
  check('the values of one generator keep their own order among the others', merged.filter(value => value.startsWith('a')).join(',') === 'a1,a2,a3' && merged.filter(value => value.startsWith('c')).join(',') === 'c1,c2', merged.join(','))
  check('generators that are equally ready take turns in the order given', merged.join(',') === 'a1,b1,c1,a2,c2,a3', `${merged.join(',')}; see all in ${WHERE}`)
  check('a value that is undefined is not passed on; the rest still is', (await collect(all([of<number | undefined>(1, undefined, 2)]))).join(',') === '1,2')
}
{
  const events: string[] = []
  let running = 0
  let peak = 0
  async function* job(name: string, steps: number): AsyncGenerator<string, void, unknown> {
    running++
    peak = Math.max(peak, running)
    events.push(`start:${name}`)
    for (let n = 1; n <= steps; n++) {
      await tick()
      yield `${name}${n}`
    }
    events.push(`end:${name}`)
    running--
  }
  const out = await collect(all([job('a', 2), job('b', 2), job('c', 1)], 2))
  check('with a cap of two, never more than two generators are running', peak === 2, `peak ${peak}; see all in ${WHERE}`)
  check('the third starts only when one of the first two has ended', events.indexOf('start:c') > Math.min(events.indexOf('end:a'), events.indexOf('end:b')), events.join(' '))
  check('the generators are started in the order given', events.filter(event => event.startsWith('start:')).join(' ') === 'start:a start:b start:c', events.join(' '))
  check('and every value still arrives', [...out].sort().join(',') === 'a1,a2,b1,b2,c1', out.join(','))
  running = 0
  peak = 0
  await collect(all([job('a', 1), job('b', 1), job('c', 1), job('d', 1)], 1))
  check('a cap of one runs them one after another', peak === 1, `peak ${peak}`)
  running = 0
  peak = 0
  await collect(all([job('a', 1), job('b', 1), job('c', 1), job('d', 1)]))
  check('with no cap given they all run together', peak === 4, `peak ${peak}`)
}
{
  async function* good(): AsyncGenerator<number, void, unknown> {
    yield 1
    await tick()
    yield 2
  }
  async function* bad(): AsyncGenerator<number, void, unknown> {
    await tick()
    throw new Error('one failed')
  }
  let thrown = ''
  const seen: number[] = []
  try {
    for await (const value of all([good(), bad()])) seen.push(value)
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error)
  }
  check('an error in one generator ends the stream with that error', thrown === 'one failed', `${thrown} after ${seen.join(',')}; see all in ${WHERE}`)
}

section('§3 the law, on generated lists')
{
  const lists = fc.array(fc.array(fc.integer({ min: 0, max: 99 }), { maxLength: 6 }), { maxLength: 6 })
  const law = await fc.check(
    fc.asyncProperty(lists, fc.integer({ min: 1, max: 7 }), async (given, cap) => {
      async function* of(values: number[], tag: number): AsyncGenerator<string, void, unknown> {
        for (const value of values) yield `${tag}:${value}`
      }
      const out = await collect(all(given.map((values, tag) => of(values, tag)), cap))
      return out.length === given.reduce((sum, values) => sum + values.length, 0) && given.every((values, tag) => out.filter(value => value.startsWith(`${tag}:`)).join(',') === values.map(value => `${tag}:${value}`).join(','))
    }),
    { numRuns: 300 },
  )
  check('whatever the lists and the cap, the stream holds every value once and each list in its own order', !law.failed, `counterexample ${JSON.stringify(law.counterexample)}; see all in ${WHERE}`)
}

if (failures > 0) {
  console.error(`\nprove-generators-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-generators-behaviour: all green')
