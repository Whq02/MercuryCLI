import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix as posixPath } from 'node:path'
import { createAndSaveSnapshot, shellSnapshotAbsence } from '../bash/ShellSnapshot.js'
import { quote } from '../bash/shellQuote.js'
import { rearrangePipeCommand } from '../bash/bashPipeCommand.js'
import {
  quoteShellCommand,
  rewriteWindowsNullRedirect,
  shouldAddStdinRedirect,
} from '../bash/shellQuoting.js'
import { formatShellPrefixCommand, shellStartLine } from '../bash/shellPrefix.js'
import { logForDebugging } from '../debug.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { getSessionEnvironmentScript } from '../sessionEnvironment.js'
import { getSessionEnvVars } from '../sessionEnvVars.js'
import { getPlatform } from '../platform.js'
import { windowsPathToPosixPath } from '../windowsPaths.js'
import { getGlobPreambleCommand } from './globPreamble.js'
import type { BuildExecCommandOptions, ShellProvider } from './shellProvider.js'
import { PIPELINE_STATUS_ARRAY, type ShellRecord } from './shellRecord.js'

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

function markFrameRead(cwdFileInShell: string): string {
  return `{ : >| ${quote([cwdFileInShell])}; } 2>/dev/null`
}

export async function createBashShellProvider(
  record: ShellRecord,
  options?: { skipSnapshot?: boolean },
): Promise<ShellProvider> {
  const shellPath = record.path
  let snapshotPath: string | undefined
  if (!options?.skipSnapshot) {
    snapshotPath = await createAndSaveSnapshot(record).catch(() => undefined)
  }
  let usedSnapshotThisExecution = false

  const provider: ShellProvider = {
    type: 'bash',
    shellPath,
    origin: record.origin,
    detached: getPlatform() !== 'windows',

    async buildExecCommand(command: string, opts: BuildExecCommandOptions) {
      let snapshot = snapshotPath
      if (snapshot && !existsSync(snapshot)) {
        logForDebugging(`shell snapshot ${snapshot} vanished; commands run without it`)
        snapshot = undefined
        snapshotPath = undefined
      }
      usedSnapshotThisExecution = snapshot !== undefined
      if (!snapshot) logForDebugging(`no shell snapshot in use${shellSnapshotAbsence() === null ? '' : ` (${shellSnapshotAbsence()})`}`)

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
      const normalised = pipelineStatusPath === undefined ? raw : `${raw}\n__mercury_status=$? __mercury_pipeline=("${PIPELINE_STATUS_ARRAY}")\nprintf '%s\\n' "\${__mercury_pipeline[@]}" >| ${quote([pipelineFileInShell])}\n(exit "$__mercury_status")`
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
      const preamble = getGlobPreambleCommand(record.origin)
      if (preamble) parts.push(preamble)
      parts.push(`eval ${quotedCommand}`)
      parts.push(`{ pwd -P >| ${quote([cwdFileInShell])} 2>/dev/null || true; }`)
      if (isWindows) {
        parts.push(`{ pwd -W >> ${quote([cwdFileInShell])} 2>/dev/null || true; }`)
      }

      let commandString = parts.join(' && ')
      const prefix = shellPrefix()
      if (prefix) commandString = formatShellPrefixCommand(prefix, isWindows ? commandString : shellStartLine(shellPath, commandString))
      if (!isWindows) commandString = `${markFrameRead(cwdFileInShell)}; ${commandString}`

      return { commandString, cwdFilePath: cwdFileForEngine, ...(pipelineStatusPath === undefined ? {} : { pipelineStatusPath }) }
    },

    getSpawnArgs(commandString: string): string[] {
      if (getPlatform() !== 'windows') return ['-c', commandString]
      const script = protectBackslashRunsFromMsysArgv(commandString)
      return usedSnapshotThisExecution ? ['-c', script] : ['-c', '-l', script]
    },

    async getEnvironmentOverrides(_command: string): Promise<Record<string, string>> {
      const overrides: Record<string, string> = {}
      for (const [key, value] of getSessionEnvVars()) overrides[key] = value
      return overrides
    },
  }

  return provider
}
