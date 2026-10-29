#!/usr/bin/env bun
import { mkdtempSync, realpathSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'trace-chip-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const ROOT = join(import.meta.dir, '..', '..')

console.log('§1 the snapshot states')
{
  const { traceSnapshot } = await import('../../src/utils/cockpit/traceSnapshot.js')
  const { getInvocationTracePath } = await import('../../src/utils/observability/invocationTrace.js')

  delete process.env.MERCURY_TRACE
  const armed = await traceSnapshot()
  check(
    "an EMPTY store reads 'unavailable' (armed) or 'off' (disarmed) — never a third thing",
    armed.state === 'unavailable' || armed.state === 'off',
    armed.state,
  )
  process.env.MERCURY_TRACE = '1'
  const armedExplicit = await traceSnapshot()
  check("armed + empty ⇒ 'unavailable' with the no-events reason", armedExplicit.state === 'unavailable' && /no (events|trace file) yet/.test(String(armedExplicit.reason)), `${armedExplicit.state}: ${armedExplicit.reason}`)
  const tracePath = getInvocationTracePath()
  mkdirSync(dirname(tracePath), { recursive: true })
  writeFileSync(tracePath, JSON.stringify({ kind: 'invocation', tool: 'Bash', risk: 'high', ok: true }) + '\n')
  const live = await traceSnapshot()
  check("armed + records ⇒ 'live'", live.state === 'live', live.state)
  delete process.env.MERCURY_TRACE
}

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-trace-chip-states: all green' : `\nprove-trace-chip-states: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
