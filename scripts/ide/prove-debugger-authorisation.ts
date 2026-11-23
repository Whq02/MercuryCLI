#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

process.chdir(resolve(import.meta.dir, '..', '..'))
const t = checker()

const { adapterSilenceMessage, darwinDebuggerAuthorisationHint, _resetDarwinDebuggerAuthForTesting } = await import(
  '../../src/integrations/debugger/dapClient.ts'
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

t.section('§2 the IDE plane row names the macOS authorisation state: both answers of the probe, handed in, on any host')
{
  const { codingLoopFastChecks, idePlaneFastCheck } = await import('../../src/platform/health/sections/coding-loop-fast.ts')
  const OFF = 'Developer mode is currently disabled.'
  const ON = 'Developer mode is currently enabled.'
  const hintOff = darwinDebuggerAuthorisationHint(() => OFF)
  t.check(
    "the hint is a function of the probe's answer: disabled names the setting and the durable fix; enabled, and no answer, give none",
    hintOff !== null && hintOff.includes('DevToolsSecurity -status: disabled') && hintOff.endsWith('sudo DevToolsSecurity -enable') && darwinDebuggerAuthorisationHint(() => ON) === null && darwinDebuggerAuthorisationHint(() => null) === null,
    String(hintOff),
  )
  const off = await idePlaneFastCheck(() => OFF).run()
  const on = await idePlaneFastCheck(() => ON).run()
  const pythonMissing = off.evidence.startsWith('python UNAVAILABLE')
  t.check("with the authorisation off the row warns, names it in the evidence and carries the owner's line in the detail", off.status === 'warn' && off.evidence.endsWith(' · native debug authorisation OFF') && off.detail?.includes(`native debug: ${hintOff}`) === true, `${off.status}: ${off.evidence} | ${off.detail}`)
  t.check(
    "with the authorisation off the fix is the command the owner's line ends on (on a host with no Python the row's fix is Python's, which comes first)",
    pythonMissing ? off.fix === 'Install Python 3, or point MERCURY_PYTHON at one.' : off.fix !== undefined && off.fix.startsWith('sudo DevToolsSecurity -enable ') && !off.fix.includes('-disable'),
    String(off.fix),
  )
  t.check('with the authorisation on the row says nothing of native debug and carries no fix for it', !/native debug|DevToolsSecurity/.test(`${on.evidence}\n${on.detail}\n${on.fix ?? ''}`), `${on.evidence} | ${on.detail} | ${on.fix}`)
  t.check("the list runs that row once, with the machine's own probe", codingLoopFastChecks().filter(row => row.id === 'ide-plane-fast').length === 1)
  const PYTHON_FIX = 'Install Python 3, or point MERCURY_PYTHON at one.'
  const empty = mkdtempSync(join(tmpdir(), 'no-python-on-path-'))
  const names = ['PATH', 'MERCURY_PYTHON', 'VIRTUAL_ENV', 'CONDA_PREFIX'] as const
  const before = names.map(name => [name, process.env[name]] as const)
  for (const name of names) delete process.env[name]
  process.env.PATH = empty
  const bareOff = await idePlaneFastCheck(() => OFF).run()
  const bareOn = await idePlaneFastCheck(() => ON).run()
  for (const [name, value] of before) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(empty, { recursive: true, force: true })
  t.check(
    "on a host with no Python (a PATH that holds none, no pin, no environment) and the authorisation off, the row names both: Python unavailable first, the authorisation in the evidence and the owner's line in the detail, and the fix is Python's",
    bareOff.status === 'warn' && bareOff.evidence.startsWith('python UNAVAILABLE (') && bareOff.evidence.endsWith(' · native debug authorisation OFF') && bareOff.detail?.includes(`native debug: ${hintOff}`) === true && bareOff.fix === PYTHON_FIX,
    `${bareOff.status}: ${bareOff.evidence} | ${bareOff.fix}`,
  )
  t.check(
    "on that host with the authorisation on, the row names Python alone and its fix is Python's",
    bareOn.evidence.startsWith('python UNAVAILABLE (') && !/native debug|DevToolsSecurity/.test(`${bareOn.evidence}\n${bareOn.detail}\n${bareOn.fix ?? ''}`) && bareOn.fix === PYTHON_FIX,
    `${bareOn.status}: ${bareOn.evidence} | ${bareOn.fix}`,
  )
}

t.finish('prove-debugger-authorisation')
