/**
 * PowerShell implementation of the shell-provider contract. Mercury-original
 * parts: the product-prefixed cwd-tracking file name, the Windows-estate MSYS
 * argument-conversion suppression, and the session-env ordering correction.
 */
import { tmpdir } from 'node:os'
import { posix as posixPath } from 'node:path'
import { getSessionEnvVars } from '../sessionEnvVars.js'
import { getPowerShellEdition } from './powershellDetection.js'
import type { BuildExecCommandOptions, ShellProvider } from './shellProvider.js'

/** The shared PowerShell invocation flags (contract data, this order). */
export function buildPowerShellArgs(command: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', command]
}

/**
 * PowerShell 7 styles error records with raw ANSI even when stdio is a
 * pipe, and the harness captures pipes verbatim — so rendering is pinned to
 * plain text ahead of the user command. Windows PowerShell 5.1 has no
 * $PSStyle; the Get-Variable guard keeps the prelude a silent no-op there.
 */
const PLAIN_RENDER_PRELUDE =
  "if ($null -ne (Get-Variable -Name PSStyle -ErrorAction SilentlyContinue)) { $PSStyle.OutputRendering = 'PlainText' }\n"

/**
 * UTF-8 on the way out (sweep #2, packet 72): Windows PowerShell
 * 5.1 redirects `>`/`>>` through Out-File's default encoding — UTF-16LE —
 * and writes `Set-Content`/`Add-Content` in the ANSI code page, so a file
 * the model just produced is unreadable as UTF-8 by every other tool
 * (git, grep, Python, the harness's own readers). The prelude pins the
 * session's default file encodings and the console's output encoding to
 * UTF-8 for every command. PowerShell 7 already defaults to utf8NoBOM;
 * the pins are harmless there. Errors are silenced: a host where a
 * preference cannot be set must still run the command.
 */
export const UTF8_OUTPUT_PRELUDE =
  "try { $PSDefaultParameterValues['Out-File:Encoding'] = 'utf8'; $PSDefaultParameterValues['Set-Content:Encoding'] = 'utf8'; $PSDefaultParameterValues['Add-Content:Encoding'] = 'utf8'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false) } catch {}\n"

/** The product-prefixed cwd-tracking file name. */
function cwdFileName(id: number | string): string {
  return `mercury-cwd-${id}`
}

/** POSIX single-quote a path (embedded single quotes escaped). */
function posixSingleQuote(text: string): string {
  return `'${text.split("'").join("'\\''")}'`
}

/**
 * The working-directory / exit-code trailer. Each statement starts on its own
 * line with an explicit separator so a trailing line comment cannot swallow it.
 * The cwd path is a PowerShell single-quoted literal (embedded quotes doubled).
 */
function buildTrailer(cwdFileInShell: string): string {
  const literal = cwdFileInShell.split("'").join("''")
  return [
    '',
    '; $mc = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }',
    `; [IO.File]::WriteAllText('${literal}', (Get-Location).Path, [Text.UTF8Encoding]::new($false))`,
    '; exit $mc',
  ].join('\n')
}

/** Create a PowerShell shell provider (synchronous). */
export function createPowerShellProvider(shellPath: string): ShellProvider {
  let pendingSandboxTmp: string | undefined
  let pendingUseSandbox = false

  return {
    type: 'powershell',
    shellPath,
    detached: false, // PowerShell is not detached

    async buildExecCommand(command: string, opts: BuildExecCommandOptions) {
      pendingUseSandbox = opts.useSandbox
      pendingSandboxTmp = opts.useSandbox ? opts.sandboxTmpDir : undefined

      const name = cwdFileName(opts.id)
      // Sandboxed: the file lives in the sandbox temp dir (POSIX-joined);
      // otherwise the OS temp dir (natively). Same file name either way.
      const cwdFileInShell =
        opts.useSandbox && opts.sandboxTmpDir
          ? posixPath.join(opts.sandboxTmpDir, name)
          : posixPath.join(tmpdir(), name)

      const assembled = PLAIN_RENDER_PRELUDE + UTF8_OUTPUT_PRELUDE + command + buildTrailer(cwdFileInShell)

      if (opts.useSandbox) {
        // The sandbox runtime hardcodes `<innerShell> -c '<cmd>'`, so the
        // returned string must itself be a complete PowerShell invocation
        // using -EncodedCommand (base64 of UTF-16LE — no quoting layer can
        // corrupt the base64 alphabet).
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

      // Unsandboxed: the bare command; flags are added by getSpawnArgs.
      return { commandString: assembled, cwdFilePath: cwdFileInShell }
    },

    getSpawnArgs(commandString: string): string[] {
      return buildPowerShellArgs(commandString)
    },

    async getEnvironmentOverrides(_command: string): Promise<Record<string, string>> {
      const overrides: Record<string, string> = {}
      // 1. Session env vars FIRST (before the sandbox temp override).
      for (const [key, value] of getSessionEnvVars()) overrides[key] = value
      // 2. Sandbox temp override (flag re-checked here, unlike POSIX).
      if (pendingUseSandbox && pendingSandboxTmp) {
        overrides.TMPDIR = pendingSandboxTmp
        overrides.MERCURY_TMPDIR = pendingSandboxTmp
      }
      // 3. Windows-only overrides (raw process platform, per the snapshot).
      if (process.platform === 'win32') {
        overrides.MSYS2_ARG_CONV_EXCL = '*'
        overrides.MSYS_NO_PATHCONV = '1'
        // Python children default their stdio to the console codepage while
        // the harness decodes every pipe as hard UTF-8 (and boots the
        // console to CP 65001): pin Python's stdio to UTF-8 with 'replace'
        // so non-UTF-8 stdin degrades to visible replacement characters
        // instead of a decode crash, and non-ASCII output neither raises an
        // encode error nor lands as mojibake. An operator's own setting wins.
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
