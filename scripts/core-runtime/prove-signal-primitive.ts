#!/usr/bin/env bun
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const { createSignal } = await import(join(SRC, 'utils/signal.ts'))

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const signal = createSignal<[string]>()
const heard: string[] = []
const first = (word: string) => heard.push(`first:${word}`)
const stopFirst = signal.subscribe(first)
const stopFirstAgain = signal.subscribe(first)
signal.subscribe(word => heard.push(`second:${word}`))
signal.emit('one')
check('a listener subscribed twice is called once, listeners run in subscription order', heard.join(' ') === 'first:one second:one', heard.join(' '))
stopFirstAgain()
signal.emit('two')
check('either unsubscribe closure of a doubly subscribed listener removes it', heard.join(' ') === 'first:one second:one second:two', heard.join(' '))
stopFirst()
signal.emit('three')
check('an unsubscribe after removal changes nothing', heard.join(' ') === 'first:one second:one second:two second:three')

const live = createSignal<[number]>()
const seen: string[] = []
let lateAdded = false
const stopLate = { current: () => {} }
live.subscribe(n => {
  seen.push(`a${n}`)
  if (!lateAdded) {
    lateAdded = true
    stopLate.current = live.subscribe(m => seen.push(`late${m}`))
  }
})
const stopB = live.subscribe(n => seen.push(`b${n}`))
live.subscribe(n => {
  seen.push(`c${n}`)
  if (n === 2) stopB()
})
live.subscribe(n => seen.push(`d${n}`))
live.emit(1)
check('a listener added during an emit is reached in that same emit', seen.join(' ') === 'a1 b1 c1 d1 late1', seen.join(' '))
seen.length = 0
live.emit(2)
check('a listener removed before its turn is skipped in that emit', seen.join(' ') === 'a2 b2 c2 d2 late2' , seen.join(' '))
seen.length = 0
live.emit(3)
check('the removed listener stays gone', seen.join(' ') === 'a3 c3 d3 late3', seen.join(' '))

const nested = createSignal<[number]>()
const order: string[] = []
let reentered = false
nested.subscribe(n => {
  order.push(`enter${n}`)
  if (!reentered) {
    reentered = true
    nested.emit(n + 10)
  }
  order.push(`leave${n}`)
})
nested.emit(1)
check('a nested emit runs synchronously inside the outer one, with no guard', order.join(' ') === 'enter1 enter11 leave11 leave1', order.join(' '))

live.clear()
seen.length = 0
live.emit(4)
check('clear drops every listener', seen.length === 0)
const bare = createSignal()
bare.emit()
check('a signal with no listeners emits quietly', true)

console.log(failures ? `FAIL signal primitive: ${failures} failures` : 'PASS signal primitive')
process.exit(failures ? 1 : 0)
