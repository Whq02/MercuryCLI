#!/usr/bin/env bun
process.env.MERCURY_DESKTOP_DRIVER = 'none'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'away-summary-roster-'))
process.env.MERCURY_CONFIG_DIR = HOME
delete process.env.MERCURY_HOME

const { enableConfigs } = await import('../../src/utils/config.ts')
enableConfigs()
const { getAllBaseTools } = await import('../../src/tools.ts')
const { buildAwayRecap, collectAwayWork } = await import('../../src/utils/cockpit/awaySummary.ts')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

const NOW = Date.parse('2026-01-01T12:00:00.000Z')
let seq = 0
const uid = (): string => `u-${seq++}`
const operatorTurn = (when: string) => ({ type: 'user', uuid: uid(), timestamp: when, message: { role: 'user', content: [{ type: 'text', text: 'go' }] } })
const toolTurn = (when: string, name: string) => ({
  type: 'assistant', uuid: uid(), timestamp: when,
  message: { id: uid(), role: 'assistant', content: [{ type: 'tool_use', id: uid(), name, input: {} }] },
})

console.log('the away recap names every tool the roster carries: one transcript per catalogue tool, the recap line ends with that tool')
try {
  const roster = getAllBaseTools()
  check('the catalogue answers a roster', roster.length >= 25, String(roster.length))
  const names = roster.map(tool => tool.name)
  for (const name of names) {
    const recap = buildAwayRecap([operatorTurn('2026-01-01T10:59:00.000Z'), toolTurn('2026-01-01T11:00:00.000Z', name)] as never, NOW)
    check(`${name}: the recap line names it`, recap?.topTools === `${name}×1` && recap.line.endsWith(` · ${name}×1`), String(recap?.line))
  }
  const everyTool = [operatorTurn('2026-01-01T10:59:00.000Z'), ...names.map(name => toolTurn('2026-01-01T11:00:00.000Z', name))]
  const counted = new Map(collectAwayWork(everyTool as never).toolCounts)
  const missing = names.filter(name => counted.get(name) !== 1)
  check('one transcript naming every roster tool once counts each of them once', missing.length === 0, missing.join(', '))
} finally {
  rmSync(HOME, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nprove-away-summary-roster: ALL LAWS HOLD' : `\nprove-away-summary-roster: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
