import { readFileSync } from 'node:fs'

import { execFileNoThrow } from './execFileNoThrow.js'


export function isProcessRunning(pid: number): boolean {
  if (pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function procStartToken(pid: number): string | undefined {
  if (process.platform !== 'linux') return undefined
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const closeParen = stat.lastIndexOf(')')
    if (closeParen === -1) return undefined
    const tail = stat.slice(closeParen + 2).split(' ')
    const token = tail[19]
    return token && token.length > 0 ? token : undefined
  } catch {
    return undefined
  }
}

export function currentProcStart(): string | undefined {
  return procStartToken(process.pid)
}

const ANCESTOR_TIMEOUT_MS = 3000

export async function getAncestorPidsAsync(pid: number, maxDepth: number = 10): Promise<number[]> {
  let result
  if (process.platform === 'win32') {
    const script = `$p=${pid};$out=@();for($i=0;$i -lt ${maxDepth};$i++){$proc=Get-CimInstance Win32_Process -Filter "ProcessId=$p" -ErrorAction SilentlyContinue;if(-not $proc){break};$pp=$proc.ParentProcessId;if(-not $pp -or $pp -eq 0){break};$out+=$pp;$p=$pp};$out -join ','`
    result = await execFileNoThrow('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: ANCESTOR_TIMEOUT_MS,
      preserveOutputOnError: false,
    })
  } else {
    const script = `p=${pid}; i=0; while [ $i -lt ${maxDepth} ]; do pp=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' '); if [ -z "$pp" ] || [ "$pp" = "0" ] || [ "$pp" = "1" ]; then break; fi; echo "$pp"; p=$pp; i=$((i+1)); done`
    result = await execFileNoThrow('sh', ['-c', script], {
      timeout: ANCESTOR_TIMEOUT_MS,
      preserveOutputOnError: false,
    })
  }
  if (result.code !== 0 || result.stdout.trim() === '') return []
  return result.stdout
    .split(/[\n,]/)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0)
    .map(entry => Number(entry))
    .filter(entry => Number.isInteger(entry))
}
