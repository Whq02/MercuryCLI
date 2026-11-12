import { execFile, spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { subprocessEnv } from '../subprocessEnv.js'
import type { ProtectorAnswer, SystemProtector } from './types.js'

const DPAPI_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  Add-Type -AssemblyName System.Security
  $way = [Console]::ReadLine()
  $text = [Console]::ReadLine()
  if ($null -eq $way) {
    $lines = @($input)
    $way = $lines[0]
    $text = $lines[1]
  }
  $bytes = [Convert]::FromBase64String($text)
  $scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  if ($way -eq 'protect') {
    $out = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, $scope)
  } elseif ($way -eq 'unprotect') {
    $out = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, $scope)
  } else {
    throw 'the request names neither protect nor unprotect'
  }
  [Console]::WriteLine('ok ' + [Convert]::ToBase64String($out))
} catch {
  $e = $_.Exception
  if ($e.InnerException) { $e = $e.InnerException }
  [Console]::WriteLine('no ' + $e.GetType().FullName + ' ' + ('0x{0:X8}' -f $e.HResult) + ': ' + ($e.Message -replace '\s+', ' '))
}
`

const POWERSHELL_ARGS = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(DPAPI_SCRIPT, 'utf16le').toString('base64')]

type Run = { stdout: string; stderr: string; silent: boolean; ended: number | null; error: string | null }

function powershell(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function request(way: 'protect' | 'unprotect', bytes: Buffer): string {
  return `${way}\n${bytes.toString('base64')}\n`
}

export function createDpapiProtector(timeoutMs: number = 10_000): SystemProtector {
  function answerOf(run: Run): ProtectorAnswer {
    const refusal = (why: string, final: boolean): ProtectorAnswer => ({ ok: false, why: `DPAPI through PowerShell: ${why}`, final })
    if (run.silent) return refusal(`PowerShell did not answer within ${timeoutMs} ms`, false)
    const lines = run.stdout.replace(/^\uFEFF/, '').replace(/\r?\n$/, '').split(/\r?\n/)
    const said = lines.find(line => line.startsWith('no '))?.slice(3).trim()
    if (run.ended !== 0) return refusal(said ?? (run.stderr.trim().slice(-300) || run.error || 'PowerShell did not end cleanly'), true)
    if (lines.length !== 1) return refusal(said ?? 'PowerShell wrote something that is not one answer', true)
    if (said !== undefined) return refusal(said, true)
    const only = lines[0] ?? ''
    if (!/^ok [A-Za-z0-9+/]+={0,2}$/.test(only)) return refusal('PowerShell gave no answer', true)
    return { ok: true, bytes: Buffer.from(only.slice(3), 'base64') }
  }

  function run(input: string): Run {
    const result = spawnSync(powershell(), POWERSHELL_ARGS, {
      input,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...subprocessEnv({ stripProviderCredentials: true }) },
    })
    const code = (result.error as NodeJS.ErrnoException | undefined)?.code
    return {
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      silent: code === 'ETIMEDOUT',
      ended: result.error === undefined ? result.status : null,
      error: result.error !== undefined ? `${code ?? 'the start failed'} at ${powershell()}` : result.status === 0 ? null : `PowerShell ended with ${result.status === null ? String(result.signal) : `exit ${result.status}`}`,
    }
  }

  function runAsync(input: string): Promise<Run> {
    return new Promise(resolve => {
      const child = execFile(
        powershell(),
        POWERSHELL_ARGS,
        { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, env: { ...subprocessEnv({ stripProviderCredentials: true }) } },
        (error, stdout, stderr) => {
          const failed = error as (Error & { code?: string | number; killed?: boolean; signal?: string }) | null
          resolve({
            stdout,
            stderr,
            silent: failed?.killed === true,
            ended: failed === null ? 0 : typeof failed.code === 'number' ? failed.code : null,
            error: failed === null ? null : typeof failed.code === 'string' ? `${failed.code} at ${powershell()}` : `PowerShell ended with ${typeof failed.code === 'number' ? `exit ${failed.code}` : String(failed.signal ?? 'no exit status')}`,
          })
        },
      )
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
    })
  }

  return {
    scheme: 'dpapi-user',

    protect(secret: Buffer): ProtectorAnswer {
      return answerOf(run(request('protect', secret)))
    },

    unprotect(token: Buffer): ProtectorAnswer {
      return answerOf(run(request('unprotect', token)))
    },

    async protectAsync(secret: Buffer): Promise<ProtectorAnswer> {
      return answerOf(await runAsync(request('protect', secret)))
    },

    async unprotectAsync(token: Buffer): Promise<ProtectorAnswer> {
      return answerOf(await runAsync(request('unprotect', token)))
    },
  }
}
