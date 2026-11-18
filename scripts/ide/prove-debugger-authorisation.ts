#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

process.chdir(resolve(import.meta.dir, '..', '..'))
const t = checker()

const { adapterSilenceMessage, darwinDebuggerAuthorisationHint, _resetDarwinDebuggerAuthForTesting } = await import(
  '../../src/services/dap/dapClient.ts'
)

t.section('§1 adapterSilenceMessage — the OS is named, never guessed')
{
  _resetDarwinDebuggerAuthForTesting()
  t.check('a non-native adapter keeps the bare deadline', adapterSilenceMessage('adapter never sent initialized (10s)', 'python') === 'adapter never sent initialized (10s)')
  t.check('an unknown adapter keeps the bare deadline', adapterSilenceMessage('x', 'custom-thing') === 'x')
  const hint = darwinDebuggerAuthorisationHint()
  if (process.platform !== 'darwin') {
    t.check('off macOS there is never a hint', hint === null, String(hint))
    t.check('a native adapter keeps the bare deadline off macOS', adapterSilenceMessage('x', 'lldb') === 'x')
  } else {
    t.check(
      'on macOS the hint is null (authorised) or names the setting and the durable fix',
      hint === null || (hint.includes('DevToolsSecurity -status: disabled') && hint.includes('sudo DevToolsSecurity -enable')),
      String(hint),
    )
    const native = adapterSilenceMessage('adapter never sent initialized (10s)', 'lldb')
    t.check(
      'a native adapter carries exactly the live state',
      hint === null ? native === 'adapter never sent initialized (10s)' : native === `adapter never sent initialized (10s) — ${hint}`,
      native,
    )
    t.check('gdb is a native adapter too', adapterSilenceMessage('x', 'gdb') === (hint === null ? 'x' : `x — ${hint}`))
  }
  t.check('the read is memoised (a second call answers the same)', darwinDebuggerAuthorisationHint() === hint)
}

t.section('§2 the IDE plane row names the macOS authorisation state')
{
  const { codingLoopFastChecks } = await import('../../src/utils/health/sections/coding-loop-fast.ts')
  const plane = await codingLoopFastChecks().find(row => row.id === 'ide-plane-fast')?.run()
  const authorisation = darwinDebuggerAuthorisationHint()
  t.check('the row reads darwinDebuggerAuthorisationHint', plane !== undefined && (authorisation === null ? !/native debug/.test(`${plane.evidence}\n${plane.detail}`) : plane.detail?.includes(`native debug: ${authorisation}`) === true), plane?.detail)
  t.check('an off setting is named in the evidence and carries the fix', plane !== undefined && (authorisation === null ? !plane.evidence.includes('native debug authorisation OFF') : plane.status === 'warn' && plane.evidence.endsWith('native debug authorisation OFF') && (plane.fix === 'sudo DevToolsSecurity -enable (macOS debugger authorisation; durable across reboots).' || plane.fix === 'Install Python 3, or point MERCURY_PYTHON at one.')), plane?.evidence)
}

t.section('§3 the debugger doc')
{
  const doc = readFileSync('docs/DEBUGGER.md', 'utf8')
  t.check('DEBUGGER.md names task_for_pid, the per-boot grant and the fix', doc.includes('task_for_pid') && doc.includes('lasts one boot') && doc.includes('sudo DevToolsSecurity -enable'))
}

t.finish('prove-debugger-authorisation')
