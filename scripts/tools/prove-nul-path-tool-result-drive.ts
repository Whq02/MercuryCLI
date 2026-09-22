#!/usr/bin/env bun
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DIST, SCRATCH_ROOT } from '../daemon/dupline-world.ts'
import { runScriptedTurn, startScriptedFixture, type ScriptedRequest, type WireBlock } from '../lib/scriptedTurn.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const root = mkdtempSync(join(SCRATCH_ROOT, 'nul-path-tool-result-'))
const runHome = join(root, 'home')
const cwd = join(root, 'cwd')
mkdirSync(cwd, { recursive: true })
writeFileSync(join(cwd, 'xy.txt'), 'a plain line\n')
console.log(`  bundle: ${DIST}`)

const nul = String.fromCharCode(0)
const nulPath = join(cwd, `x${nul}y.txt`)
const calls: WireBlock[] = [
  { type: 'tool_use', name: 'Read', input: { file_path: nulPath } },
  { type: 'tool_use', name: 'Edit', input: { file_path: nulPath, old_string: 'a', new_string: 'b', replace_all: false } },
  { type: 'tool_use', name: 'Write', input: { file_path: nulPath, content: 'x' } },
  { type: 'tool_use', name: 'Grep', input: { pattern: 'plain', path: nulPath } },
  { type: 'tool_use', name: 'Glob', input: { pattern: '*.txt', path: nulPath } },
]
const seen: Array<{ step: number; results: ScriptedRequest['results'] }> = []
const fixture = await startScriptedFixture((req): WireBlock[] => {
  seen.push({ step: req.step, results: req.results })
  const next = calls[req.step]
  return next !== undefined ? [next] : [{ type: 'text', text: 'done' }]
})
const turn = await runScriptedTurn({ runHome, cwd, base: fixture.base, ask: 'read the odd path', timeoutMs: 240_000 })
await fixture.close()

const subtype = turn.result === null ? 'none' : String((turn.result as { subtype?: string }).subtype)
console.log(`  requests ${fixture.requests.length} · seat exit ${turn.exitCode} · result ${subtype}`)
if (subtype === 'error_during_execution' || fixture.requests.length < calls.length + 1) {
  console.log(`  stderr tail: ${JSON.stringify(turn.stderr.slice(-600))}`)
}
for (const [index, call] of calls.entries()) {
  const request = seen.find(s => s.step === index + 1)
  const result = request?.results[0]
  console.log(`  ${(call as { name: string }).name}: ${result === undefined ? 'no tool result reached the wire' : `${result.isError ? 'error' : 'ok'} · ${JSON.stringify(result.text.slice(0, 120))}`}`)
  check(`${(call as { name: string }).name} with a NUL in its path answers one error-marked tool result`, result !== undefined && result.isError, result === undefined ? 'no result' : result.text.slice(0, 120))
  check(`${(call as { name: string }).name}'s result says the path holds a NUL byte`, result !== undefined && /NUL|null byte/i.test(result.text), result?.text.slice(0, 120) ?? 'no result')
}
check('the turn runs to its end (the model answers after every tool)', fixture.requests.length === calls.length + 1 && subtype !== 'error_during_execution', `${fixture.requests.length} requests · ${subtype}`)

console.log(failures === 0 ? '\nGREEN' : `\nRED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
