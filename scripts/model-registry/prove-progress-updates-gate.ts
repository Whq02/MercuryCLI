#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const HEADER = 'thinking-display-updates-2026-08-18'

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

type Row = { asked: string; beta: string; thinking: { type?: string; display?: string } | null; error: string }
function wire(models: string[], env: Record<string, string>): { rows: Row[]; failed: string } {
  const child = spawnSync(process.execPath, [join(import.meta.dir, 'context1mHeaderCapture.ts'), 'key', models.join(','), '', 'thinking'], {
    cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
  })
  const found = child.stdout.split('\n').find(row => row.startsWith('CAPTURE '))
  if (found === undefined) return { rows: [], failed: `no capture (exit ${child.status}): ${child.stderr.slice(-600)}` }
  return JSON.parse(found.slice(8)) as { rows: Row[]; failed: string }
}
const asksUpdates = (row: Row): boolean => row.thinking?.display === 'updates' && row.beta.split(',').map(word => word.trim()).includes(HEADER)
const asksNothing = (row: Row): boolean => row.thinking?.display === undefined && !row.beta.includes(HEADER)
const shown = (rows: Row[]): string => rows.map(row => `${row.asked} ${JSON.stringify(row.thinking)}${row.beta.includes(HEADER) ? ' +beta' : ''}${row.error ? ` ERROR ${row.error.slice(0, 60)}` : ''}`).join(' · ')

const SEVEN = ['claude-fable-5-2', 'claude-mythos-5-2', 'claude-fable-5-1', 'claude-mythos-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5']
const OTHERS = ['claude-mythos-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-5-5', 'claude-opus-4-8', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5']

section('§1 MERCURY_THINKING_DISPLAY=updates, a thinking request per model on the loopback Messages fixture: the seven models the vendor names ("the model can write a progress update between tool calls", platform.claude.com/docs/en/build-with-claude/thinking, read 10 Nov 2026) are asked for their updates, and no other')
{
  const on = wire([...SEVEN, ...OTHERS], { MERCURY_THINKING_DISPLAY: 'updates' })
  console.log(`  [record] ${shown(on.rows)}`)
  check('every request was served', on.failed === '' && on.rows.length === SEVEN.length + OTHERS.length && on.rows.every(row => row.error === ''), on.failed || shown(on.rows))
  for (const id of SEVEN) {
    const row = on.rows.find(r => r.asked === id)
    check(`${id}: thinking carries display "updates" and the request its beta header`, row !== undefined && asksUpdates(row), row === undefined ? 'no request' : shown([row]))
  }
  check('every other id carries neither: Mythos 5, Opus 5, Sonnet 5, Haiku 5.5, Opus 4.8, Opus 4.6, Sonnet 4.6, Haiku 4.5', OTHERS.every(id => on.rows.some(r => r.asked === id && asksNothing(r))), shown(on.rows.filter(row => OTHERS.includes(row.asked) && !asksNothing(row))))
}

section('§2 the switch off: nothing set, and MERCURY_THINKING_DISPLAY=off')
{
  const unset = wire(SEVEN, {})
  check('nothing set: none of the seven carries the display value or the header', unset.failed === '' && unset.rows.length === SEVEN.length && unset.rows.every(row => row.error === '' && asksNothing(row)), unset.failed || shown(unset.rows))
  const off = wire(SEVEN, { MERCURY_THINKING_DISPLAY: 'off' })
  check('off: none of the seven carries the display value or the header', off.failed === '' && off.rows.length === SEVEN.length && off.rows.every(row => row.error === '' && asksNothing(row)), off.failed || shown(off.rows))
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAIL`} — ${checks} checks`)
process.exit(failures === 0 ? 0 : 1)
