#!/usr/bin/env bun
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { switchCurrent } from '../../src/platform/update-channel/installLayout.ts'
import { removeScratch } from '../lib/removeScratch.ts'
import { stageInstall } from '../lib/stagedInstall.ts'
import { untilAsync } from '../lib/untilAsync.ts'

if (process.platform === 'win32') {
  console.log('prove-rollback-second-home-daemon: [SKIP] the staged release install is the POSIX one')
  process.exit(0)
}

const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'rb-')))
const NEXT_TREE = 'c3c3c3c3c3c3'
const staged = stageInstall('release', join(SCRATCH, 'h'))
const versionsDir = join(staged.home, 'versions')
const was = readFileSync(join(versionsDir, 'current.txt'), 'utf8').trim()
const next = was.replace(/(\d+)$/, patch => String(Number(patch) + 1))
const second = `${staged.home}2`
const project = join(SCRATCH, 'p')
for (const dir of [second, project, join(versionsDir, next)]) mkdirSync(dir)
writeFileSync(join(second, 'profile.json'), JSON.stringify({ first: staged.home, id: 2 }))

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

const first: NodeJS.ProcessEnv = staged.env
const other: NodeJS.ProcessEnv = { ...staged.env, MERCURY_CONFIG_DIR: second, MERCURY_VERSIONS_DIR: versionsDir }
const run = (env: NodeJS.ProcessEnv, args: string[]): { status: number | null; out: string } => {
  const child = spawnSync(staged.command, args, { cwd: project, env, encoding: 'utf8', timeout: 90_000 })
  return { status: child.status, out: `${child.stdout}${child.stderr}`.trim() }
}
const log = join(SCRATCH, 'second.log')
const logged = (): string => readFileSync(log, 'utf8')

let failures = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${ok ? '' : ` — ${detail} — fix screenIsOlder in src/daemon/control/handshake.ts: the installed build decides before the version word does`}`)
}

console.log('============================================================')
console.log(' after a rollback, a second home is told what is installed')
console.log('============================================================')
let daemon: ChildProcess | undefined
try {
  check(`the staged install runs v${next} with v${was} kept behind it`, run(first, ['--version']).out === `Mercury ${next}`, run(first, ['--version']).out)
  const fd = openSync(log, 'a')
  daemon = spawn(staged.command, ['daemon', 'run', project], { cwd: project, env: other, stdio: ['ignore', fd, fd], detached: true })
  const up = await untilAsync(() => run(other, ['daemon', 'status']).out.includes(`running · pid ${daemon?.pid} · v${next}`), 60_000, 500)
  check(`the second home's daemon is up on v${next}`, up, `${run(other, ['daemon', 'status']).out} · ${logged().slice(-300)}`)

  const rolled = run(first, ['update', '--rollback'])
  check(`the first home rolls back to v${was}`, rolled.status === 0 && rolled.out.includes(`rolled back: ${next} → ${was}`), rolled.out)
  await untilAsync(() => logged().includes(wasTree), 15_000)
  check('the second home\'s daemon logs the build the install moved back to', logged().includes(wasTree), logged().slice(-400))

  const status = run(other, ['daemon', 'status'])
  console.log(status.out.split('\n').map(line => `    | ${line}`).join('\n'))
  check(`a new start under the second home, v${was}, is not told that it is not the installed build`, status.status === 0 && !status.out.includes('not the installed build'), status.out)
  const restart = run(other, ['daemon', 'restart'])
  console.log(restart.out.split('\n').map(line => `    | ${line}`).join('\n'))
  check(`its daemon restart does not call v${next} installed`, !restart.out.includes(`v${next} is installed`), restart.out)
  check(`its daemon restart lands the daemon on v${was}`, restart.status === 0 && restart.out.includes(`v${was}`), `exit ${restart.status}: ${restart.out}`)
  const after = run(other, ['daemon', 'status'])
  console.log(after.out.split('\n').map(line => `    | ${line}`).join('\n'))
  check(`the daemon that answers afterwards is v${was}`, after.out.includes(`v${was}`) && !after.out.includes(`v${next}`), after.out)
} finally {
  for (const env of [first, other]) run(env, ['daemon', 'stop'])
  daemon?.kill('SIGKILL')
  removeScratch(SCRATCH)
}

console.log(failures === 0 ? '\nprove-rollback-second-home-daemon: ALL HOLD' : `\nprove-rollback-second-home-daemon: ${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
