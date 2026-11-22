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
import { notBuilt } from '../../pi/holes.js'

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
  return notBuilt('src/utils/shell/bashProvider.ts:54')
}
