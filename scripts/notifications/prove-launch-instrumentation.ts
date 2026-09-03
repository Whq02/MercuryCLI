#!/usr/bin/env bun
// ============================================================================
//  prove-launch-instrumentation — (the typed invocation record ·
//  milestones · the C1/C2 win32 fixes).
//
//  §1 the milestone store: exactly-once per kind per process · bounded FIFO
//     · the spine truth (a boot without input-live reads FALSE — the
//     false-exit-0 signal) · launchId keying when the env carried one.
//  §2 TI-01: the typed capture (redaction-safe basenames, TTY triple) + the
//     closed shell classification table + the bounded ring.
//  §3 the wire sites (source pins, the house idiom): runtime-entry +
//     recordInvocation at the interactive-startup fact · route-ready at the
//     resolver settle · first-frame at the App root mount · input-live at
//     signalInputLive · BOTH doctor rows consume the stores.
//  §4 C1/C2 (source pins): the prompt editor spawns through the canonical
//     legacy parser with a quoted executable; render_tui uses
//     tmpdir()/homedir() and surfaces the spawn error.
// ============================================================================

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
const REPO = join(import.meta.dir, '../../')
const src = (p: string) => readFileSync(join(REPO, p), 'utf8')

console.log('§1 the milestone store')
{
  const m = await import('../../src/substrate/launchMilestones.ts')
  m._resetLaunchMilestonesForTesting()
  m.recordLaunchMilestone('runtime-entry')
  m.recordLaunchMilestone('runtime-entry') // once per kind per process
  m.recordLaunchMilestone('route-ready')
  check('exactly-once per kind per process', m.readLaunchMilestones().filter(r => r.pid === process.pid && r.milestone === 'runtime-entry').length === 1)
  check('the spine WITHOUT input-live reads FALSE (the false-exit-0 signal)', m.lastBootReachedInputLive() === false)
  m.recordLaunchMilestone('first-frame')
  m.recordLaunchMilestone('input-live')
  check('the complete spine reads TRUE', m.lastBootReachedInputLive() === true)
  const rows = m.readLaunchMilestones().filter(r => r.pid === process.pid)
  check('the spine is ordered (entry → route-ready → first-frame → input-live)',
    rows.map(r => r.milestone).join(',') === 'runtime-entry,route-ready,first-frame,input-live', rows.map(r => r.milestone).join(','))
  check('rows are monotonic within the process', rows.every((r, i) => i === 0 || r.atMs >= rows[i - 1]!.atMs))
}

console.log('§2 TI-01 — the typed invocation record')
{
  const inv = await import('../../src/substrate/invocationRecord.ts')
  check("win32 + PSModulePath ⇒ 'powershell'", inv.classifyShellHint({ PSModulePath: 'C:/x' } as NodeJS.ProcessEnv, 'win32') === 'powershell')
  check("win32 + ComSpec only ⇒ 'cmd'", inv.classifyShellHint({ ComSpec: 'C:/Windows/system32/cmd.exe' } as NodeJS.ProcessEnv, 'win32') === 'cmd')
  check("win32 bare ⇒ 'unknown'", inv.classifyShellHint({} as NodeJS.ProcessEnv, 'win32') === 'unknown')
  check("posix + SHELL ⇒ 'posix-sh'", inv.classifyShellHint({ SHELL: '/bin/zsh' } as NodeJS.ProcessEnv, 'darwin') === 'posix-sh')
  const rec = inv.recordInvocation()
  check('the capture is redaction-safe (basenames only, no separators)', !rec.argv0.includes('/') && !rec.execBasename.includes('/') && !rec.argv0.includes('\\'))
  check('the TTY triple is booleans', [rec.stdinTTY, rec.stdoutTTY, rec.stderrTTY].every(v => typeof v === 'boolean'))
  for (let i = 0; i < 12; i++) inv.recordInvocation()
  check('the ring is bounded at 10', inv.readInvocationRecords().length === 10, String(inv.readInvocationRecords().length))
}

console.log('§3 the wire sites + doctor consumers (source pins)')
{
  const main = src('src/main.tsx')
  // runtime-entry stamps at the action's ENTRY (ahead of the setup screens
  // that arm raw mode, so the spine never prints in reverse); the invocation
  // record keeps its settled home beside the beacon clear.
  check('runtime-entry stamps at the action entry', /recordLaunchMilestone\('runtime-entry'\)/.test(main))
  check('the invocation record lands at the interactive-startup fact (beside the beacon clear)',
    /clearBootAttempts\(\);?[\s\S]{0,700}recordInvocation\(\);?/.test(main))
  const route = src('src/context/surfaceRoute.ts')
  check('route-ready records at the resolver settle (every exit)', /const settle = \([\s\S]{0,400}recordLaunchMilestone\('route-ready'\)/.test(route))
  const app = src('src/ink/components/App.tsx')
  check('first-frame records at the App root mount (after the first committed write)', /componentDidMount\(\) \{[\s\S]{0,900}recordLaunchMilestone\('first-frame'\)/.test(app))
  const graph = src('src/boot/launchGraph.ts')
  check('input-live records at signalInputLive', /signalInputLive\(\): void \{[\s\S]{0,500}recordLaunchMilestone\('input-live'\)/.test(graph))
  const doctor = src('src/utils/healthReport.ts')
  check('the doctor reads the spine (launch-spine row)', doctor.includes("id: 'launch-spine'") && doctor.includes('lastBootReachedInputLive'))
  check('the doctor reads the TI-01 record (invocation-record row)', doctor.includes("id: 'invocation-record'") && doctor.includes('readInvocationRecords'))
}

console.log('§4 C1/C2 win32 fixes (source pins)')
{
  const pe = src('src/utils/promptEditor.ts')
  check('C1: the editor spawn parses with the canonical legacy parser and quotes the executable',
    pe.includes('parseLegacyCommandString(editorCommand)') && pe.includes('`"${editorExe}"'))
  const rt = src('src/services/mcp/renderTuiTool.ts')
  check('C2: render_tui writes under tmpdir() and resolves bun under homedir()',
    rt.includes('join(tmpdir(), `render-tui-mcp-') && rt.includes("join(homedir(), '.bun/bin/bun')"))
  check('C2: the spawn error surfaces (never a bare no-PNG)', rt.includes('res.error') && rt.includes('res.error ? String(res.error)'))
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures === 0 ? '\nPROVE-LAUNCH-INSTRUMENTATION: PASS' : `\nPROVE-LAUNCH-INSTRUMENTATION: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
