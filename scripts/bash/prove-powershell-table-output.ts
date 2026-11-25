#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const { spawnSync } = await import('node:child_process')
const { readFileSync, rmSync } = await import('node:fs')
const { createPowerShellProvider } = await import('../../src/platform/shell/powershellProvider.js')

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passed++
  else failed++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

console.log('============================================================')
console.log(' PowerShell tool — a formatted table survives the trailer')
console.log('============================================================')

const candidates = process.platform === 'win32' ? ['pwsh', 'powershell'] : ['pwsh']
const shells = candidates.filter(exe => {
  const probe = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf-8', windowsHide: true, timeout: 30000 })
  return !probe.error && probe.status === 0
})
if (shells.length === 0) console.log('  [SKIP] no PowerShell on this machine')

const cases: Array<{ command: string; code: number; shows: string[] }> = [
  { command: 'Get-Location', code: 0, shows: ['Path', '----'] },
  { command: "Get-Location; 'after the table'", code: 0, shows: ['Path', 'after the table'] },
  { command: "'before the table'; Get-Location", code: 0, shows: ['before the table', 'Path'] },
  { command: "[pscustomobject]@{ alpha = 'first'; beta = 'second' }", code: 0, shows: ['alpha', 'first', 'second'] },
  { command: "Write-Output 'plain words'", code: 0, shows: ['plain words'] },
  { command: '$LASTEXITCODE = 3', code: 3, shows: [] },
  { command: "Write-Error 'boom'", code: 1, shows: [] },
]

let id = 0
for (const exe of shells) {
  const provider = createPowerShellProvider(exe)
  for (const { command, code, shows } of cases) {
    id++
    const built = await provider.buildExecCommand(command, { id: `table-output-${process.pid}-${id}` })
    const run = spawnSync(exe, provider.getSpawnArgs(built.commandString), { encoding: 'utf-8', windowsHide: true, timeout: 60000 })
    const stdout = run.stdout ?? ''
    const missing = shows.filter(text => !stdout.includes(text))
    check(
      `${exe}: ${command} prints what it answers and exits ${code}`,
      !run.error && run.status === code && missing.length === 0,
      `status=${run.status} missing=${JSON.stringify(missing)} stdout=${JSON.stringify(stdout.slice(0, 200))} — end the trailer in src/platform/shell/powershellProvider.ts without cutting the formatter's held output`,
    )
    let cwd = ''
    try {
      cwd = readFileSync(built.cwdFilePath, 'utf-8')
      rmSync(built.cwdFilePath, { force: true })
    } catch {
      cwd = ''
    }
    check(`${exe}: ${command} still writes the working directory`, cwd.length > 0, `cwdFilePath=${built.cwdFilePath}`)
  }
}

console.log(`\npowershell-table-output: ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
export {}
