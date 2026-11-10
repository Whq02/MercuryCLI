#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const HEADER = 'context-1m-2025-08-07'
const OAUTH = 'oauth-2025-04-20'
const IGNORED = 'unverified [1m] suffix ignored; resolved as the base id'

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

type Row = { asked: string; sent: unknown; beta: string; bearer: boolean; window: number; fold: number; gauge: string; reason: string; name: string; error: string }
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
const sized = (rows: Array<Row | undefined>): string => rows.map(row => (row === undefined ? 'no request' : `${row.asked} → ${String(row.sent)} ${row.window} gauge ${row.gauge} fold ${row.fold} name "${row.name}"${row.reason ? ` (${row.reason})` : ''}`)).join(' · ')

const PAIR = ['claude-opus-4-6[1m]', 'claude-sonnet-4-6[1m]']
const HEADER_HELD = ['claude-sonnet-4-5[1m]', 'claude-sonnet-4[1m]', 'claude-sonnet-4-5-20250929[1m]', 'claude-sonnet-4-20250514[1m]']
const SWITCHED = [...PAIR, ...HEADER_HELD]
const bare = (id: string): string => id.replace('[1m]', '')
const NATIVE_SUFFIXED = ['claude-opus-4-8[1m]', 'claude-opus-4-7[1m]', 'claude-fable-5[1m]', 'claude-fable-5-2[1m]', 'claude-mythos-5-1[1m]', 'claude-opus-5-5[1m]', 'claude-sonnet-5[1m]', 'claude-haiku-5-5[1m]']
const PLAIN = ['claude-opus-4-6', 'claude-opus-4-8']
const NO_POSITION = ['claude-opus-4-5[1m]', 'claude-haiku-4-5[1m]']

section("§1 an API key: the 1M header rides a [1m] id whose window is an opt-in, and no id that reads 1M by its own name (the vendor's client composes it the same way; its page: \"you don't need a beta header\")")
{
  const key = capture('key', [...SWITCHED, ...NATIVE_SUFFIXED, ...PLAIN, ...NO_POSITION])
  console.log(`  [record] ${show(key.rows)}`)
  check('every request was served on the key, none through a subscription', key.failed === '' && !key.subscriber && key.rows.length === SWITCHED.length + NATIVE_SUFFIXED.length + PLAIN.length + NO_POSITION.length && key.rows.every(row => row.error === '' && !row.bearer), key.failed || show(key.rows))
  check('Opus 4.6, Sonnet 4.6, Sonnet 4.5 and Sonnet 4 asked with [1m] carry the header, the id on the wire without its suffix', SWITCHED.every(id => carries(rowOf(key, id)) && rowOf(key, id)?.sent === bare(id)), show(key.rows.filter(row => SWITCHED.includes(row.asked))))
  check('…and each is sized by that position: a 1,000,000 window, the gauge 1000k, the fold line past 900,000', SWITCHED.every(id => rowOf(key, id)?.window === 1_000_000 && rowOf(key, id)?.gauge === '1000k' && (rowOf(key, id)?.fold ?? 0) > 900_000), sized(SWITCHED.map(id => rowOf(key, id))))
  check('…a dated Sonnet 4.5 or Sonnet 4 id named with the 1M context it has there', rowOf(key, 'claude-sonnet-4-5-20250929[1m]')?.name === 'Sonnet 4.5 (1M context) · Sonnet 4.5 (with 1M context)' && rowOf(key, 'claude-sonnet-4-20250514[1m]')?.name === 'Sonnet 4 (1M context) · Sonnet 4 (with 1M context)', sized([rowOf(key, 'claude-sonnet-4-5-20250929[1m]'), rowOf(key, 'claude-sonnet-4-20250514[1m]')]))
  check('a natively-1M id asked with [1m] carries no 1M header: the window is its own', NATIVE_SUFFIXED.every(id => rowOf(key, id) !== undefined && !carries(rowOf(key, id))), show(key.rows.filter(row => NATIVE_SUFFIXED.includes(row.asked) && carries(row))))
  check('…and still resolves its 1,000,000 window', NATIVE_SUFFIXED.every(id => rowOf(key, id)?.window === 1_000_000), key.rows.filter(row => NATIVE_SUFFIXED.includes(row.asked)).map(row => `${row.asked}=${row.window}`).join(' '))
  check('an id asked as it stands carries none', PLAIN.every(id => rowOf(key, id) !== undefined && !carries(rowOf(key, id))), show(key.rows.filter(row => PLAIN.includes(row.asked))))
  check('[1m] on an id with no 1M position (Opus 4.5, Haiku 4.5) is the base id on the wire: no header, a 200,000 window', NO_POSITION.every(id => rowOf(key, id) !== undefined && !carries(rowOf(key, id)) && rowOf(key, id)?.window === 200_000 && !String(rowOf(key, id)?.sent).includes('[')), show(key.rows.filter(row => NO_POSITION.includes(row.asked))) + ' ' + key.rows.filter(row => NO_POSITION.includes(row.asked)).map(row => row.window).join('/'))
}

section('§2 a subscription sign-in: no request carries the 1M header, whatever the id (the vendor\'s client takes it out of every request there)')
{
  const subscriber = capture('subscriber', [...SWITCHED, ...HEADER_HELD.map(bare), 'claude-opus-4-8[1m]', 'claude-opus-4-6'])
  console.log(`  [record] ${show(subscriber.rows)}`)
  console.log(`  [record] ${sized(SWITCHED.map(id => rowOf(subscriber, id)))}`)
  check('every request rode the subscription: a bearer credential and the sign-in\'s own beta', subscriber.failed === '' && subscriber.subscriber && subscriber.rows.length === SWITCHED.length + HEADER_HELD.length + 2 && subscriber.rows.every(row => row.error === '' && row.bearer && row.beta.includes(OAUTH)), subscriber.failed || show(subscriber.rows))
  check('no id asked with [1m] carries the 1M header', SWITCHED.every(id => rowOf(subscriber, id) !== undefined && !carries(rowOf(subscriber, id))), show(subscriber.rows.filter(row => carries(row))))
  check('Opus 4.6 and Sonnet 4.6 keep their [1m] position without it: a 1,000,000 window, the gauge 1000k, the fold line past 900,000, the wire id without its suffix', PAIR.every(id => rowOf(subscriber, id)?.window === 1_000_000 && rowOf(subscriber, id)?.gauge === '1000k' && (rowOf(subscriber, id)?.fold ?? 0) > 900_000 && rowOf(subscriber, id)?.sent === bare(id)), sized(PAIR.map(id => rowOf(subscriber, id))))
  check("Sonnet 4.5 and Sonnet 4, which the vendor holds at 200,000 without that header (its client's rows for the two: clamp_long_context_without_beta), resolve as their base id: a 200,000 window and a fold line under it, the words of an ignored suffix, the base id on the wire", HEADER_HELD.every(id => rowOf(subscriber, id)?.window === 200_000 && (rowOf(subscriber, id)?.fold ?? 200_000) < 200_000 && rowOf(subscriber, id)?.reason === IGNORED && rowOf(subscriber, id)?.sent === bare(id)), sized(HEADER_HELD.map(id => rowOf(subscriber, id))))
  check('…the gauge and the fold line the base id itself reads', HEADER_HELD.every(id => rowOf(subscriber, id) !== undefined && rowOf(subscriber, id)?.gauge === rowOf(subscriber, bare(id))?.gauge && rowOf(subscriber, id)?.fold === rowOf(subscriber, bare(id))?.fold && rowOf(subscriber, id)?.window === rowOf(subscriber, bare(id))?.window), sized([...HEADER_HELD, ...HEADER_HELD.map(bare)].map(id => rowOf(subscriber, id))))
  check('…and a dated id of the two is named without a 1M context it does not have there', rowOf(subscriber, 'claude-sonnet-4-5-20250929[1m]')?.name === 'Sonnet 4.5 · Sonnet 4.5' && rowOf(subscriber, 'claude-sonnet-4-20250514[1m]')?.name === 'Sonnet 4 · Sonnet 4' && rowOf(subscriber, 'claude-opus-4-6[1m]')?.name === 'Opus 4.6 (1M context) · Opus 4.6 (with 1M context)', sized([rowOf(subscriber, 'claude-sonnet-4-5-20250929[1m]'), rowOf(subscriber, 'claude-sonnet-4-20250514[1m]'), rowOf(subscriber, 'claude-opus-4-6[1m]')]))
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
