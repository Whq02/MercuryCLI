#!/usr/bin/env bun
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const cwd = join(tmpdir(), `unproven-ask-${process.pid}`)
mkdirSync(cwd, { recursive: true })
process.chdir(cwd)
const { enableConfigs } = await import('../../src/utils/config.js')
enableConfigs()
const { getEmptyToolPermissionContext } = await import('../../src/Tool.js')
const { bashToolHasPermission } = await import('../../src/tools/BashTool/bashPermissions.js')
const context = { ...getEmptyToolPermissionContext(), mode: 'default' as const }
let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${ok || !detail ? '' : ` — ${detail}`}`)
}
const unproven = [
  `echo $$ > "${cwd}/pidfile"; exec tail -f "${cwd}/bg.log"`,
  'echo $$',
  'exec tail -f log',
  'ls "unterminated',
  `echo ${'x'.repeat(10_001)}`,
]
for (const command of unproven) {
  const result = await bashToolHasPermission({ command }, context)
  const reason = result.decisionReason
  const ordinary = result.behavior === 'ask' && reason?.type === 'safetyCheck' && reason.operatorOnly === false && !('floor' in reason)
  check(`an unprovable command asks as an ORDINARY ask a mode or a rule can answer: ${JSON.stringify(command.slice(0, 48))}`, ordinary, JSON.stringify({ behavior: result.behavior, reason }))
}
console.log(failures === 0 ? 'unproven-ask-is-ordinary: all green' : `unproven-ask-is-ordinary: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
