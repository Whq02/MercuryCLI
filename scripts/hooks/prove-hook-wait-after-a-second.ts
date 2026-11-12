#!/usr/bin/env bun
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { handoffTurn } from '../lib/fixtureApi.ts'
import { dist, runDoor, sceneRoot, type Row } from './lib/runDoor.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
let failures = 0
let count = 0
const check = (label: string, good: boolean, detail = ''): void => {
  count++
  if (!good) failures++
  console.log(`[${good ? 'PASS' : 'FAIL'}] ${label}${!good && detail ? ` — ${detail.slice(0, 600)}` : ''}`)
}
if (!existsSync(dist)) {
  console.log(`FAIL — ${dist} is missing; build first`)
  process.exit(1)
}

type Hook = { name: string; match: string; run: string; timeout: number }
type Scene = { label: string; tool: 'Read' | 'Bash'; command?: string; before?: Hook[]; after?: Hook[] }

async function play(scene: Scene): Promise<{ code: number | null; rows: Row[]; waits: Row[]; said: string[]; seconds: number[]; resultAt: number; stderr: string }> {
  const paths = sceneRoot(`hook-wait-${scene.label}-`)
  const target = join(paths.cwd, 'README.md')
  writeFileSync(target, 'readme words\n')
  const result = await runDoor(paths, {
    turns: [
      scene.tool === 'Read'
        ? { kind: 'tool_use', name: 'Read', input: { file_path: target }, id: 'wait_call_1' }
        : { kind: 'tool_use', name: 'Bash', input: { command: scene.command ?? 'true', description: 'the held command' }, id: 'wait_call_1' },
      { kind: 'text', text: 'fixture answered' },
      handoffTurn(),
    ],
    hooks: { ...(scene.before ? { 'tool.before': scene.before } : {}), ...(scene.after ? { 'tool.after': scene.after } : {}) },
    args: ['--mode', 'sovereign'],
  })
  const waits = result.rows.filter(row => row.type === 'tool_update' && row.source === 'hook')
  const said = result.rows.filter(row => JSON.stringify(row).includes('waiting on ')).map(row => String(row.line ?? row.text ?? JSON.stringify(row)))
  const resultAt = result.rows.findIndex(row => row.type === 'tool_result' && row.call_id === 'wait_call_1')
  rmSync(paths.root, { recursive: true, force: true })
  return { code: result.code, rows: result.rows, waits, said, seconds: waits.map(row => Number(row.elapsed_s)), resultAt, stderr: result.stderr }
}
const completed = (played: Awaited<ReturnType<typeof play>>): boolean => played.code === 0 && played.rows.some(row => row.type === 'outcome' && row.status === 'completed') && played.rows.some(row => row.type === 'tool_result' && row.status === 'ok')
const countsUp = (seconds: number[]): boolean => seconds.every((value, index) => Number.isInteger(value) && (index === 0 || value > seconds[index - 1]!))
const j = (value: unknown): string => JSON.stringify(value)

console.log(`build under proof: ${dist}`)

console.log('\n§1 a hook that answers at once never puts the wait line on the stream')
{
  const one = await play({ label: 'fast-one', tool: 'Read', before: [{ name: 'guard', match: 'Read', run: 'true', timeout: 10 }] })
  check('one fast tool.before hook: the call runs and the turn completes', completed(one), `code ${one.code} ${one.stderr.slice(0, 300)}`)
  check('…and no row says "waiting on hook guard": not at 0 s, not at all', one.waits.length === 0 && one.said.length === 0, j(one.said))
  const many = await play({
    label: 'fast-many',
    tool: 'Read',
    before: [
      { name: 'guard', match: 'Read', run: 'true', timeout: 10 },
      { name: 'second-guard', match: 'Read', run: 'true', timeout: 10 },
    ],
    after: [{ name: 'after-guard', match: 'Read', run: 'true', timeout: 10 }],
  })
  check('two fast tool.before hooks and a fast tool.after hook: the turn completes', completed(many), `code ${many.code} ${many.stderr.slice(0, 300)}`)
  check('…and no row says "waiting on" for either event', many.waits.length === 0 && many.said.length === 0, j(many.said))
}

console.log('\n§2 a hook that holds the call is said from its first whole second, and the count goes up')
{
  const slow = await play({ label: 'slow-before', tool: 'Read', before: [{ name: 'slow-guard', match: 'Read', run: 'sleep 2.6', timeout: 10 }] })
  console.log(`  the wait rows of a tool.before hook that holds 2.6 s: ${j(slow.waits.map(row => row.line))}`)
  check('a slow tool.before hook: the turn completes', completed(slow), `code ${slow.code} ${slow.stderr.slice(0, 300)}`)
  check('the first wait row comes after a whole second, never at 0 s', slow.seconds.length >= 1 && slow.seconds[0]! >= 1 && slow.seconds[0]! <= 2 && !slow.seconds.includes(0), j(slow.seconds))
  check('the seconds count up, one row a second, and stop inside the hold', slow.seconds.length >= 2 && slow.seconds.length <= 4 && countsUp(slow.seconds), j(slow.seconds))
  check('each row names the hook and its timeout: "waiting on hook slow-guard · N s of 10"', slow.waits.length > 0 && slow.waits.every(row => row.line === `waiting on hook slow-guard · ${String(row.elapsed_s)} s of 10`), j(slow.waits.map(row => row.line)))
  check('every wait row stands before the result of the call it held', slow.resultAt > 0 && slow.waits.every(row => slow.rows.indexOf(row) < slow.resultAt), `${slow.waits.map(row => slow.rows.indexOf(row)).join(',')} against ${slow.resultAt}`)
}
{
  const after = await play({ label: 'slow-after', tool: 'Read', after: [{ name: 'slow-after', match: 'Read', run: 'sleep 2.6', timeout: 10 }] })
  console.log(`  the wait rows of a tool.after hook that holds 2.6 s: ${j(after.waits.map(row => row.line))}`)
  check('a slow tool.after hook: the turn completes', completed(after), `code ${after.code} ${after.stderr.slice(0, 300)}`)
  check('its first wait row comes after a whole second and the count goes up', after.seconds.length >= 2 && after.seconds[0]! >= 1 && after.seconds[0]! <= 2 && !after.seconds.includes(0) && countsUp(after.seconds), j(after.seconds))
  check('each row names it: "waiting on hook slow-after · N s of 10"', after.waits.length > 0 && after.waits.every(row => row.line === `waiting on hook slow-after · ${String(row.elapsed_s)} s of 10`), j(after.waits.map(row => row.line)))
}
{
  const many = await play({
    label: 'slow-many',
    tool: 'Read',
    before: [
      { name: 'first', match: 'Read', run: 'sleep 2.6', timeout: 10 },
      { name: 'second', match: 'Read', run: 'sleep 1.3', timeout: 20 },
    ],
  })
  console.log(`  the wait rows of two tool.before hooks at once: ${j(many.waits.map(row => row.line))}`)
  check('two slow tool.before hooks at once: the turn completes', completed(many), `code ${many.code} ${many.stderr.slice(0, 300)}`)
  check('they are said together from the first whole second: "waiting on 2 tool.before hooks (first, second) · N s of 20"', many.waits.length >= 2 && many.seconds[0]! >= 1 && many.seconds[0]! <= 2 && !many.seconds.includes(0) && countsUp(many.seconds) && many.waits.every(row => row.line === `waiting on 2 tool.before hooks (first, second) · ${String(row.elapsed_s)} s of 20`), j(many.waits.map(row => row.line)))
}

console.log('\n§3 the line is gone when the hook ends: a command that runs on after its hook is not counted against it')
{
  const held = await play({ label: 'gone', tool: 'Bash', command: 'sleep 3', before: [{ name: 'brief-guard', match: 'Bash', run: 'sleep 1.5', timeout: 10 }] })
  console.log(`  the wait rows of a 1.5 s hook before a 3 s command: ${j(held.waits.map(row => row.line))}`)
  check('a 1.5 s hook before a 3 s command: the turn completes', completed(held), `code ${held.code} ${held.stderr.slice(0, 300)}`)
  check('the hook is said for its own second and no longer: one row or two, none while the command runs', held.seconds.length >= 1 && held.seconds.length <= 2 && held.seconds[0]! >= 1 && Math.max(...held.seconds) <= 2 && !held.seconds.includes(0), j(held.seconds))
}

console.log(`\n${count} checks, ${failures} failures`)
if (failures > 0) {
  console.log('HOOK WAIT AFTER A SECOND RED')
  process.exit(1)
}
console.log('HOOK WAIT AFTER A SECOND GREEN')
