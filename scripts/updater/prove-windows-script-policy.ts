import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as layout from '../../src/services/privateChannel/installLayout.ts'

const seams = layout as unknown as {
  windowsScriptPolicyNotice?: (readings: Array<{ shell: string; effective: string; scopes: Array<{ scope: string; policy: string }> }>) => string[]
}
let failures = 0
const check = (label: string, ok: boolean, detail: unknown = ''): void => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` — ${JSON.stringify(detail)}`}`)
}
const reading = (effective: string, scope = 'LocalMachine', shell = 'Windows PowerShell') => ({ shell, effective, scopes: [{ scope, policy: effective }] })
const notice = (readings: ReturnType<typeof reading>[]) => seams.windowsScriptPolicyNotice?.(readings) ?? []
const fix = 'Set-ExecutionPolicy -Scope CurrentUser RemoteSigned'
const restricted = notice([reading('Restricted')])
check('a blocked policy has three short lines', restricted.length === 3 && restricted.every(line => line.length < 190), restricted)
check('the note names the blocked entry', restricted[0]?.includes('mercury.ps1') === true && restricted[0]?.includes('Restricted') === true, restricted)
check('the one-line fix is offered, not executed', restricted[1]?.includes(fix) === true, restricted)
check('the working cmd entry is named', restricted[2]?.includes('mercury.cmd') === true, restricted)
check('AllSigned warns for the unsigned generated entry', notice([reading('AllSigned')]).length === 3)
for (const effective of ['RemoteSigned', 'Unrestricted', 'Bypass']) check(`${effective} does not invent a block`, notice([reading(effective)]).length === 0)
check('an unavailable reading is not a guessed block', notice([]).length === 0)
check('the effective default, not Undefined scope rows, decides', notice([{ shell: 'Windows PowerShell', effective: 'Restricted', scopes: [{ scope: 'LocalMachine', policy: 'Undefined' }] }]).length === 3)
for (const scope of ['MachinePolicy', 'UserPolicy', 'Process']) {
  const lines = notice([reading('Restricted', scope)])
  check(`${scope} precedence is disclosed beside the offered fix`, lines.length === 3 && lines[1]?.includes(fix) === true && lines[2]?.includes(scope) === true && lines[2]?.includes('mercury.cmd') === true, lines)
}
const two = notice([reading('Restricted', 'CurrentUser', 'PowerShell 7'), reading('Restricted')])
check('both Windows shells are named in one notice', two.length === 3 && two[0]?.includes('PowerShell 7') === true && two[0]?.includes('Windows PowerShell') === true, two)
const scratch = mkdtempSync(join(tmpdir(), 'script-policy-'))
try {
  const notes: string[][] = []
  let reads = 0
  const roots = { versionsDir: join(scratch, 'versions'), binDir: scratch, shimPath: join(scratch, 'mercury.cmd'), isWindows: true }
  const options = { readScriptPolicies: () => { reads++; return [reading('Restricted')] }, onNotice: (lines: string[]) => notes.push(lines) }
  const first = layout.writeShimSet(roots, options as never)
  check('layout publication reads the stubbed real-policy branch and prints its notice', first.complete && reads === 1 && notes.length === 1 && JSON.stringify(notes[0]) === JSON.stringify(restricted), { reads, notes })
  writeFileSync(join(scratch, 'foreign-tool.ps1'), 'operator content')
  layout.writeShimSet(roots, options as never)
  check('already-current entries do not repeat the setup notice', reads === 1 && notes.length === 1, { reads, notices: notes.length })
  check('foreign non-member scripts stay untouched', readFileSync(join(scratch, 'foreign-tool.ps1'), 'utf8') === 'operator content')
  layout.writeShimSet({ ...roots, isWindows: false, shimPath: join(scratch, 'mercury') }, options as never)
  check('non-Windows publication never queries Windows policy', reads === 1, reads)
} finally { rmSync(scratch, { recursive: true, force: true }) }
console.log(`${failures ? 'FAIL' : 'PASS'} windows-script-policy: ${failures} failures`)
process.exit(failures ? 1 : 0)
