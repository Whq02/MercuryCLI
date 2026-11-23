import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAndSaveSnapshot, loginRunFailed } from './bash/shellSnapshot.js'
import { quote } from './bash/shellQuote.js'
import { rearrangePipeCommand } from './bash/bashPipeCommand.js'
import {
  quoteShellCommand,
  rewriteWindowsNullRedirect,
  shouldAddStdinRedirect,
} from './bash/shellQuoting.js'
import { formatShellPrefixCommand, shellStartLine } from './bash/shellPrefix.js'
import { logForDebugging } from '../logs/debugLog.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { getSessionEnvironmentScript } from '../environment/sessionEnvironment.js'
import { getSessionEnvVars } from '../environment/sessionEnvVars.js'
import { getPlatform } from '../environment/platform.js'
import { rememberedPlatform } from '../host-os/host.js'
import { childGetsOwnProcessGroup } from '../host-os/processes.js'
import { WINDOWS_STARTS_A_PROGRAM_IN, folderWindowsStartsIn, windowsPathToPosixPath } from '../files/windowsPaths.js'
import { getGlobPreambleCommand } from './globPreamble.js'
import { carriedByFile, msysArgvCarries, msysSourceLine, protectBackslashRunsFromMsysArgv } from './msysArgv.js'
import type { BuildExecCommandOptions, FrameHandOver, ShellProvider } from './shellProvider.js'
import { PIPELINE_STATUS_ARRAY, loginFilesNotCarried, type ShellRecord } from './shellRecord.js'
import { passedOverAs } from '../errors/passedOver.js'

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
        logForDebugging(`no shell snapshot in use${why ? ` (${why})` : ''}`)
      }

      const isWindows = getPlatform() === 'windows'
      const cwdFile = cwdFileName(opts.id)
      const cwdFileNative = join(tmpdir(), cwdFile)
      const cwdFileInShell = isWindows ? windowsPathToPosixPath(cwdFileNative) : cwdFileNative
      const preparedCommand = rewriteWindowsNullRedirect(command)
      const pipelineStatusPath = preparedCommand.includes('|') ? `${cwdFileInShell}-pipeline` : undefined
      const jobsPath = isWindows && STARTS_A_JOB.test(command) ? `${cwdFileInShell}-jobs` : undefined

      const parts: string[] = []
      if (usableSnapshot !== undefined) {
        const snapshotInShell = isWindows ? windowsPathToPosixPath(usableSnapshot) : usableSnapshot
        parts.push(`source ${quote([snapshotInShell])} 2>/dev/null || true`)
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
        parts.push(CMD_SWITCHES_AS_WRITTEN)
        parts.push(UTF8_CONSOLE)
        if (jobsPath !== undefined) {
          parts.push(`{ { echo $$ >| ${quote([jobsPath])}; } 2>/dev/null || true; }`)
        }
      }

      const commandToEval =
        pipelineStatusPath !== undefined
          ? `${preparedCommand}\n__mercury_status=$? __mercury_pipeline=("${PIPELINE_STATUS_ARRAY}")\n{ printf '%s\\n' "\${__mercury_pipeline[@]}" >| ${quote([pipelineStatusPath])}; } 2>/dev/null\n(exit "$__mercury_status")`
          : preparedCommand
      const addStdin = shouldAddStdinRedirect(commandToEval)
      const quotedCommand =
        addStdin && commandToEval.includes('|')
          ? rearrangePipeCommand(commandToEval)
          : quoteShellCommand(commandToEval, addStdin)
      parts.push(`eval ${quotedCommand}`)

      const quotedCwdFile = quote([cwdFileInShell])
      parts.push(`{ { pwd -P >| ${quotedCwdFile}; } 2>/dev/null || true; }`)
      if (isWindows) {
        parts.push(`{ pwd -W >> ${quotedCwdFile} 2>/dev/null || true; }`)
      }

      const frame = parts.join(' && ')
      const prefix = shellPrefix()
      const wrapped = prefix
        ? formatShellPrefixCommand(prefix, isWindows ? frame : shellStartLine(record.path, frame))
        : frame
      const commandString = isWindows ? wrapped : `${markFrameRead(cwdFileInShell)}; ${wrapped}`

      const handOver = isWindows
        ? (env: NodeJS.ProcessEnv, cwd?: string): FrameHandOver => {
            let handedFrame = commandString
            let startIn: string | undefined
            if (cwd !== undefined && cwd.length > WINDOWS_STARTS_A_PROGRAM_IN) {
              startIn = folderWindowsStartsIn(cwd)
              const targetInShell = windowsPathToPosixPath(cwd)
              handedFrame = `cd -- ${quote([targetInShell])} || exit; unset OLDPWD CDPATH 2>/dev/null || :; dirs -c 2>/dev/null || :; ${commandString}`
            }
            const noLoginFiles = usableSnapshot !== undefined || loginRunFailed(record.path)
            if (msysArgvCarries(handedFrame, env)) {
              return {
                args: msysSpawnArgs(handedFrame, noLoginFiles),
                ...(startIn !== undefined ? { startIn } : {}),
              }
            }
            const filePath = join(tmpdir(), `${cwdFile}-${process.pid}-${++frameFiles}-frame`)
            const fileInShell = windowsPathToPosixPath(filePath)
            const mark = randomBytes(6).toString('hex')
            const words = `Mercury: the file that carries this command to bash is gone (${filePath}), so nothing ran.`
            const loader = msysSourceLine(fileInShell, { words, exit: 126, mark })
            return {
              args: msysSpawnArgs(loader, noLoginFiles),
              file: { path: filePath, text: carriedByFile(handedFrame, mark) },
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
      if (getPlatform() === 'windows') {
        return msysSpawnArgs(commandString, lastUsedSnapshot || loginRunFailed(record.path))
      }
      return ['-c', commandString]
    },

    async getEnvironmentOverrides(_command: string): Promise<Record<string, string>> {
      return Object.fromEntries(getSessionEnvVars())
    },
  }
}
