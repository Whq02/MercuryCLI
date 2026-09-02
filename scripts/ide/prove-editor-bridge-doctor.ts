#!/usr/bin/env bun
// ============================================================================
//  scripts/ide/prove-editor-bridge-doctor.ts — PROOF: the doctor's editor
//  rows and the macOS debugger-authorisation hint.
//
//    §1 adapterSilenceMessage — a non-native adapter keeps the bare
//       deadline; a native adapter on macOS carries the live authorisation
//       hint when the OS setting is off (the one durable fix named), and
//       the bare deadline when it is on; never a hint off macOS. The read
//       is memoised.
//    §2 the doctor 'editor-bridge' fast row (structural, the probe-parity
//       idiom of prove-ide-status): it reads the extension directories, the
//       advertisement discovery, the terminal identity and the advertised
//       port — the same owners the /ide command runs — and its fix names
//       the one command.
//    §3 the doctor 'ide-plane-fast' row names the macOS authorisation
//       state beside the native lane and carries the fix.
//    §4 the debugger doc carries the same paragraph.
//
//  Run:  ~/.bun/bin/bun run scripts/ide/prove-editor-bridge-doctor.ts
// ============================================================================
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

t.section('§2 the doctor editor-bridge row (probe parity)')
{
  const src = readFileSync('src/utils/healthReport.ts', 'utf8')
  const at = src.indexOf("id: 'editor-bridge'")
  t.check("doctor carries the 'editor-bridge' fast row", at !== -1)
  const row = src.slice(at, at + 3500)
  for (const owner of ['installedEditorExtensions', 'detectIDEs(true)', 'isSupportedTerminal()', "flagEnv('MERCURY_IDE_PORT')", 'getTerminalIdeType()']) {
    t.check(`the row reads ${owner} (the /ide command\'s own owners)`, row.includes(owner))
  }
  t.check('absence is named honestly (extension · advertising · terminal)', row.includes('extension NOT installed') && row.includes('no editor advertising a bridge') && row.includes('not an editor terminal'))
  t.check('the fix names the one command', row.includes('mercury editor install'))
  t.check('the row never fails the certificate on absence (info, not fail)', !row.includes("'fail'") && row.includes("'info' as const"))
}

t.section('§3 the IDE plane row names the macOS authorisation state')
{
  const src = readFileSync('src/utils/healthReport.ts', 'utf8')
  const at = src.indexOf("id: 'ide-plane-fast'")
  const row = src.slice(at, at + 4000)
  t.check('the row reads darwinDebuggerAuthorisationHint', row.includes('darwinDebuggerAuthorisationHint()'))
  t.check('an off setting is named in the evidence and carries the fix', row.includes('native debug authorisation OFF') && row.includes('sudo DevToolsSecurity -enable'))
}

t.section('§4 the debugger doc')
{
  const doc = readFileSync('docs/DEBUGGER.md', 'utf8')
  t.check('DEBUGGER.md names task_for_pid, the per-boot grant and the fix', doc.includes('task_for_pid') && doc.includes('lasts one boot') && doc.includes('sudo DevToolsSecurity -enable'))
}

t.finish('prove-editor-bridge-doctor')
