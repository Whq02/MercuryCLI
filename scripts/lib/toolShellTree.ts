import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

export const SHELL_PID_COMMAND = process.platform === 'win32'
  ? "cat /proc/$$/winpid 2>/dev/null || ps -p $$ | awk 'NR == 2 { print $4 }'"
  : 'echo $$'

export type ShellTreeRow = { pid: number; ppid: number; name: string }

function parseRows(text: string): ShellTreeRow[] {
  const rows: ShellTreeRow[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line)
    if (!match) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), name: match[3]! })
  }
  return rows
}

export function shellTreeRows(root: number): ShellTreeRow[] {
  if (!Number.isInteger(root) || root <= 1) return []
  if (process.platform === 'win32') {
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const script = `Get-CimInstance Win32_Process -Filter 'ProcessId = ${root} OR ParentProcessId = ${root}' | ForEach-Object { ($_.ProcessId, $_.ParentProcessId, $_.Name) -join ' ' }`
    const encoded = Buffer.from(script, 'utf16le').toString('base64')
    const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    return parseRows(result.stdout ?? '')
  }
  const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,stat=,comm='], { encoding: 'utf8' })
  const rows: ShellTreeRow[] = []
  for (const line of (result.stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)/.exec(line)
    if (!match || match[3]!.startsWith('Z')) continue
    const row = { pid: Number(match[1]), ppid: Number(match[2]), name: match[4]! }
    if (row.pid === root || row.ppid === root) rows.push(row)
  }
  return rows
}

export function shellTreeWords(rows: readonly ShellTreeRow[]): string {
  return rows.map(row => `${row.pid} ${row.name} (parent ${row.ppid})`).join(', ')
}
