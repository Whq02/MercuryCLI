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

type Run = { stdout: string; stderr: string; silent: boolean; error: string | null }

function powershell(): string {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

function request(way: 'protect' | 'unprotect', bytes: Buffer): string {
  return `${way}\n${bytes.toString('base64')}\n`
}

export function createDpapiProtector(timeoutMs: number = 10_000): SystemProtector {
  function answerOf(run: Run): ProtectorAnswer {
    const lines = run.stdout.replace(/^\uFEFF/, '').split(/\r?\n/)
    const ok = lines.find(line => /^ok [A-Za-z0-9+/]+={0,2}$/.test(line))
    if (ok !== undefined) return { ok: true, bytes: Buffer.from(ok.slice(3), 'base64') }
    const no = lines.find(line => line.startsWith('no '))
    const why = run.silent
      ? `PowerShell did not answer within ${timeoutMs} ms`
      : no !== undefined
        ? no.slice(3).trim()
        : run.stderr.trim().slice(-300) || run.error || 'PowerShell gave no answer'
    return { ok: false, why: `DPAPI through PowerShell: ${why}`, final: !run.silent }
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
      error: result.error === undefined ? null : `${code ?? 'the start failed'} at ${powershell()}`,
    }
  }

  function runAsync(input: string): Promise<Run> {
    return new Promise(resolve => {
      const child = execFile(
        powershell(),
        POWERSHELL_ARGS,
        { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, env: { ...subprocessEnv({ stripProviderCredentials: true }) } },
        (error, stdout, stderr) => {
          const failed = error as (Error & { code?: string | number; killed?: boolean }) | null
          resolve({
            stdout,
            stderr,
            silent: failed?.killed === true,
            error: failed === null ? null : `${typeof failed.code === 'string' ? failed.code : `exit ${String(failed.code ?? 'unknown')}`} at ${powershell()}`,
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
