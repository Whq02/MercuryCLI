#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.env.PROVE_ROOT ?? join(import.meta.dir, '../..')
const source = readFileSync(join(root, 'scripts/jev/prove-jev-roster.ts'), 'utf8')
const fixture = JSON.parse(readFileSync(join(root, 'scripts/jev/fixtures/roster-ceiling.json'), 'utf8'))
let failures = 0
function check(label: string, ok: boolean): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}`)
}
check('JevEval bytes are reported, never compared in a failing check', !source.split('\n').some(line => line.includes('check(') && /\bbytes\s*(?:<=|>=|<|>)/.test(line)))
check('the report names the byte and estimated token measures', source.includes('reported, never bounded') && source.includes('estimated tokens') && source.includes('bytes on the wire'))
check('the former ceiling is an observation, not a ratchet', /report/.test(fixture.rule) && /never.*fail/.test(fixture.rule) && !/ratchet|raise it|lower it/.test(fixture.rule))
check('no shrinking prompt or schema is asked to ratchet a size down', !source.includes('ratchet it down'))
process.exit(failures === 0 ? 0 : 1)
