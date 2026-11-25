import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { switchCurrent } from '../../src/platform/update-channel/installLayout.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import { stageInstall } from '../lib/stagedInstall.ts'
import { untilAsync } from '../lib/untilAsync.ts'

const NEXT_TREE = 'c3c3c3c3c3c3'

export type OtherHome = { dir: string; log: string; env: NodeJS.ProcessEnv }
type Said = { status: number | null; out: string }

export type RollbackScene = {
  was: string
  next: string
  project: string
  command: string
  otherHome(id: number, login?: NodeJS.ProcessEnv): OtherHome
  run(env: NodeJS.ProcessEnv, args: string[]): Said
  runningNext(homes: OtherHome[]): Promise<{ ok: boolean; detail: string }>
  rollBack(homes: OtherHome[]): Promise<{ said: Said; logged: boolean; detail: string }>
  end(): void
}

export function stageRollbackScene(): RollbackScene {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'rb-')))
  const staged = stageInstall('release', join(scratch, 'h'))
  const versionsDir = join(staged.home, 'versions')
  const was = readFileSync(join(versionsDir, 'current.txt'), 'utf8').trim()
  const next = was.replace(/(\d+)$/, patch => String(Number(patch) + 1))
  const project = join(scratch, 'p')
  for (const dir of [project, join(versionsDir, next)]) mkdirSync(dir)
  for (const name of readdirSync(join(versionsDir, was))) {
    const from = join(versionsDir, was, name)
    const to = join(versionsDir, next, name)
    if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), to)
    else if (name === 'mercury.mjs') writeFileSync(to, readFileSync(from, 'utf8').replaceAll(`VERSION:"${was}"`, `VERSION:"${next}"`))
    else copyFileSync(from, to, constants.COPYFILE_FICLONE)
  }
  const manifest = JSON.parse(readFileSync(join(versionsDir, next, 'manifest.json'), 'utf8')) as { buildTree: string }
  const wasTree = manifest.buildTree.slice(0, 12)
  writeFileSync(join(versionsDir, next, 'manifest.json'), JSON.stringify({ ...manifest, version: next, buildTree: NEXT_TREE + manifest.buildTree.slice(NEXT_TREE.length) }))
  switchCurrent({ versionsDir, binDir: staged.bin, shimPath: staged.command, isWindows: false }, next)

  const daemons: ChildProcess[] = []
  const homes: OtherHome[] = []
  const run = (env: NodeJS.ProcessEnv, args: string[]): Said => {
    const child = spawnSync(staged.command, args, { cwd: project, env, encoding: 'utf8', timeout: 90_000 })
    return { status: child.status, out: `${child.stdout}${child.stderr}`.trim() }
  }
  const logged = (home: OtherHome): string => readFileSync(home.log, 'utf8')
  return {
    was,
    next,
    project,
    command: staged.command,
    run,
    otherHome(id, login = {}) {
      const dir = `${staged.home}${id}`
      mkdirSync(dir)
      writeFileSync(join(dir, 'profile.json'), JSON.stringify({ first: staged.home, id }))
      const home = { dir, log: join(scratch, `home${id}.log`), env: { ...staged.env, ...login, MERCURY_CONFIG_DIR: dir, MERCURY_VERSIONS_DIR: versionsDir } }
      homes.push(home)
      return home
    },
    async runningNext(theirs) {
      const started = theirs.map(home => {
        const fd = openSync(home.log, 'a')
        const daemon = spawn(staged.command, ['daemon', 'run', project], { cwd: project, env: home.env, stdio: ['ignore', fd, fd], detached: true })
        daemons.push(daemon)
        return { home, daemon }
      })
      const ok = run(staged.env, ['--version']).out === `Mercury ${next}` && (await untilAsync(() => started.every(({ home, daemon }) => run(home.env, ['daemon', 'status']).out.includes(`running · pid ${daemon.pid} · v${next}`)), 60_000, 500))
      return { ok, detail: started.map(({ home }) => `${run(home.env, ['daemon', 'status']).out} · ${logged(home).slice(-300)}`).join(' · ') }
    },
    async rollBack(theirs) {
      const said = run(staged.env, ['update', '--rollback'])
      await untilAsync(() => theirs.every(home => logged(home).includes(wasTree)), 15_000)
      return { said, logged: theirs.every(home => logged(home).includes(wasTree)), detail: theirs.map(home => logged(home).slice(-400)).join(' · ') }
    },
    end() {
      for (const env of [staged.env, ...homes.map(home => home.env)]) run(env, ['daemon', 'stop'])
      for (const daemon of daemons) daemon.kill('SIGKILL')
      removeScratch(scratch)
    },
  }
}
