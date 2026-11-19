import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix as posixPath } from 'node:path'
import { createAndSaveSnapshot, loginRunFailed } from '../bash/ShellSnapshot.js'
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
import { WINDOWS_STARTS_A_PROGRAM_IN, folderWindowsStartsIn, windowsPathToPosixPath } from '../windowsPaths.js'
import { getGlobPreambleCommand } from './globPreamble.js'
import { msysArgvCarries, msysSourceLine, protectBackslashRunsFromMsysArgv } from './msysArgv.js'
import type { BuildExecCommandOptions, FrameHandOver, ShellProvider } from './shellProvider.js'
import { PIPELINE_STATUS_ARRAY, loginFilesNotCarried, type ShellRecord } from './shellRecord.js'

function cwdFileName(id: number | string): string {
  return `mercury-cwd-${id}`
}

function shellPrefix(): string {
  return flagEnv('MERCURY_SHELL_PREFIX') ?? ''
}

let frameFiles = 0

const UTF8_CONSOLE = '{ chcp.com 65001 >/dev/null 2>&1 || true; }'

const STARTS_A_JOB = /(?:^|[^&>|<\\])&(?![&>])/

const CMD_SWITCHES_AS_WRITTEN =
  '{ cmd() { local a w=(); case "${1-}" in /[a-zA-Z]|/[a-zA-Z]:*) for a in "$@"; do case "$a" in /*/*) ;; /[a-zA-Z]*) a="/$a";; esac; w+=("$a"); done; set -- "${w[@]}";; esac; command cmd "$@"; }; alias cmd.exe=cmd 2>/dev/null || true; }'

function msysSpawnArgs(commandString: string, noLoginFiles: boolean): string[] {
  const script = protectBackslashRunsFromMsysArgv(commandString)
  return noLoginFiles ? ['-c', script] : ['-c', '-l', script]
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
      if (!snapshot) logForDebugging(`no shell snapshot in use${loginFilesNotCarried() === null ? '' : ` (${loginFilesNotCarried()?.why})`}`)

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
      const normalised = pipelineStatusPath === undefined ? raw : `${raw}\n__mercury_status=$? __mercury_pipeline=("${PIPELINE_STATUS_ARRAY}")\n{ printf '%s\\n' "\${__mercury_pipeline[@]}" >| ${quote([pipelineFileInShell])}; } 2>/dev/null\n(exit "$__mercury_status")`
      const addStdin = shouldAddStdinRedirect(normalised)
      let quotedCommand = quoteShellCommand(normalised, addStdin)
      if (addStdin && normalised.includes('|')) {
        quotedCommand = rearrangePipeCommand(normalised)
      }

      const parts: string[] = []
      if (snapshot) {
        parts.push(`source ${quote([snapshot])} 2>/dev/null || true`)
      }
      const sessionScript = await getSessionEnvironmentScript(record.origin !== 'engine')
      if (sessionScript) parts.push(sessionScript)
      const preamble = getGlobPreambleCommand(record.origin)
      if (preamble) parts.push(preamble)
      if (isWindows) parts.push(CMD_SWITCHES_AS_WRITTEN)
      if (isWindows) parts.push(UTF8_CONSOLE)
      const jobsPath = isWindows && STARTS_A_JOB.test(raw) ? `${cwdFileForEngine}-jobs` : undefined
      if (jobsPath !== undefined) parts.push(`{ { echo $$ >| ${quote([`${cwdFileInShell}-jobs`])}; } 2>/dev/null || true; }`)
      parts.push(`eval ${quotedCommand}`)
      parts.push(`{ { pwd -P >| ${quote([cwdFileInShell])}; } 2>/dev/null || true; }`)
      if (isWindows) {
        parts.push(`{ pwd -W >> ${quote([cwdFileInShell])} 2>/dev/null || true; }`)
      }

      let commandString = parts.join(' && ')
      const prefix = shellPrefix()
      if (prefix) commandString = formatShellPrefixCommand(prefix, isWindows ? commandString : shellStartLine(shellPath, commandString))
      if (!isWindows) commandString = `${markFrameRead(cwdFileInShell)}; ${commandString}`

      if (isWindows) {
        const noLoginFiles = snapshot !== undefined || loginRunFailed(shellPath)
        const handOver = (env: NodeJS.ProcessEnv, cwd?: string): FrameHandOver => {
          const { frame, ...where } =
            cwd !== undefined && cwd.length > WINDOWS_STARTS_A_PROGRAM_IN
              ? { frame: `cd -- ${quote([windowsPathToPosixPath(cwd)])} || exit; ${commandString}`, startIn: folderWindowsStartsIn(cwd) }
              : { frame: commandString }
          if (msysArgvCarries(frame, env)) return { args: msysSpawnArgs(frame, noLoginFiles), ...where }
          const own = `-${process.pid}-${frameFiles++}-frame`
          return { args: msysSpawnArgs(msysSourceLine(`${cwdFileInShell}${own}`), noLoginFiles), file: { path: join(nativeTmp, `${name}${own}`), text: frame }, ...where }
        }
        return { commandString, cwdFilePath: cwdFileForEngine, handOver, ...(pipelineStatusPath === undefined ? {} : { pipelineStatusPath }), ...(jobsPath === undefined ? {} : { jobsPath }) }
      }
      return { commandString, cwdFilePath: cwdFileForEngine, ...(pipelineStatusPath === undefined ? {} : { pipelineStatusPath }) }
    },

    getSpawnArgs(commandString: string): string[] {
      if (getPlatform() !== 'windows') return ['-c', commandString]
      return msysSpawnArgs(commandString, usedSnapshotThisExecution || loginRunFailed(shellPath))
    },

    async getEnvironmentOverrides(_command: string): Promise<Record<string, string>> {
      const overrides: Record<string, string> = {}
      for (const [key, value] of getSessionEnvVars()) overrides[key] = value
      return overrides
    },
  }

  return provider
}
