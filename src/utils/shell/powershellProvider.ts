import { tmpdir } from 'node:os'
import { posix as posixPath } from 'node:path'
import { getSessionEnvVars } from '../sessionEnvVars.js'
import { getPowerShellEdition } from './powershellDetection.js'
import type { BuildExecCommandOptions, ShellProvider } from './shellProvider.js'

export function buildPowerShellArgs(command: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', command]
}

const PLAIN_RENDER_PRELUDE =
  "if ($null -ne (Get-Variable -Name PSStyle -ErrorAction SilentlyContinue)) { $PSStyle.OutputRendering = 'PlainText' }\n"

export const UTF8_OUTPUT_PRELUDE =
  "try { $PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'; $PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'; $PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch {}\n"

function cwdFileName(id: number | string): string {
  return `mercury-cwd-${id}`
}

function posixSingleQuote(text: string): string {
  return `'${text.split("'").join("'\\''")}'`
}

function buildTrailer(cwdFileInShell: string): string {
  const literal = cwdFileInShell.split("'").join("''")
  return [
    '',
    '; $mc = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }',
    `; [IO.File]::WriteAllText('${literal}', (Get-Location).Path, [Text.UTF8Encoding]::new($false))`,
    '; exit $mc',
  ].join('\n')
}

export function createPowerShellProvider(shellPath: string): ShellProvider {
  let pendingSandboxTmp: string | undefined
  let pendingUseSandbox = false

  return {
    type: 'powershell',
    shellPath,
    detached: false,

    async buildExecCommand(command: string, opts: BuildExecCommandOptions) {
      pendingUseSandbox = opts.useSandbox
      pendingSandboxTmp = opts.useSandbox ? opts.sandboxTmpDir : undefined

      const name = cwdFileName(opts.id)
      const cwdFileInShell =
        opts.useSandbox && opts.sandboxTmpDir
          ? posixPath.join(opts.sandboxTmpDir, name)
          : posixPath.join(tmpdir(), name)

      const assembled = PLAIN_RENDER_PRELUDE + UTF8_OUTPUT_PRELUDE + command + buildTrailer(cwdFileInShell)

      if (opts.useSandbox) {
        const encoded = Buffer.from(assembled, 'utf16le').toString('base64')
        const commandString = [
          posixSingleQuote(shellPath),
          '-NoProfile',
          '-NonInteractive',
          '-EncodedCommand',
          encoded,
        ].join(' ')
        return { commandString, cwdFilePath: cwdFileInShell }
      }

      return { commandString: assembled, cwdFilePath: cwdFileInShell }
    },

    getSpawnArgs(commandString: string): string[] {
      return buildPowerShellArgs(commandString)
    },

    async getEnvironmentOverrides(_command: string): Promise<Record<string, string>> {
      const overrides: Record<string, string> = {}
      for (const [key, value] of getSessionEnvVars()) overrides[key] = value
      if (pendingUseSandbox && pendingSandboxTmp) {
        overrides.TMPDIR = pendingSandboxTmp
        overrides.MERCURY_TMPDIR = pendingSandboxTmp
      }
      if (process.platform === 'win32') {
        overrides.MSYS2_ARG_CONV_EXCL = '*'
        overrides.MSYS_NO_PATHCONV = '1'
        if (process.env.PYTHONIOENCODING === undefined) {
          overrides.PYTHONIOENCODING = 'utf-8:replace'
        }
        if ((await getPowerShellEdition()) === 'desktop') {
          const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
          const systemRoot = process.env.SystemRoot || 'C:\\Windows'
          overrides.PSModulePath = [
            `${programFiles}\\WindowsPowerShell\\Modules`,
            `${systemRoot}\\system32\\WindowsPowerShell\\v1.0\\Modules`,
          ].join(';')
        }
      }
      return overrides
    },
  }
}
