#!/usr/bin/env bun
import fc from 'fast-check'
import { memoizeWithLRU } from '../../src/platform/async/memoize.ts'

const WHERE = 'memoizeWithLRU in src/platform/async/memoize.ts'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)

function counted<Result extends NonNullable<unknown>>(make: (word: string, n: number) => Result, max?: number) {
  const calls: string[] = []
  const memoized = memoizeWithLRU(
    (word: string, n: number): Result => {
      calls.push(`${word}:${n}`)
      return make(word, n)
    },
    (word: string) => word,
    ...(max === undefined ? [] : [max]),
  )
  return { calls, memoized }
}

section('§1 one call per key')
{
  const { calls, memoized } = counted((word, n) => ({ word, n }))
  const first = memoized('a', 1)
  const again = memoized('a', 1)
  check('the second call with the same key answers the very value of the first', again === first, `${WHERE} must hand back the stored value itself, not a copy`)
  check('the wrapped function ran once', calls.length === 1, `it ran ${calls.length} times; ${WHERE} must not call the wrapped function again for a key it holds`)
  const other = memoized('a', 2)
  check('two argument lists that make the same key share the first answer', other === first && calls.length === 1, `the key function alone decides sameness; got n=${other.n} after ${calls.length} calls`)
  const b = memoized('b', 3)
  check('a new key calls the wrapped function with its own arguments', b.word === 'b' && b.n === 3 && calls.join(',') === 'a:1,b:3', calls.join(','))
}

section('§2 answers that are falsy but not undefined are kept')
{
  for (const [name, value] of [['0', 0], ['the empty string', ''], ['false', false], ['null-prototype object', Object.create(null)]] as const) {
    const { calls, memoized } = counted(() => value as NonNullable<unknown>)
    const first = memoized('k', 0)
    const second = memoized('k', 0)
    check(`${name} is stored and served`, first === value && second === value && calls.length === 1, `${calls.length} calls; ${WHERE} must treat only an absent entry as a miss`)
  }
}

section('§3 the cache handle')
{
  const { calls, memoized } = counted((word, n) => `${word}${n}`)
  check('a new memoized function holds nothing', memoized.cache.size === 0 && !memoized.cache.has('a') && memoized.cache.get('a') === undefined)
  memoized('a', 1)
  memoized('b', 2)
  check('size counts the keys held', memoized.cache.size === 2, String(memoized.cache.size))
  check('has and get answer by key', memoized.cache.has('a') && memoized.cache.get('a') === 'a1' && memoized.cache.get('b') === 'b2' && !memoized.cache.has('c') && memoized.cache.get('c') === undefined)
  check('delete says true for a held key and forgets it', memoized.cache.delete('a') === true && !memoized.cache.has('a') && memoized.cache.size === 1)
  check('delete says false for a key that is not held', memoized.cache.delete('a') === false && memoized.cache.delete('zz') === false)
  memoized('a', 9)
  check('a deleted key is computed again on its next call', calls.join(',') === 'a:1,b:2,a:9' && memoized.cache.get('a') === 'a9', calls.join(','))
  memoized.cache.clear()
  check('clear forgets every key', memoized.cache.size === 0 && !memoized.cache.has('a') && !memoized.cache.has('b'))
  memoized('b', 5)
  check('after clear a key is computed again', calls.at(-1) === 'b:5' && memoized.cache.get('b') === 'b5', calls.join(','))
}

section('§4 the bound: the key used longest ago goes first')
{
  const { calls, memoized } = counted((word, n) => `${word}${n}`, 2)
  memoized('a', 1)
  memoized('b', 1)
  memoized('c', 1)
  check('with room for two, a third key puts out the first', memoized.cache.size === 2 && !memoized.cache.has('a') && memoized.cache.has('b') && memoized.cache.has('c'), `size ${memoized.cache.size}`)
  memoized('b', 2)
  memoized('d', 1)
  check('a call that is served from the cache counts as a use: the other key goes', memoized.cache.has('b') && memoized.cache.has('d') && !memoized.cache.has('c'), `held: ${['a', 'b', 'c', 'd'].filter(key => memoized.cache.has(key)).join(',')}; ${WHERE} must count a served call as the latest use of its key`)
  check('the wrapped function did not run for the served call', calls.join(',') === 'a:1,b:1,c:1,d:1', calls.join(','))
}
{
  const { memoized } = counted((word, n) => `${word}${n}`, 2)
  memoized('a', 1)
  memoized('b', 1)
  const peeked = memoized.cache.get('a')
  const asked = memoized.cache.has('a')
  memoized('c', 1)
  check('reading through the handle (get, has) is not a use: the key read is still the one that goes', peeked === 'a1' && asked && !memoized.cache.has('a') && memoized.cache.has('b') && memoized.cache.has('c'), `held: ${['a', 'b', 'c'].filter(key => memoized.cache.has(key)).join(',')}; the handle of ${WHERE} must look without touching the order of use`)
}
{
  const { calls, memoized } = counted((word, n) => `${word}${n}`)
  for (let i = 0; i < 100; i++) memoized(`k${i}`, i)
  check('with no bound given, one hundred keys are all held', memoized.cache.size === 100 && memoized.cache.has('k0'), String(memoized.cache.size))
  memoized('k100', 100)
  check('the hundred-and-first key puts out the first', memoized.cache.size === 100 && !memoized.cache.has('k0') && memoized.cache.has('k1') && memoized.cache.has('k100'), `size ${memoized.cache.size}; the default bound of ${WHERE} is 100 keys`)
  memoized('k0', 0)
  check('and the key that went is computed again', calls.at(-1) === 'k0:0' && calls.length === 102, String(calls.length))
}

section('§5 the laws, on generated call sequences')
{
  const keys = fc.array(fc.constantFrom('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'), { maxLength: 60 })
  const unbounded = fc.property(keys, sequence => {
    const { calls, memoized } = counted((word, n) => `${word}:${n}`)
    const answers = sequence.map((word, n) => memoized(word, n))
    const firstSeen = new Map<string, number>()
    sequence.forEach((word, n) => { if (!firstSeen.has(word)) firstSeen.set(word, n) })
    return calls.length === firstSeen.size && answers.every((answer, n) => answer === `${sequence[n]}:${firstSeen.get(sequence[n]!)}`) && memoized.cache.size === firstSeen.size
  })
  const first = fc.check(unbounded, { numRuns: 300 })
  check('while every key fits, the wrapped function runs once per distinct key and every call answers that first value', !first.failed, `counterexample ${JSON.stringify(first.counterexample)}; see ${WHERE}`)

  const bounded = fc.property(keys, fc.integer({ min: 1, max: 5 }), (sequence, max) => {
    const { calls, memoized } = counted((word, n) => `${word}:${n}`, max)
    const model: string[] = []
    let expectedCalls = 0
    for (const [n, word] of sequence.entries()) {
      memoized(word, n)
      const at = model.indexOf(word)
      if (at === -1) expectedCalls++
      else model.splice(at, 1)
      model.push(word)
      if (model.length > max) model.shift()
      if (memoized.cache.size !== model.length || !model.every(key => memoized.cache.has(key))) return false
    }
    return calls.length === expectedCalls
  })
  const second = fc.check(bounded, { numRuns: 300 })
  check('with a bound, the keys held are always the most recently used ones, never more than the bound, and a key that went is computed again', !second.failed, `counterexample ${JSON.stringify(second.counterexample)}; see ${WHERE}`)
}

if (failures > 0) {
  console.error(`\nprove-memoize-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-memoize-behaviour: all green')
