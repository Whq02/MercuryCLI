import { spawn } from 'node:child_process'
import { accessSync, constants, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { TENSORFOLD_RUNTIME_FOLDER } from './engine.js'
import type { TensorFoldMachineTruth } from './fit.js'
import { TENSORFOLD_BREW_FORMULA, TENSORFOLD_RELEASE, TENSORFOLD_RELEASE_BASE } from './starting.js'

export type TensorFoldInstallPlan =
  | { kind: 'brew'; brew: string; commands: string[]; words: string; found: string }
  | { kind: 'needs-brew'; words: string; needs: string; found: string }
  | { kind: 'archive'; folder: string; archive: string; commands: string[]; words: string; found: string }
  | { kind: 'no-gpu'; words: string; found: string }
  | { kind: 'old-driver'; words: string; found: string }
  | { kind: 'windows'; words: string; found: string }

export type InstallIo = {
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  home?: string
  exists?: (path: string) => boolean
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function findBrew(io: InstallIo = {}): string | undefined {
  const exists = io.exists ?? executable
  const env = io.env ?? process.env
  const dirs = [...(env.PATH ?? '').split(delimiter).filter(dir => dir !== ''), '/opt/homebrew/bin', '/usr/local/bin']
  for (const dir of dirs) {
    const candidate = join(dir, 'brew')
    if (exists(candidate)) return candidate
  }
  return undefined
}

const BREW_INSTALL_COMMAND = `brew install ${TENSORFOLD_BREW_FORMULA}`
const NEEDS_BREW_WORDS = 'Homebrew · brew.sh installs it, then /tensorfold again'
const WINDOWS_WORDS = 'no Windows release yet'
const NO_GPU_WORDS = 'no NVIDIA GPU found'
const RUNTIME_FOLDER_WORDS = `~/${TENSORFOLD_RUNTIME_FOLDER}`

function linuxArchiveName(arch: string): string {
  const platform = arch === 'arm64' || arch === 'aarch64' ? 'linux-aarch64' : 'linux-x86_64'
  return `tensorfold-${TENSORFOLD_RELEASE}-${platform}.tar.gz`
}

function archiveInstallCommands(archive: string, folderWords: string = RUNTIME_FOLDER_WORDS): string[] {
  return [
    `cd ${folderWords}`,
    `curl -fLO ${TENSORFOLD_RELEASE_BASE}/${archive}`,
    `curl -fLO ${TENSORFOLD_RELEASE_BASE}/${archive}.sha256`,
    `sha256sum -c ${archive}.sha256`,
    `tar -xzf ${archive} --strip-components=1`,
    `rm ${archive} ${archive}.sha256`,
  ]
}

export function tensorFoldInstallPlan(machine: Pick<TensorFoldMachineTruth, 'platform' | 'gpu'>, io: InstallIo = {}): TensorFoldInstallPlan {
  const platform = io.platform ?? machine.platform
  if (platform === 'win32') return { kind: 'windows', words: WINDOWS_WORDS, found: 'nothing served here · TensorFold runs on a host' }
  if (platform === 'darwin') {
    const brew = findBrew(io)
    if (brew === undefined) return { kind: 'needs-brew', words: 'needs Homebrew', needs: NEEDS_BREW_WORDS, found: 'not installed · Homebrew not found' }
    return { kind: 'brew', brew, commands: [BREW_INSTALL_COMMAND], words: `Homebrew · ${TENSORFOLD_BREW_FORMULA.slice(0, TENSORFOLD_BREW_FORMULA.lastIndexOf('/'))}`, found: `not installed · Homebrew found at ${brew}` }
  }
  if (machine.gpu === undefined) return { kind: 'no-gpu', words: NO_GPU_WORDS, found: `not installed · ${NO_GPU_WORDS}` }
  const driver = machine.gpu.driver ?? 'unknown'
  if (machine.gpu.cuda !== '13') return { kind: 'old-driver', words: `driver ${driver} · TensorFold needs R580 or newer`, found: `not installed · driver ${driver} · TensorFold needs R580 or newer` }
  const archive = linuxArchiveName(io.arch ?? process.arch)
  const folder = join(io.home ?? homedir(), TENSORFOLD_RUNTIME_FOLDER)
  return { kind: 'archive', folder, archive, commands: archiveInstallCommands(archive), words: 'release archive · checksum verified', found: `not installed · NVIDIA driver ${driver} (CUDA 13)` }
}

type InstallRun = { command: string; args: string[]; cwd?: string }

export function installRuns(plan: TensorFoldInstallPlan): InstallRun[] {
  if (plan.kind === 'brew') return [{ command: plan.brew, args: ['install', TENSORFOLD_BREW_FORMULA] }]
  if (plan.kind === 'archive') {
    const url = `${TENSORFOLD_RELEASE_BASE}/${plan.archive}`
    return [
      { command: 'curl', args: ['-fLO', url], cwd: plan.folder },
      { command: 'curl', args: ['-fLO', `${url}.sha256`], cwd: plan.folder },
      { command: 'sha256sum', args: ['-c', `${plan.archive}.sha256`], cwd: plan.folder },
      { command: 'tar', args: ['-xzf', plan.archive, '--strip-components=1'], cwd: plan.folder },
      { command: 'rm', args: [plan.archive, `${plan.archive}.sha256`], cwd: plan.folder },
    ]
  }
  return []
}

type InstallOutcome = { ok: true } | { ok: false; step: string; line: string }

export async function installTensorFold(plan: TensorFoldInstallPlan, onLine: (line: string) => void, io: { signal?: AbortSignal; spawnImpl?: typeof spawn; env?: NodeJS.ProcessEnv } = {}): Promise<InstallOutcome> {
  const runs = installRuns(plan)
  if (runs.length === 0) return { ok: false, step: 'install', line: plan.kind === 'needs-brew' ? plan.needs : plan.words }
  if (plan.kind === 'archive') mkdirSync(plan.folder, { recursive: true })
  const launch = io.spawnImpl ?? spawn
  for (const run of runs) {
    const outcome = await new Promise<InstallOutcome>(resolve => {
      let last = ''
      let child: ReturnType<typeof spawn>
      try {
        child = launch(run.command, run.args, { cwd: run.cwd, env: io.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        resolve({ ok: false, step: run.command, line: error instanceof Error ? error.message : String(error) })
        return
      }
      const take = (chunk: Buffer | string): void => {
        for (const line of String(chunk).split(/\r?\n/)) {
          const trimmed = line.trim()
          if (trimmed === '') continue
          last = trimmed
          onLine(trimmed)
        }
      }
      child.stdout?.on('data', take)
      child.stderr?.on('data', take)
      const abort = (): void => {
        child.kill('SIGTERM')
      }
      io.signal?.addEventListener('abort', abort, { once: true })
      child.on('error', error => resolve({ ok: false, step: run.command, line: error.message }))
      child.on('exit', code => {
        io.signal?.removeEventListener('abort', abort)
        resolve(code === 0 ? { ok: true } : { ok: false, step: `${run.command} ${run.args.join(' ')}`, line: last === '' ? `exit ${code ?? 'signal'}` : last })
      })
    })
    if (!outcome.ok) return outcome
  }
  return { ok: true }
}
