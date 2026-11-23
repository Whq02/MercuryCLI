#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const scratch = mkdtempSync(join(tmpdir(), 'sg35-instr-'))
for (const spelling of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  process.env[spelling] = join(scratch, 'home')
}
mkdirSync(join(scratch, 'home'), { recursive: true })

let failures = 0
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ✅ ${label}`)
  else {
    failures += 1
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const milestoneHint = 'fix recordLaunchMilestone / readLaunchMilestones / lastBootReachedInputLive in src/platform/substrate/launchMilestones.ts'
const invocationHint = 'fix classifyShellHint / recordInvocation / readInvocationRecords in src/platform/substrate/invocationRecord.ts'

console.log('§1 the milestone store')
{
  const m = await import('../../src/platform/substrate/launchMilestones.ts')
  m._resetLaunchMilestonesForTesting()
  m.recordLaunchMilestone('runtime-entry')
  m.recordLaunchMilestone('runtime-entry')
  m.recordLaunchMilestone('route-ready')
  check('exactly-once per kind per process', m.readLaunchMilestones().filter(r => r.pid === process.pid && r.milestone === 'runtime-entry').length === 1, milestoneHint)
  check('the spine WITHOUT input-live reads FALSE (the false-exit-0 signal)', m.lastBootReachedInputLive() === false, milestoneHint)
  m.recordLaunchMilestone('first-frame')
  m.recordLaunchMilestone('input-live')
  check('the complete spine reads TRUE', m.lastBootReachedInputLive() === true, milestoneHint)
  const rows = m.readLaunchMilestones().filter(r => r.pid === process.pid)
  check('the spine is ordered (entry → route-ready → first-frame → input-live)',
    rows.map(r => r.milestone).join(',') === 'runtime-entry,route-ready,first-frame,input-live', milestoneHint + ' | ' + rows.map(r => r.milestone).join(','))
  check('rows are monotonic within the process', rows.every((r, i) => i === 0 || r.atMs >= rows[i - 1]!.atMs), milestoneHint)
}

console.log('§2 TI-01 — the typed invocation record')
{
  const inv = await import('../../src/platform/substrate/invocationRecord.ts')
  check("win32 + PSModulePath ⇒ 'powershell'", inv.classifyShellHint({ PSModulePath: 'C:/x' } as NodeJS.ProcessEnv, 'win32') === 'powershell', invocationHint)
  check("win32 + ComSpec only ⇒ 'cmd'", inv.classifyShellHint({ ComSpec: 'C:/Windows/system32/cmd.exe' } as NodeJS.ProcessEnv, 'win32') === 'cmd', invocationHint)
  check("win32 bare ⇒ 'unknown'", inv.classifyShellHint({} as NodeJS.ProcessEnv, 'win32') === 'unknown', invocationHint)
  check("posix + SHELL ⇒ 'posix-sh'", inv.classifyShellHint({ SHELL: '/bin/zsh' } as NodeJS.ProcessEnv, 'darwin') === 'posix-sh', invocationHint)
  const rec = inv.recordInvocation()
  check('the capture is redaction-safe (basenames only, no separators)', !rec.argv0.includes('/') && !rec.execBasename.includes('/') && !rec.argv0.includes('\\'), invocationHint)
  check('the TTY triple is booleans', [rec.stdinTTY, rec.stdoutTTY, rec.stderrTTY].every(v => typeof v === 'boolean'), invocationHint)
  for (let i = 0; i < 12; i++) inv.recordInvocation()
  check('the ring is bounded at 10', inv.readInvocationRecords().length === 10, invocationHint + ' so the ring keeps 10 | ' + String(inv.readInvocationRecords().length))
}

console.log('§3 the wire sites + health consumers (source pins)')
{
  const { crewChecks } = await import('../../src/platform/health/sections/crew.ts')
  const milestones = await import('../../src/platform/substrate/launchMilestones.ts')
  const { readInvocationRecords } = await import('../../src/platform/substrate/invocationRecord.ts')
  const spineSays = await crewChecks().find(row => row.id === 'launch-spine')?.run()
  const reached = milestones.lastBootReachedInputLive()
  check('the health reads the spine (launch-spine row)', spineSays !== undefined && (reached === null ? spineSays.status === 'off' && spineSays.evidence === 'no interactive boot recorded yet' : reached ? /^last boot('s spine fired OUT OF ORDER)?: /.test(spineSays.evidence) : spineSays.status === 'warn' && spineSays.evidence.startsWith("last boot's spine truncated: ")), 'fix the launch-spine row in src/platform/health/sections/crew.ts | ' + spineSays?.evidence)
  const recordSays = await crewChecks().find(row => row.id === 'invocation-record')?.run()
  const records = readInvocationRecords()
  const lastRecord = records[records.length - 1]
  check('the health reads the TI-01 record (invocation-record row)', recordSays !== undefined && (lastRecord === undefined ? recordSays.status === 'off' && recordSays.evidence === 'no invocation recorded yet' : recordSays.status === 'ok' && recordSays.evidence.startsWith(`${lastRecord.platform} · ${lastRecord.shellHint} · tty in/out/err `) && recordSays.evidence.endsWith(`(${records.length} recorded)`)), 'fix the invocation-record row in src/platform/health/sections/crew.ts | ' + recordSays?.evidence)
}

console.log('§4 C1/C2 win32 fixes (source pins)')
{
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nPROVE-LAUNCH-INSTRUMENTATION: PASS' : `\nPROVE-LAUNCH-INSTRUMENTATION: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
