import { randomBytes } from 'node:crypto'
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
import { rememberedPlatform } from '../platform/host.js'
import { childGetsOwnProcessGroup } from '../platform/processes.js'
import { WINDOWS_STARTS_A_PROGRAM_IN, folderWindowsStartsIn, windowsPathToPosixPath } from '../windowsPaths.js'
import { getGlobPreambleCommand } from './globPreamble.js'
import { carriedByFile, msysArgvCarries, msysSourceLine, protectBackslashRunsFromMsysArgv } from './msysArgv.js'
import type { BuildExecCommandOptions, FrameHandOver, ShellProvider } from './shellProvider.js'
import { PIPELINE_STATUS_ARRAY, loginFilesNotCarried, type ShellRecord } from './shellRecord.js'
import { passedOverAs } from '../passedOver.js'

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
  const isWindows = getPlatform() === 'windows'
  let snapshotFilePath: string | undefined
  if (!options?.skipSnapshot) {
    snapshotFilePath = await createAndSaveSnapshot(record).catch(passedOverAs(undefined))
  }
  let lastUsedSnapshot = snapshotFilePath !== undefined

  return {
    type: 'bash',
    shellPath: record.path,
    origin: record.origin,
    detached: childGetsOwnProcessGroup(rememberedPlatform()),

    async buildExecCommand(command: string, opts: BuildExecCommandOptions) {
      if (snapshotFilePath !== undefined && !existsSync(snapshotFilePath)) {
        logForDebugging(`shell snapshot ${snapshotFilePath} vanished; commands run without it`)
        snapshotFilePath = undefined
      }
      const usableSnapshot = snapshotFilePath
      lastUsedSnapshot = usableSnapshot !== undefined
      if (usableSnapshot === undefined) {
        const why = loginFilesNotCarried()?.why
        logForDebugging(why ? `no shell snapshot in use (${why})` : 'no shell snapshot in use')
      }

      const cwdFile = cwdFileName(opts.id)
      const cwdFileInShell = isWindows
        ? posixPath.join(windowsPathToPosixPath(tmpdir()), cwdFile)
        : join(tmpdir(), cwdFile)
      const trackPipeline = command.includes('|')
      const pipelineStatusPath = trackPipeline ? `${cwdFileInShell}-pipeline` : undefined
      const jobsPath = isWindows && STARTS_A_JOB.test(command) ? `${cwdFileInShell}-jobs` : undefined

      const parts: string[] = []
      if (usableSnapshot !== undefined) {
        const snapshotInShell = isWindows ? windowsPathToPosixPath(usableSnapshot) : usableSnapshot
        parts.push(`{ [ -f ${quote([snapshotInShell])} ] && source ${quote([snapshotInShell])} < /dev/null; } 2>/dev/null || true`)
      }

      const sessionEnvScript = await getSessionEnvironmentScript(record.origin !== 'engine')
      if (sessionEnvScript) {
        parts.push(sessionEnvScript)
      }

      const globPreamble = getGlobPreambleCommand(record.origin)
      if (globPreamble) {
        parts.push(globPreamble)
      }

      if (isWindows) {
        parts.push(UTF8_CONSOLE)
        parts.push(CMD_SWITCHES_AS_WRITTEN)
        if (jobsPath !== undefined) {
          parts.push(`{ printf '%s\\n' "$$" >| ${quote([jobsPath])}; } 2>/dev/null || true`)
        }
      }

      const preparedCommand = rewriteWindowsNullRedirect(command)
      const addStdin = shouldAddStdinRedirect(preparedCommand)
      const evalBody = pipelineStatusPath !== undefined
        ? `${preparedCommand}\n__mercury_p $? "${PIPELINE_STATUS_ARRAY}"`
        : preparedCommand
      const quotedCommand = addStdin && preparedCommand.includes('|')
        ? rearrangePipeCommand(evalBody)
        : quoteShellCommand(evalBody, addStdin)

      if (pipelineStatusPath !== undefined) {
        parts.push(`__mercury_p() { __mercury_rc=$1; shift; { printf '%s\\n' "$@" >| ${quote([pipelineStatusPath])}; } 2>/dev/null; return "$__mercury_rc"; }`)
      }

      const quotedCwdFile = quote([cwdFileInShell])
      const cwdRecord = isWindows
        ? `{ { pwd -P >| ${quotedCwdFile}; pwd -W >> ${quotedCwdFile}; } 2>/dev/null || true; }`
        : `{ { pwd -P >| ${quotedCwdFile}; } 2>/dev/null || true; }`
      parts.push(`eval ${quotedCommand} && ${cwdRecord}`)

      const body = parts.join('\n')
      const prefix = shellPrefix()
      const afterMark = prefix
        ? formatShellPrefixCommand(prefix, isWindows ? body : shellStartLine(record.path, body))
        : body
      const commandString = prefix
        ? `${markFrameRead(cwdFileInShell)}; ${afterMark}`
        : `${markFrameRead(cwdFileInShell)}\n${afterMark}`

      const handOver = isWindows
        ? (env: NodeJS.ProcessEnv, cwd?: string): FrameHandOver => {
            let frame = commandString
            let startIn: string | undefined
            if (cwd !== undefined && cwd.length > WINDOWS_STARTS_A_PROGRAM_IN) {
              startIn = folderWindowsStartsIn(cwd)
              const targetInShell = windowsPathToPosixPath(cwd)
              const enterLongCwd = `cd -- ${quote([targetInShell])} || exit $?; unset OLDPWD CDPATH 2>/dev/null || :; dirs -c 2>/dev/null || :`
              frame = `${markFrameRead(cwdFileInShell)}\n${enterLongCwd}\n${afterMark}`
            }
            const noLoginFiles = lastUsedSnapshot || loginRunFailed(record.path)
            if (msysArgvCarries(frame, env)) {
              return {
                args: msysSpawnArgs(frame, noLoginFiles),
                ...(startIn !== undefined ? { startIn } : {}),
              }
            }
            const filePath = join(tmpdir(), `mercury-frame-${process.pid}-${++frameFiles}`)
            const fileInShell = windowsPathToPosixPath(filePath)
            const mark = randomBytes(6).toString('hex')
            const words = `Mercury: the file that carries this command to bash is gone (${filePath}), so nothing ran.`
            const loader = msysSourceLine(fileInShell, { words, exit: 126, mark })
            return {
              args: msysSpawnArgs(loader, noLoginFiles),
              file: { path: filePath, text: carriedByFile(frame, mark) },
              ...(startIn !== undefined ? { startIn } : {}),
            }
          }
        : undefined

      return {
        commandString,
        cwdFilePath: cwdFileInShell,
        ...(pipelineStatusPath !== undefined ? { pipelineStatusPath } : {}),
        ...(jobsPath !== undefined ? { jobsPath } : {}),
        ...(handOver !== undefined ? { handOver } : {}),
      }
    },

    getSpawnArgs(commandString: string): string[] {
      if (isWindows) {
        return msysSpawnArgs(commandString, lastUsedSnapshot || loginRunFailed(record.path))
      }
      return ['-c', commandString]
    },

    async getEnvironmentOverrides(_command: string): Promise<Record<string, string>> {
      return Object.fromEntries(getSessionEnvVars())
    },
  }
}
