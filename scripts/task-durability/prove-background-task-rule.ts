#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { isBackgroundTask } = await import('../../src/engine/tasks/taskState.ts')

let failures = 0
const HINT = 'check isBackgroundTask in src/engine/tasks/taskState.ts'
const check = (label: string, good: boolean, detail = ''): void => {
  console.log(`${good ? 'PASS' : 'FAIL'} ${label}${good ? (detail ? ` — ${detail}` : '') : ` — ${[detail, HINT].filter(Boolean).join('; ')}`}`)
  if (!good) failures++
}
const record = (extra: Record<string, unknown>): never => ({ id: 't1', description: 'd', startTime: 1, ...extra }) as never

const cases: Array<[string, Record<string, unknown>, boolean]> = [
  ['a running crewmate whose record carries no isBackgrounded member is a background task (1.0.12: present and false alone says no)', { type: 'local_agent', status: 'running' }, true],
  ['a pending shell whose record carries no member is a background task', { type: 'local_bash', status: 'pending' }, true],
  ['a running crewmate with isBackgrounded false is not', { type: 'local_agent', status: 'running', isBackgrounded: false }, false],
  ['a running crewmate with isBackgrounded true is', { type: 'local_agent', status: 'running', isBackgrounded: true }, true],
  ['a running shell with isBackgrounded false is not', { type: 'local_bash', status: 'running', isBackgrounded: false }, false],
  ['a running shell with isBackgrounded true is', { type: 'local_bash', status: 'running', isBackgrounded: true }, true],
  ['a running monitor is', { type: 'monitor_mcp', status: 'running' }, true],
  ['a completed crewmate is not, whatever its member', { type: 'local_agent', status: 'completed', isBackgrounded: true }, false],
  ['a killed shell is not', { type: 'local_bash', status: 'killed', isBackgrounded: true }, false],
]
for (const [label, extra, want] of cases) {
  const got = isBackgroundTask(record(extra))
  check(label, got === want, `answered ${got}`)
}
console.log(failures === 0 ? `all ${cases.length} hold` : `${failures} of ${cases.length} fail`)
process.exit(failures === 0 ? 0 : 1)
export {}
