import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod/v4'
import { getMercuryHome } from '../utils/envUtils.js'
import { subprocessEnv } from '../utils/subprocessEnv.js'
import { publishAtomicSync } from '../substrate/fileStore.js'
import { lock } from '../utils/lockfile.js'

export const TUNE_DOOR_HELP = 'Train your own model on your own sessions'
const pointerSchema = z.strictObject({ root: z.string(), repository: z.string() })
export interface TuneDoorDeps { home?: string; execute?: typeof execute }
function execute(command: string, args: string[], cwd: string, inherit: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: subprocessEnv(), stdio: inherit ? 'inherit' : ['ignore', process.stderr, process.stderr], windowsHide: true })
    const forward = (signal: NodeJS.Signals): void => { child.kill(signal) }
    const interrupt = (): void => forward('SIGINT'), terminate = (): void => forward('SIGTERM')
    process.once('SIGINT', interrupt); process.once('SIGTERM', terminate)
    const cleanup = (): void => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate) }
    child.on('error', error => { cleanup(); reject(error) })
    child.on('close', (code, signal) => { cleanup(); resolve(code ?? (signal === 'SIGINT' ? 130 : 143)) })
  })
}
function repositoryUrl(value: string): string {
  const url = new URL(value)
  if (!['https:', 'ssh:'].includes(url.protocol) || url.password || url.search || url.hash || url.protocol === 'https:' && url.username) throw new Error('Use an HTTPS or SSH repository URL without credentials')
  return value
}
export async function tuneDoor(args: string[], deps: TuneDoorDeps = {}): Promise<number> {
  const home = deps.home ?? join(getMercuryHome(), 'extensions', 'programs', 'mercury-tune')
  const run = deps.execute ?? execute
  let repository: string | undefined, update = false
  const forwarded = [...args]
  while (forwarded[0] === '--repository' || forwarded[0] === '--update') {
    if (forwarded.shift() === '--update') update = true
    else {
      const next = forwarded.shift()
      if (!next) throw new Error('Give --repository a Git URL')
      repository = repositoryUrl(next)
    }
  }
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const pointer = join(home, 'current.json'), versions = join(home, 'versions')
  const release = await lock(home, { retries: 0 })
  let current: z.infer<typeof pointerSchema> | undefined
  try {
    if (existsSync(pointer)) {
      current = pointerSchema.parse(JSON.parse(readFileSync(pointer, 'utf8')))
      if (dirname(resolve(current.root)) !== resolve(versions)) throw new Error('Invalid Tune installation path')
    }
    if (!current || update || repository && repository !== current.repository) {
      repository = repositoryUrl(repository ?? current?.repository ?? (() => { throw new Error('Install Tune with mercury tune --repository <git-url>') })())
      mkdirSync(versions, { recursive: true, mode: 0o700 })
      const staged = mkdtempSync(join(versions, 'build-'))
      try {
        for (const [command, argv] of [
          ['git', ['clone', '--depth', '1', '--', repository, staged]],
          ['bun', ['install', '--frozen-lockfile', '--ignore-scripts']],
          ['bun', ['run', 'build']],
        ] as [string, string[]][]) {
          if (await run(command, argv, staged, false) !== 0) throw new Error('Tune installation failed; the previous installation is unchanged')
        }
        const pkg = JSON.parse(readFileSync(join(staged, 'package.json'), 'utf8')) as { name?: string; bin?: Record<string, string> }
        if (pkg.name !== 'mercury-tune' || pkg.bin?.['mercury-tune'] !== 'bin/mercury-tune.mjs' || !existsSync(join(staged, 'dist', 'cli.mjs'))) throw new Error('The repository did not build mercury-tune')
        current = { root: staged, repository }
        publishAtomicSync(pointer, JSON.stringify(current) + '\n', { mode: 0o600 })
      } catch (error) { rmSync(staged, { recursive: true, force: true }); throw error }
    }
  } finally { await release() }
  return run(process.execPath, [join(current!.root, 'bin', 'mercury-tune.mjs'), ...forwarded], process.cwd(), true)
}
export function registerTuneDoor(program: import('commander').Command, finish: (code: number) => Promise<unknown>): void {
  program.command('tune [args...]').description(TUNE_DOOR_HELP)
    .option('--repository <git-url>', 'Install Tune from this repository')
    .option('--update', 'Update the installed Tune extension')
    .allowUnknownOption(true).passThroughOptions()
    .action(async (args: string[], options: { repository?: string; update?: boolean }) => {
      try { await finish(await tuneDoor([...(options.repository ? ['--repository', options.repository] : []), ...(options.update ? ['--update'] : []), ...args])) }
      catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); await finish(1) }
    })
}
