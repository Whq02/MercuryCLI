/**
 * Bash/POSIX implementation of the shell-provider contract: command assembly,
 * spawn args, env overrides. Mercury-original parts: the MERCURY_SHELL_PREFIX
 * wrapper, the product-prefixed cwd-tracking file name, and the
 * glob-normalisation preamble hook.
 */
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix as posixPath } from 'node:path'
import { createAndSaveSnapshot } from '../bash/ShellSnapshot.js'
import { quote } from '../bash/shellQuote.js'
import { rearrangePipeCommand } from '../bash/bashPipeCommand.js'
import {
  quoteShellCommand,
  rewriteWindowsNullRedirect,
  shouldAddStdinRedirect,
} from '../bash/shellQuoting.js'
import { formatShellPrefixCommand } from '../bash/shellPrefix.js'
import { logForDebugging } from '../debug.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { getSessionEnvironmentScript } from '../sessionEnvironment.js'
import { getSessionEnvVars } from '../sessionEnvVars.js'
import { getPlatform } from '../platform.js'
import { windowsPathToPosixPath } from '../windowsPaths.js'
import { getGlobPreambleCommand } from './globPreamble.js'
import type { BuildExecCommandOptions, ShellProvider } from './shellProvider.js'

/** The product-prefixed cwd-tracking file name (differs only in path form). */
function cwdFileName(id: number | string): string {
  return `mercury-cwd-${id}`
}

/** The configured shell-prefix, read at assembly time. */
function shellPrefix(): string {
  return flagEnv('MERCURY_SHELL_PREFIX') ?? ''
}

/** Create a POSIX/bash shell provider. */
export async function createBashShellProvider(
  shellPath: string,
  options?: { skipSnapshot?: boolean },
): Promise<ShellProvider> {
  // Kick off snapshot capture (fire-and-forget; failures degrade to no snapshot).
  let snapshotPath: string | undefined
  if (!options?.skipSnapshot) {
    snapshotPath = await createAndSaveSnapshot(shellPath).catch(() => undefined)
  }
  // Remembered so spawn args add the login flag when no snapshot was used.
  let usedSnapshotThisExecution = false
  // Stashed for the env-override step (the POSIX provider does not re-check
  // the flag; the engine passes the dir only when sandboxing).
  let pendingSandboxTmp: string | undefined

  const provider: ShellProvider = {
    type: 'bash',
    shellPath,
    // POSIX only: a detached group enables the -pid tree kill. On win32 the
    // same flag put the tool's shell OUTSIDE the closing console's kill set
    // — closing the window left the operator's command running with Mercury
    // gone (FC-024); Windows tree kills ride taskkill, never the group.
    detached: getPlatform() !== 'windows',

    async buildExecCommand(command: string, opts: BuildExecCommandOptions) {
      pendingSandboxTmp = opts.useSandbox ? opts.sandboxTmpDir : undefined
      // Per-execution snapshot liveness check.
      let snapshot = snapshotPath
      if (snapshot && !existsSync(snapshot)) {
        logForDebugging(`shell snapshot ${snapshot} vanished; falling back to login shell`)
        snapshot = undefined
        snapshotPath = undefined
      }
      usedSnapshotThisExecution = snapshot !== undefined

      // One cwd file name per execution; only the path FORM differs.
      const name = cwdFileName(opts.id)
      const isWindows = getPlatform() === 'windows'
      let cwdFileInShell: string
      let cwdFileForEngine: string
      if (opts.useSandbox && opts.sandboxTmpDir) {
        const inSandbox = posixPath.join(opts.sandboxTmpDir, name)
        cwdFileInShell = inSandbox
        cwdFileForEngine = inSandbox
      } else {
        const nativeTmp = tmpdir()
        const posixPathInShell = isWindows
          ? posixPath.join(windowsPathToPosixPath(nativeTmp), name)
          : posixPath.join(nativeTmp, name)
        cwdFileInShell = posixPathInShell
        // The engine converts POSIX→native on Windows itself, so return POSIX there.
        cwdFileForEngine = isWindows ? posixPathInShell : join(nativeTmp, name)
      }

      // Command normalisation before quoting.
      const normalised = rewriteWindowsNullRedirect(command)
      const addStdin = shouldAddStdinRedirect(normalised)
      let quotedCommand = quoteShellCommand(normalised, addStdin)
      // Pipe special case: a pipe + stdin redirect must land on the first stage.
      if (addStdin && normalised.includes('|')) {
        quotedCommand = rearrangePipeCommand(normalised)
      }

      // Assemble the chain, joined by short-circuiting &&.
      const parts: string[] = []
      if (snapshot) {
        parts.push(`source ${quote([snapshot])} 2>/dev/null || true`)
      }
      const sessionScript = await getSessionEnvironmentScript()
      if (sessionScript) parts.push(sessionScript)
      const preamble = getGlobPreambleCommand(shellPath)
      if (preamble) parts.push(preamble)
      parts.push(`eval ${quotedCommand}`)
      // The record is grouped like the Win32 leg below so its own failure
      // never replaces the user command's status: a command that deletes
      // the directory it runs in leaves pwd nothing to report, and the
      // engine already treats a missing record as "the session stays put".
      parts.push(`{ pwd -P >| ${quote([cwdFileInShell])} 2>/dev/null || true; }`)
      if (isWindows) {
        // git-bash: a second line with the shell's OWN Win32 spelling of the
        // directory. pwd -P under MSYS reports a virtual root (/tmp,
        // /usr/local, /mingw64/bin) that no static converter can place —
        // the engine's slash-flip made it drive-relative and the session
        // moved to a real but wrong folder (FN-015 rank 45). pwd -W is the
        // MSYS builtin's Win32 answer; a bash without it appends nothing and
        // the engine's refusal names the residue. Grouped so the user
        // command's status stays the chain's.
        parts.push(`{ pwd -W >> ${quote([cwdFileInShell])} 2>/dev/null || true; }`)
      }

      let commandString = parts.join(' && ')
      const prefix = shellPrefix()
      if (prefix) commandString = formatShellPrefixCommand(prefix, commandString)

      return { commandString, cwdFilePath: cwdFileForEngine }
    },

    getSpawnArgs(commandString: string): string[] {
      // -c plus the command; insert -l between them when no snapshot was used.
      if (!usedSnapshotThisExecution) {
        logForDebugging('no shell snapshot in use; adding the login flag')
        return ['-c', '-l', commandString]
      }
      return ['-c', commandString]
    },

    async getEnvironmentOverrides(_command: string): Promise<Record<string, string>> {
      const overrides: Record<string, string> = {}
      // Sandbox temp overrides (the provider stashes the dir without re-checking
      // the flag; the engine passes it only when sandboxing).
      const sandboxTmp = pendingSandboxTmp
      if (sandboxTmp) {
        const dir = getPlatform() === 'windows' ? windowsPathToPosixPath(sandboxTmp) : sandboxTmp
        overrides.TMPDIR = dir
        overrides.MERCURY_TMPDIR = dir
        overrides.TMPPREFIX = posixPath.join(dir, 'zsh')
      }
      // Session env vars LAST (the opposite of the PowerShell provider).
      for (const [key, value] of getSessionEnvVars()) overrides[key] = value
      return overrides
    },
  }

  return provider
}
