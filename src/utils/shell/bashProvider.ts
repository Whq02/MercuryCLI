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

function cwdFileName(id: number | string): string {
  return `mercury-cwd-${id}`
}

function shellPrefix(): string {
  return flagEnv('MERCURY_SHELL_PREFIX') ?? ''
}

export function sandboxTempEnv(sandboxTmpDir: string): Record<string, string> {
  const dir = getPlatform() === 'windows' ? windowsPathToPosixPath(sandboxTmpDir) : sandboxTmpDir
  return { TMPDIR: dir, MERCURY_TMPDIR: dir, TMPPREFIX: posixPath.join(dir, 'zsh') }
}

export async function createBashShellProvider(
  shellPath: string,
  options?: { skipSnapshot?: boolean },
): Promise<ShellProvider> {
  let snapshotPath: string | undefined
  if (!options?.skipSnapshot) {
    snapshotPath = await createAndSaveSnapshot(shellPath).catch(() => undefined)
  }
  let usedSnapshotThisExecution = false
  let pendingSandboxTmp: string | undefined

  const provider: ShellProvider = {
    type: 'bash',
    shellPath,
    detached: getPlatform() !== 'windows',

    async buildExecCommand(command: string, opts: BuildExecCommandOptions) {
      pendingSandboxTmp = opts.useSandbox ? opts.sandboxTmpDir : undefined
      let snapshot = snapshotPath
      if (snapshot && !existsSync(snapshot)) {
        logForDebugging(`shell snapshot ${snapshot} vanished; falling back to login shell`)
        snapshot = undefined
        snapshotPath = undefined
      }
      usedSnapshotThisExecution = snapshot !== undefined

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
        cwdFileForEngine = isWindows ? posixPathInShell : join(nativeTmp, name)
      }

      const normalised = rewriteWindowsNullRedirect(command)
      const addStdin = shouldAddStdinRedirect(normalised)
      let quotedCommand = quoteShellCommand(normalised, addStdin)
      if (addStdin && normalised.includes('|')) {
        quotedCommand = rearrangePipeCommand(normalised)
      }

      const parts: string[] = []
      if (snapshot) {
        parts.push(`source ${quote([snapshot])} 2>/dev/null || true`)
      }
      const sessionScript = await getSessionEnvironmentScript()
      if (sessionScript) parts.push(sessionScript)
      const preamble = getGlobPreambleCommand(shellPath)
      if (preamble) parts.push(preamble)
      if (opts.useSandbox && opts.sandboxTmpDir) {
        const temp = sandboxTempEnv(opts.sandboxTmpDir)
        parts.push(
          `export ${Object.entries(temp)
            .map(([name, value]) => `${name}=${quote([value])}`)
            .join(' ')}`,
        )
      }
      parts.push(`eval ${quotedCommand}`)
      parts.push(`{ pwd -P >| ${quote([cwdFileInShell])} 2>/dev/null || true; }`)
      if (isWindows) {
        parts.push(`{ pwd -W >> ${quote([cwdFileInShell])} 2>/dev/null || true; }`)
      }

      let commandString = parts.join(' && ')
      const prefix = shellPrefix()
      if (prefix) commandString = formatShellPrefixCommand(prefix, commandString)

      return { commandString, cwdFilePath: cwdFileForEngine }
    },

    getSpawnArgs(commandString: string): string[] {
      if (!usedSnapshotThisExecution) {
        logForDebugging('no shell snapshot in use; adding the login flag')
        return ['-c', '-l', commandString]
      }
      return ['-c', commandString]
    },

    async getEnvironmentOverrides(_command: string): Promise<Record<string, string>> {
      const overrides: Record<string, string> = {}
      const sandboxTmp = pendingSandboxTmp
      if (sandboxTmp) Object.assign(overrides, sandboxTempEnv(sandboxTmp))
      for (const [key, value] of getSessionEnvVars()) overrides[key] = value
      return overrides
    },
  }

  return provider
}
