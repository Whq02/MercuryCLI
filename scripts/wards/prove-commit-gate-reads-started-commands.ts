#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { join } from 'node:path'

let failures = 0
let checks = 0
function check(label: string, cond: boolean, detail = ''): void {
  checks++
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')
for (const key of ['MERCURY_SPAWNED_BY', 'MERCURY_WARDS', 'MERCURY_COMMIT_GATE', 'MERCURY_SKIP_PERMISSIONS']) delete process.env[key]

const { enableConfigs } = await import(join(SRC, 'utils/config.ts'))
const { judgeToolCall, guardsEngaged, resetGuardsForTesting } = await import(join(SRC, 'guards/guards.ts'))
const { COMMIT_GATE_ID, disengageCommitGate, engageCommitGate } = await import(join(SRC, 'guards/commitGate.ts'))
const { deleteFlagEnv, setFlagEnv } = await import(join(SRC, 'substrate/flagRegistry.ts'))
const { BashTool } = await import(join(SRC, 'tools/BashTool/BashTool.tsx'))
const { MonitorTool } = await import(join(SRC, 'tools/MonitorTool/MonitorTool.ts'))
const { ServiceTool } = await import(join(SRC, 'tools/ServiceTool/ServiceTool.ts'))
const { JourneyTool } = await import(join(SRC, 'tools/JourneyTool/JourneyTool.ts'))
const { FileReadTool } = await import(join(SRC, 'tools/FileReadTool/FileReadTool.ts'))
enableConfigs()

const SESSION = 'commit-gate-started-commands'
let calls = 0
async function judged(tool: { name: string }, input: Record<string, unknown>): Promise<string | null> {
  const verdict = await judgeToolCall(SESSION, { tool: tool.name, input, callId: `gate-${++calls}`, messages: [], toolRef: tool as never, asksAnswerable: true })
  return verdict.refused ? `${verdict.guard}: ${verdict.reason}` : null
}
const gated = (reason: string | null): boolean => reason !== null && reason.startsWith(`${COMMIT_GATE_ID}: Commit gate: this commit is not verified.`)
const UNVERIFIED = ['commit', '--no-verify', '-m', 'skip the hooks']

console.log('============================================================')
console.log(' the commit gate reads every tool that starts a command, as the wards do')
console.log('============================================================')

setFlagEnv('MERCURY_COMMIT_GATE', '1')
engageCommitGate(SESSION)

section('§1 the gate is engaged, and a Bash commit that skips the hooks is refused (control)')
{
  check('the commit gate is engaged for the session', guardsEngaged(SESSION).tool.includes(COMMIT_GATE_ID), JSON.stringify(guardsEngaged(SESSION)))
  const bash = await judged(BashTool, { command: 'git commit --no-verify -m "skip the hooks"' })
  check('Bash: git commit --no-verify is refused by the gate', gated(bash), String(bash).slice(0, 160))
}

section('§2 the same commit started by its argv')
{
  const service = await judged(ServiceTool, { op: 'start', name: 'commit', command: 'git', args: UNVERIFIED })
  check('Service start: git commit --no-verify is refused by the gate', gated(service), String(service).slice(0, 160))
  const journey = await judged(JourneyTool, { op: 'run', name: 'commit', steps: [{ kind: 'command.run', id: 'commit', command: 'git', args: UNVERIFIED }] })
  check('Journey command.run: git commit --no-verify is refused by the gate', gated(journey), String(journey).slice(0, 160))
  const later = await judged(JourneyTool, {
    op: 'run',
    name: 'commit',
    steps: [
      { kind: 'command.run', id: 'status', command: 'git', args: ['status'] },
      { kind: 'service.start', id: 'commit', name: 'commit', command: 'git', args: UNVERIFIED },
    ],
  })
  check('Journey service.start behind another step: refused by the gate', gated(later), String(later).slice(0, 160))
  const monitor = await judged(MonitorTool, { command: 'git commit --no-verify -m "skip the hooks"', description: 'watch a commit' })
  check('Monitor: git commit --no-verify is refused by the gate', gated(monitor), String(monitor).slice(0, 160))
  const bare = await judged(ServiceTool, { op: 'start', name: 'commit', command: 'git', args: ['commit', '-m', 'no verify chained'] })
  check('Service start: a bare commit with no verification is refused as a Bash one is', gated(bare) && gated(await judged(BashTool, { command: 'git commit -m "no verify chained"' })), String(bare).slice(0, 160))
}

section('§3 what is no commit passes the gate')
{
  check('Service start: a test run passes', (await judged(ServiceTool, { op: 'start', name: 'tests', command: 'bun', args: ['test'] })) === null)
  check('Service logs: an operation that starts nothing passes', (await judged(ServiceTool, { op: 'logs', name: 'tests' })) === null)
  check('Journey run with no commit passes', (await judged(JourneyTool, { op: 'run', name: 'plain', steps: [{ kind: 'command.run', id: 'status', command: 'git', args: ['status'] }] })) === null)
  check('a tool that starts no command passes', (await judged(FileReadTool, { file_path: join(ROOT, 'a-file-that-is-read') })) === null)
  check('Service start: an echo passes', (await judged(ServiceTool, { op: 'start', name: 'echo', command: 'echo', args: ['hello there'] })) === null)
}

disengageCommitGate(SESSION)
deleteFlagEnv('MERCURY_COMMIT_GATE')
resetGuardsForTesting()
console.log('\n' + '='.repeat(60))
console.log(failures === 0 ? ` ✅ commit gate · started commands: ${checks} checks, 0 failures` : ` ❌ commit gate · started commands: ${failures} of ${checks} checks failed`)
process.exit(failures === 0 ? 0 : 1)
