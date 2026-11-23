#!/usr/bin/env bun
import fc from 'fast-check'
import { z } from 'zod/v4'
import { semanticNumber } from '../../src/tools/kit/semanticNumber.ts'

const WHERE = 'semanticNumber in src/tools/kit/semanticNumber.ts'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
  if (!cond) failures++
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}`)
const read = (schema: z.ZodType, value: unknown): unknown => {
  const answer = schema.safeParse(value)
  return answer.success ? answer.data : 'refused'
}
const same = (a: unknown, b: unknown): boolean => Object.is(a, b)

section('§1 with no inner schema it reads a number')
{
  const schema = semanticNumber()
  for (const value of [0, 1, -1, 42, 3.5, -0.25, 1e21, Number.MAX_SAFE_INTEGER]) {
    check(`the number ${value} passes as itself`, same(read(schema, value), value), String(read(schema, value)))
  }
  const texts: Array<[string, number]> = [['0', 0], ['7', 7], ['42', 42], ['-3', -3], ['3.5', 3.5], ['-0.25', -0.25], ['007', 7], ['10.50', 10.5], ['0.0', 0], ['123456789012345678', 123456789012345680]]
  for (const [text, number] of texts) {
    check(`the text ${JSON.stringify(text)} is read as the number ${number}`, same(read(schema, text), number), `${String(read(schema, text))}; ${WHERE} turns a plain decimal text into its number before the inner schema sees it`)
  }
  check('the text "-0" is read as a number equal to zero', read(schema, '-0') === 0, String(read(schema, '-0')))
}

section('§2 a text that is not a plain decimal stays a text, and a number schema refuses it')
{
  const schema = semanticNumber()
  for (const text of ['', ' ', ' 5', '5 ', '5\n', '+5', '.5', '5.', '1e3', '1E3', '0x10', '1_000', '1,000', '--5', '5-', '1.2.3', 'abc', '5a', 'NaN', 'Infinity', '-Infinity', 'true', '٣', '５']) {
    check(`${JSON.stringify(text)} is refused`, read(schema, text) === 'refused', `${String(read(schema, text))}; ${WHERE} reads digits, one optional leading minus and one optional dot with digits on both sides, and nothing else`)
  }
  check('a decimal text too large to be a finite number is refused', read(schema, '9'.repeat(400)) === 'refused', String(read(schema, '9'.repeat(400))))
  for (const [name, value] of [['true', true], ['null', null], ['undefined', undefined], ['an array', [1]], ['an object', { value: 1 }], ['NaN', Number.NaN], ['a bigint', 5n]] as const) {
    check(`${name} is not turned into a number`, read(schema, value) === 'refused', String(read(schema, value)))
  }
}

section('§3 the inner schema judges the number that was read')
{
  const whole = semanticNumber(z.number().int().min(1).max(10))
  check('a text inside the inner rule passes as its number', read(whole, '7') === 7 && read(whole, 10) === 10)
  check('a text whose number breaks the inner rule is refused by it', read(whole, '0') === 'refused' && read(whole, '11') === 'refused' && read(whole, '2.5') === 'refused' && read(whole, -1) === 'refused')
  const optional = semanticNumber(z.number().optional())
  check('with an optional inner schema, nothing given passes as nothing', read(optional, undefined) === undefined && read(optional, '4') === 4 && read(optional, 'four') === 'refused')
  const defaulted = semanticNumber(z.number().default(9))
  check('with a default in the inner schema, nothing given becomes the default', read(defaulted, undefined) === 9 && read(defaulted, '3') === 3)
  const literal = semanticNumber(z.literal(5))
  check('with a literal inner schema, the text of that number passes', read(literal, '5') === 5 && read(literal, '5.0') === 5 && read(literal, '6') === 'refused')
  const eitherWay = semanticNumber(z.union([z.number(), z.string()]))
  check('with an inner schema that also takes text, a decimal text still arrives as a number and other text as text', read(eitherWay, '12') === 12 && read(eitherWay, 'twelve') === 'twelve' && read(eitherWay, '1e3') === '1e3', JSON.stringify([read(eitherWay, '12'), read(eitherWay, 'twelve'), read(eitherWay, '1e3')]))
  const inObject = z.object({ limit: semanticNumber(z.number().int()), name: z.string() })
  check('inside an object schema it reads its own member only', JSON.stringify(read(inObject, { limit: '25', name: '25' })) === '{"limit":25,"name":"25"}', JSON.stringify(read(inObject, { limit: '25', name: '25' })))
}

section('§4 the laws, on generated values')
{
  const schema = semanticNumber()
  const integers = fc.check(fc.property(fc.integer(), n => same(read(schema, String(n)), n === 0 ? 0 : n) && same(read(schema, n), n)), { numRuns: 500 })
  check('every whole number written out in digits is read back as that number, and the number itself passes unchanged', !integers.failed, `counterexample ${JSON.stringify(integers.counterexample)}; see ${WHERE}`)
  const decimals = fc.check(
    fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), fc.integer({ min: 0, max: 999 }), (wholePart, thousandths) => {
      const text = `${wholePart}.${String(thousandths).padStart(3, '0')}`
      return read(schema, text) === Number(text)
    }),
    { numRuns: 500 },
  )
  check('every text of digits, a dot and digits is read as the number JavaScript reads there', !decimals.failed, `counterexample ${JSON.stringify(decimals.counterexample)}; see ${WHERE}`)
  const plain = /^-?\d+(\.\d+)?$/
  const strangers = fc.check(fc.property(fc.string(), text => plain.test(text) || read(schema, text) === 'refused'), { numRuns: 1000 })
  check('every other text is refused by a number schema, whatever JavaScript would make of it', !strangers.failed, `counterexample ${JSON.stringify(strangers.counterexample)}; see ${WHERE}`)
}

if (failures > 0) {
  console.error(`\nprove-semantic-number-behaviour: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-semantic-number-behaviour: all green')
