import { execFileSync, spawn, spawnSync, type StdioOptions } from 'node:child_process'
import { createInterface } from 'node:readline'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import type { LayoutRoots } from './installLayout.js'
import { commandOnPath } from './installPath.js'
import type { ForeignInstaller } from './installProvenance.js'

export const CONSENT_SUFFIX = ' [y/N] '

export function installerConsentQuestion(installer: ForeignInstaller): string {
  return `This Mercury was installed by ${installer.name}. Run \`${installer.updateCommand}\` now?`
}

export function installerRoadWords(installer: ForeignInstaller): string {
  return `\`mercury update\` runs \`${installer.updateCommand}\``
}

export function askYesNo(
  question: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<boolean> {
  return new Promise(resolve => {
    const rl = createInterface({ input, output })
    let settled = false
    const settle = (answer: boolean): void => {
      if (settled) return
      settled = true
      rl.close()
      resolve(answer)
    }
    rl.on('close', () => settle(false))
    rl.question(`${question}${CONSENT_SUFFIX}`, answer => settle(/^y(es)?$/i.test(answer.trim())))
  })
}

export type InstallerRunOutcome =
  | { state: 'exited'; exitCode: number }
  | { state: 'not-found'; executable: string }
  | { state: 'failed'; note: string }

function startCommand(argv: string[], stdio: StdioOptions): ReturnType<typeof spawn> {
  const env = subprocessEnv()
  if (process.platform === 'win32') {
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${argv.join(' ')}"`], {
      stdio,
      env,
      windowsVerbatimArguments: true,
      windowsHide: true,
    })
  }
  const [file, ...args] = argv
  return spawn(file ?? '', args, { stdio, env, windowsHide: true })
}

export function runInstallerUpgrade(installer: ForeignInstaller, opts: { stdoutTo: 'inherit' | 'stderr' }): Promise<InstallerRunOutcome> {
  const argv = installer.updateCommand.split(' ')
  return new Promise(resolve => {
    const child = startCommand(argv, ['inherit', opts.stdoutTo === 'stderr' ? 'pipe' : 'inherit', 'inherit'])
    if (opts.stdoutTo === 'stderr') child.stdout?.pipe(process.stderr)
    child.once('error', error => {
      const code = (error as NodeJS.ErrnoException).code
      resolve(code === 'ENOENT' ? { state: 'not-found', executable: argv[0] ?? '' } : { state: 'failed', note: error.message })
    })
    child.once('close', (code, signal) => resolve({ state: 'exited', exitCode: code ?? (signal ? 1 : 0) }))
  })
}

export type VersionAfterUpgrade =
  | { state: 'read'; version: string; command: string }
  | { state: 'no-command' }
  | { state: 'unreadable'; command: string; note: string }

function versionOutput(command: string): string {
  const env = subprocessEnv()
  if (process.platform === 'win32') {
    const r = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${command}" --version"`], {
      encoding: 'utf8',
      timeout: 60_000,
      env,
      windowsVerbatimArguments: true,
      windowsHide: true,
    })
    if (r.error) throw r.error
    return String(r.stdout ?? '')
  }
  return execFileSync(command, ['--version'], { encoding: 'utf8', timeout: 60_000, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
}

export function readVersionAfterUpgrade(roots: LayoutRoots): VersionAfterUpgrade {
  const found = commandOnPath(roots)
  if (found.state === 'absent') return { state: 'no-command' }
  const command = found.resolved
  try {
    const printed = versionOutput(command).trim()
    const version = printed.split(/\r?\n/)[0]?.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/)?.[0]
    return version
      ? { state: 'read', version, command }
      : { state: 'unreadable', command, note: `--version printed "${printed.slice(0, 120)}"` }
  } catch (error) {
    return { state: 'unreadable', command, note: error instanceof Error ? error.message.slice(0, 200) : String(error) }
  }
}
