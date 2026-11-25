#!/usr/bin/env bun
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'
import { stageInstall } from '../lib/stagedInstall.ts'
import { untilAsync } from '../lib/untilAsync.ts'

if (process.platform === 'win32') {
  console.log('prove-profile-daemon-follows-deploy: [SKIP] the source deploy is a POSIX install')
  process.exit(0)
}

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'pd-')))
const NEXT = 'b2b2b2b2b2b2'
const staged = stageInstall('source', join(SCRATCH, 'h'))
const second = `${staged.home}2`
const project = join(SCRATCH, 'p')
const runtime = join(staged.home, 'runtime')
for (const dir of [second, project]) mkdirSync(dir)
writeFileSync(join(second, 'profile.json'), JSON.stringify({ first: staged.home, id: 2 }))

const was = join(runtime, 'builds', 'staged')
const next = join(runtime, 'builds', 'next')
mkdirSync(next)
for (const name of readdirSync(was)) {
  if (lstatSync(join(was, name)).isSymbolicLink()) symlinkSync(readlinkSync(join(was, name)), join(next, name))
  else copyFileSync(join(was, name), join(next, name), constants.COPYFILE_FICLONE)
}
const manifest = JSON.parse(readFileSync(join(next, 'manifest.json'), 'utf8')) as { buildTree: string }
writeFileSync(join(next, 'manifest.json'), JSON.stringify({ ...manifest, buildTree: NEXT + manifest.buildTree.slice(NEXT.length) }))

type Home = { name: string; dir: string; log: string; env: NodeJS.ProcessEnv }
const homes: Home[] = [
  { name: 'Profile 1', dir: staged.home, log: join(SCRATCH, 'first.log'), env: staged.env },
  { name: 'profile 2', dir: second, log: join(SCRATCH, 'second.log'), env: { ...staged.env, MERCURY_CONFIG_DIR: second, MERCURY_DIST: staged.bundle } },
]
const verb = (home: Home, word: string): string => spawnSync(staged.command, ['daemon', word], { cwd: project, env: home.env, encoding: 'utf8', timeout: 60_000 }).stdout
const said = (home: Home): string => verb(home, 'status').trimEnd().split('\n').at(-1)?.trim() ?? ''
const logged = (home: Home): string => readFileSync(home.log, 'utf8')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail} — fix programHome in src/platform/profiles/profiles.ts, or its use by the home defaults of src/daemon/control/handover.ts and the installed-build watch of src/daemon/run/heal.ts`}`)
}

console.log('============================================================')
console.log(' a second profile\'s daemon follows a source deploy as Profile 1\'s does')
console.log('============================================================')
const daemons: ChildProcess[] = []
try {
  for (const home of homes) {
    const log = openSync(home.log, 'a')
    daemons.push(spawn(staged.command, ['daemon', 'run', project], { cwd: project, env: home.env, stdio: ['ignore', log, log], detached: true }))
  }
  const up = await untilAsync(() => homes.every(home => existsSync(join(home.dir, 'daemon', 'control.sock'))), 60_000)
  check('each home runs its own daemon', up, homes.map(home => `${home.name}: ${logged(home).slice(-300)}`).join(' · '))
  const before = homes.map(said)
  check('before the deploy a new start says the same of both daemons', before[0] !== '' && before[0] === before[1], JSON.stringify(before))

  symlinkSync(join('builds', 'next'), join(runtime, 'current.new'))
  renameSync(join(runtime, 'current.new'), join(runtime, 'current'))
  await untilAsync(() => homes.every(home => logged(home).includes(NEXT)), 15_000)
  for (const home of homes) check(`${home.name}'s daemon logs the build the install moved to`, logged(home).includes(NEXT), logged(home).slice(-400))
  const after = homes.map(said)
  check('a new start is the new build and says so of Profile 1\'s daemon', after[0] !== before[0] && (after[0] ?? '').includes(NEXT), JSON.stringify(after))
  check('a new start under profile 2 orders the builds as Profile 1\'s does', after[1] === after[0], JSON.stringify(after))
} finally {
  for (const home of homes) verb(home, 'stop')
  for (const daemon of daemons) {
    try {
      if (daemon.pid !== undefined) process.kill(-daemon.pid, 'SIGKILL')
    } catch {
      continue
    }
  }
  removeScratch(SCRATCH)
}

console.log(failures === 0 ? '\nprove-profile-daemon-follows-deploy: ALL HOLD' : `\nprove-profile-daemon-follows-deploy: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
