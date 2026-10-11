#!/usr/bin/env bun
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.MERCURY_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'latest-row-rule-'))
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { findLatestMessage } = await import('../../src/utils/sessionStorage/chain.ts')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

type Row = { uuid: string; timestamp: string; kind?: string }
const row = (uuid: string, timestamp: string, kind = 'user'): Row => ({ uuid, timestamp, kind })
const T0 = '2026-10-11T08:00:00.000Z'
const T1 = '2026-10-11T08:00:00.001Z'
const T2 = '2026-10-11T08:00:00.002Z'
const all = () => true

console.log('the latest row')
check('the greatest stamp wins whatever the order', findLatestMessage([row('b', T1), row('c', T2), row('a', T0)], all)?.uuid === 'c')
check('an equal stamp goes to the later row in iteration order', findLatestMessage([row('first', T2), row('second', T2), row('older', T1)], all)?.uuid === 'second')
check('only accepted rows compete', findLatestMessage([row('u', T0), row('a', T2, 'assistant'), row('v', T1)], r => r.kind === 'user')?.uuid === 'v')
check('no accepted row answers undefined', findLatestMessage([row('a', T2, 'assistant')], r => r.kind === 'user') === undefined)
check('an empty iterable answers undefined', findLatestMessage([], all) === undefined)
check('a row whose stamp does not parse never wins', findLatestMessage([row('x', 'not a date'), row('a', T0)], all)?.uuid === 'a' && findLatestMessage([row('a', T0), row('x', 'not a date')], all)?.uuid === 'a')
check('rows whose stamps all fail to parse answer undefined', findLatestMessage([row('x', 'never'), row('y', '')], all) === undefined)

console.log('the walk')
const asked: string[] = []
const live = new Map([['a', row('a', T0)], ['b', row('b', T1)]])
const picked = findLatestMessage(live.values(), r => { asked.push(r.uuid); return true })
check('a live Map values iterator is walked once in insertion order, the predicate asked once per row', picked?.uuid === 'b' && asked.join(',') === 'a,b', asked.join(','))

console.log(failures ? `FAIL latest row rule: ${failures} failures` : 'PASS latest row rule')
process.exit(failures ? 1 : 0)
