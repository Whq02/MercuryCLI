#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const HEADER = 'context-1m-2025-08-07'
const OAUTH = 'oauth-2025-04-20'

let failures = 0
let checks = 0
function check(label: string, ok: boolean, detail = ''): void {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail.slice(0, 900)}` : ''}`)
}
function section(title: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + title + '\n' + '─'.repeat(76))
}

type Row = { asked: string; sent: unknown; beta: string; bearer: boolean; window: number; error: string }
type Capture = { arm: string; subscriber: boolean; rows: Row[]; failed: string }
function capture(arm: string, models: string[], env: Record<string, string> = {}): Capture {
  const child = spawnSync(process.execPath, [join(import.meta.dir, 'context1mHeaderCapture.ts'), arm, models.join(',')], {
    cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
  })
  const line = child.stdout.split('\n').find(row => row.startsWith('CAPTURE '))
  if (line === undefined) return { arm, subscriber: false, rows: [], failed: `no capture (exit ${child.status}): ${child.stderr.slice(-600)}` }
  return JSON.parse(line.slice(8)) as Capture
}
const carries = (row: Row | undefined): boolean => row !== undefined && row.beta.split(',').map(word => word.trim()).includes(HEADER)
const show = (rows: Row[]): string => rows.map(row => `${row.asked} → ${String(row.sent)} [${row.beta}]${row.error ? ` ERROR ${row.error.slice(0, 80)}` : ''}`).join(' · ')
const rowOf = (c: Capture, id: string): Row | undefined => c.rows.find(row => row.asked === id)

const SWITCHED = ['claude-opus-4-6[1m]', 'claude-sonnet-4-6[1m]', 'claude-sonnet-4-5[1m]']
const NATIVE_SUFFIXED = ['claude-opus-4-8[1m]', 'claude-opus-4-7[1m]', 'claude-fable-5[1m]', 'claude-fable-5-2[1m]', 'claude-mythos-5-1[1m]', 'claude-opus-5-5[1m]', 'claude-sonnet-5[1m]', 'claude-haiku-5-5[1m]']
const PLAIN = ['claude-opus-4-6', 'claude-opus-4-8']
const NO_POSITION = ['claude-opus-4-5[1m]', 'claude-haiku-4-5[1m]']

section("§1 an API key: the 1M header rides a [1m] id whose window is an opt-in, and no id that reads 1M by its own name (the vendor's client composes it the same way; its page: \"you don't need a beta header\")")
{
  const key = capture('key', [...SWITCHED, ...NATIVE_SUFFIXED, ...PLAIN, ...NO_POSITION])
  console.log(`  [record] ${show(key.rows)}`)
  check('every request was served on the key, none through a subscription', key.failed === '' && !key.subscriber && key.rows.length === SWITCHED.length + NATIVE_SUFFIXED.length + PLAIN.length + NO_POSITION.length && key.rows.every(row => row.error === '' && !row.bearer), key.failed || show(key.rows))
  check('Opus 4.6, Sonnet 4.6 and Sonnet 4.5 asked with [1m] carry the header, the id on the wire without its suffix', SWITCHED.every(id => carries(rowOf(key, id)) && typeof rowOf(key, id)?.sent === 'string' && !String(rowOf(key, id)?.sent).includes('[')), show(key.rows.filter(row => SWITCHED.includes(row.asked))))
  check('a natively-1M id asked with [1m] carries no 1M header: the window is its own', NATIVE_SUFFIXED.every(id => rowOf(key, id) !== undefined && !carries(rowOf(key, id))), show(key.rows.filter(row => NATIVE_SUFFIXED.includes(row.asked) && carries(row))))
  check('…and still resolves its 1,000,000 window', NATIVE_SUFFIXED.every(id => rowOf(key, id)?.window === 1_000_000), key.rows.filter(row => NATIVE_SUFFIXED.includes(row.asked)).map(row => `${row.asked}=${row.window}`).join(' '))
  check('an id asked as it stands carries none', PLAIN.every(id => rowOf(key, id) !== undefined && !carries(rowOf(key, id))), show(key.rows.filter(row => PLAIN.includes(row.asked))))
  check('[1m] on an id with no 1M position (Opus 4.5, Haiku 4.5) is the base id on the wire: no header, a 200,000 window', NO_POSITION.every(id => rowOf(key, id) !== undefined && !carries(rowOf(key, id)) && rowOf(key, id)?.window === 200_000 && !String(rowOf(key, id)?.sent).includes('[')), show(key.rows.filter(row => NO_POSITION.includes(row.asked))) + ' ' + key.rows.filter(row => NO_POSITION.includes(row.asked)).map(row => row.window).join('/'))
}

section('§2 a subscription sign-in: no request carries the 1M header, whatever the id (the vendor\'s client takes it out of every request there)')
{
  const subscriber = capture('subscriber', [...SWITCHED, 'claude-opus-4-8[1m]', 'claude-opus-4-6'])
  console.log(`  [record] ${show(subscriber.rows)}`)
  check('every request rode the subscription: a bearer credential and the sign-in\'s own beta', subscriber.failed === '' && subscriber.subscriber && subscriber.rows.length === SWITCHED.length + 2 && subscriber.rows.every(row => row.error === '' && row.bearer && row.beta.includes(OAUTH)), subscriber.failed || show(subscriber.rows))
  check('Opus 4.6, Sonnet 4.6 and Sonnet 4.5 asked with [1m] carry no 1M header', SWITCHED.every(id => rowOf(subscriber, id) !== undefined && !carries(rowOf(subscriber, id))), show(subscriber.rows.filter(row => carries(row))))
  check('the [1m] position still sizes the session at 1,000,000 and the wire id drops the suffix', SWITCHED.every(id => rowOf(subscriber, id)?.window === 1_000_000 && !String(rowOf(subscriber, id)?.sent).includes('[')), subscriber.rows.map(row => `${row.asked}=${row.window}/${String(row.sent)}`).join(' '))
  check('a native id and a plain id carry none either', !carries(rowOf(subscriber, 'claude-opus-4-8[1m]')) && !carries(rowOf(subscriber, 'claude-opus-4-6')), show(subscriber.rows))
}

section('§3 unchanged: the kill switch, and the header an operator asks for by name')
{
  const off = capture('key', ['claude-opus-4-6[1m]'], { MERCURY_DISABLE_1M_CONTEXT: '1' })
  check('MERCURY_DISABLE_1M_CONTEXT: a [1m] id carries no header and sizes at 200,000', off.failed === '' && !carries(off.rows[0]) && off.rows[0]?.window === 200_000, off.failed || show(off.rows))
  const preview = capture('key-preview', ['claude-opus-4-6', 'claude-opus-4-8'])
  console.log(`  [record] --provider-preview ${HEADER} on a key: ${show(preview.rows)}`)
  check('with a key, the header an operator names with --provider-preview rides the request as before', preview.failed === '' && preview.rows.length === 2 && preview.rows.every(row => row.error === '' && carries(row)), preview.failed || show(preview.rows))
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
