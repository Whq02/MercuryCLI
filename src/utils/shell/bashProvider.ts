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

const MSYS_ARGV_HALVED_BACKSLASH_RUN_RE = /\\{2,}(?=[^\\"])/g

function protectBackslashRunsFromMsysArgv(script: string): string {
  return script.replace(MSYS_ARGV_HALVED_BACKSLASH_RUN_RE, run => run + run)
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

  const provider: ShellProvider = {
    type: 'bash',
    shellPath,
    detached: getPlatform() !== 'windows',

    async buildExecCommand(command: string, opts: BuildExecCommandOptions) {
      let snapshot = snapshotPath
      if (snapshot && !existsSync(snapshot)) {
        logForDebugging(`shell snapshot ${snapshot} vanished; falling back to login shell`)
        snapshot = undefined
        snapshotPath = undefined
      }
      usedSnapshotThisExecution = snapshot !== undefined

      const name = cwdFileName(opts.id)
      const isWindows = getPlatform() === 'windows'
      const nativeTmp = tmpdir()
      const cwdFileInShell = isWindows
        ? posixPath.join(windowsPathToPosixPath(nativeTmp), name)
        : posixPath.join(nativeTmp, name)
      const cwdFileForEngine = isWindows ? cwdFileInShell : join(nativeTmp, name)

      const raw = rewriteWindowsNullRedirect(command)
      const pipelineStatusPath = raw.includes('|') ? `${cwdFileForEngine}-pipeline` : undefined
      const pipelineFileInShell = `${cwdFileInShell}-pipeline`
      const statuses = shellPath.includes('zsh') ? '${pipestatus[@]}' : '${PIPESTATUS[@]}'
      const normalised = pipelineStatusPath === undefined ? raw : `${raw}\n__mercury_status=$? __mercury_pipeline=("${statuses}")\nprintf '%s\\n' "\${__mercury_pipeline[@]}" >| ${quote([pipelineFileInShell])}\n(exit "$__mercury_status")`
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
      parts.push(`eval ${quotedCommand}`)
      parts.push(`{ pwd -P >| ${quote([cwdFileInShell])} 2>/dev/null || true; }`)
      if (isWindows) {
        parts.push(`{ pwd -W >> ${quote([cwdFileInShell])} 2>/dev/null || true; }`)
      }

      let commandString = parts.join(' && ')
      const prefix = shellPrefix()
      if (prefix) commandString = formatShellPrefixCommand(prefix, commandString)

      return { commandString, cwdFilePath: cwdFileForEngine, ...(pipelineStatusPath === undefined ? {} : { pipelineStatusPath }) }
    },

    getSpawnArgs(commandString: string): string[] {
      const script = getPlatform() === 'windows' ? protectBackslashRunsFromMsysArgv(commandString) : commandString
      if (!usedSnapshotThisExecution) {
        logForDebugging('no shell snapshot in use; adding the login flag')
        return ['-c', '-l', script]
      }
      return ['-c', script]
    },

    async getEnvironmentOverrides(_command: string): Promise<Record<string, string>> {
      const overrides: Record<string, string> = {}
      for (const [key, value] of getSessionEnvVars()) overrides[key] = value
      return overrides
    },
  }

  return provider
}
