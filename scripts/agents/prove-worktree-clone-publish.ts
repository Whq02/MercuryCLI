#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { cloneRoadExpected, volumeClones } from '../lib/cloneRoad.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_WORKTREE_CLONE
const ROOT = realpathSync(join(import.meta.dir, '..', '..'))
process.chdir(ROOT)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const skip = (label: string): void => console.log(`  [SKIP] ${label}`)
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const state = await import('../../src/bootstrap/state.ts')
const config = await import('../../src/utils/config/globalConfig.ts')
const { cleanupStaleAgentWorktrees, createAgentWorktree } = await import('../../src/utils/worktree.ts')
const { ensureWorkerWorktree, reapWorkerWorktree } = await import('../../src/daemon/concourseWorktrees.ts')
const { crewLeftoverWorktrees } = await import('../../src/utils/crew/crewWorktreeReminder.ts')

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-clone-publish-')))
const hold = join(scratch, 'hold')
const pathBefore = process.env.PATH ?? ''
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim()
const registered = (repo: string): string[] => git(repo, 'worktree', 'list', '--porcelain').split('\n').filter(line => line.startsWith('worktree ')).map(line => line.slice('worktree '.length))
const present = (path: string): boolean => {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}
const read = (path: string): string => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return '<absent>'
  }
}
const staged = (home: string): string[] => (existsSync(home) ? readdirSync(home).filter(name => name.startsWith('.cloning-')) : [])
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const until = async (cond: () => boolean, ms = 60_000): Promise<boolean> => {
  const end = Date.now() + ms
  while (!cond() && Date.now() < end) await wait(25)
  return cond()
}
const hoursAgo = (hours: number): Date => new Date(Date.now() - hours * 60 * 60 * 1000)
const listing = (root: string): string[] => {
  const rows: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isSymbolicLink()) rows.push(`${rel} -> ${readlinkSync(join(dir, entry.name))}`)
      else if (entry.isDirectory()) {
        rows.push(`${rel}/`)
        walk(join(dir, entry.name), rel)
      } else rows.push(`${rel} ${statSync(join(dir, entry.name)).size}`)
    }
  }
  if (present(root)) walk(root, '')
  return rows
}
const capture = (): { stop: () => string } => {
  const out = process.stdout.write.bind(process.stdout)
  const err = process.stderr.write.bind(process.stderr)
  let printed = ''
  process.stdout.write = ((chunk: unknown) => ((printed += String(chunk)), true)) as typeof process.stdout.write
  process.stderr.write = ((chunk: unknown) => ((printed += String(chunk)), true)) as typeof process.stderr.write
  return {
    stop: () => {
      process.stdout.write = out
      process.stderr.write = err
      return printed
    },
  }
}
const enter = (dir: string): void => {
  process.chdir(dir)
  state.setOriginalCwd(dir)
  state.setCwdState(dir)
}
const release = (): void => writeFileSync(join(hold, 'release'), '')
const rearm = (): void => {
  rmSync(join(hold, 'paused'), { force: true })
  rmSync(join(hold, 'release'), { force: true })
}

const fixture = join(scratch, 'fixture')
const home = join(fixture, '.mercury', 'worktrees')
mkdirSync(hold)
mkdirSync(fixture)
git(fixture, 'init', '-q', '-b', 'main')
for (const [name, body] of Object.entries({ '.gitignore': 'node_modules/\nvendor/*/\n.mercury/worktrees/\n', 'package.json': '{"name":"publish-fixture"}', 'vendor/pack-a.lock.json': '{}\n' })) {
  mkdirSync(dirname(join(fixture, name)), { recursive: true })
  writeFileSync(join(fixture, name), body)
}
git(fixture, 'add', '-A')
git(fixture, 'commit', '-q', '-m', 'first')
for (let pkg = 0; pkg < 6; pkg++) {
  mkdirSync(join(fixture, 'node_modules', `pkg-${pkg}`, 'lib'), { recursive: true })
  for (let index = 0; index < 10; index++) writeFileSync(join(fixture, 'node_modules', `pkg-${pkg}`, 'lib', `m${index}.js`), Buffer.alloc(700, 'd'))
}
mkdirSync(join(fixture, 'node_modules', '.bin'))
symlinkSync('../pkg-0/lib/m0.js', join(fixture, 'node_modules', '.bin', 'tool'))
mkdirSync(join(fixture, 'vendor', 'pack-a'))
writeFileSync(join(fixture, 'vendor', 'pack-a', 'marker'), 'pack\n')
const whole = listing(join(fixture, 'node_modules'))
enter(fixture)
state.setIsInteractive(true)
config.enableConfigs()

try {
  if (!(volumeClones(scratch) && process.platform !== 'win32')) {
    section('§1 a volume that cannot clone: nothing is ever cloned beside a copy')
    skip("the proof's runtime cannot force a clone of one file here: the folders are linked as before and there is nothing to move into place")
    const linked = await createAgentWorktree('agent-ad100001')
    check('the copy holds the link and nothing stands beside it', lstatSync(join(linked.worktreePath, 'node_modules')).isSymbolicLink() && staged(home).length === 0, staged(home).join(', '))
  } else {
    const realCp = execFileSync('sh', ['-c', 'command -v cp'], { encoding: 'utf8' }).trim()
    const shims = join(scratch, 'shims')
    mkdirSync(shims)
    writeFileSync(
      join(shims, 'cp'),
      [
        '#!/bin/bash',
        'if [ "$1" = "--reflink=always" ] && [ "$2" = "--version" ]; then exit 0; fi',
        '[ "$1 $2 $3 $4" = "-a --reflink=always -T --" ] || exit 64',
        process.platform === 'darwin' ? `${realCp} -c -R -p "$5/." "$6/" || exit 1` : `${realCp} "$@" || exit 1`,
        `case "$5" in */node_modules) : > ${JSON.stringify(join(hold, 'paused'))}; while [ ! -e ${JSON.stringify(join(hold, 'release'))} ]; do sleep 0.05; done ;; esac`,
        'exit 0',
        '',
      ].join('\n'),
    )
    chmodSync(join(shims, 'cp'), 0o755)
    process.env.MERCURY_WORKTREE_CLONE = 'cp'
    process.env.PATH = `${shims}:${pathBefore}`

    section('§1 while a folder is being cloned it stands beside the copy, and is moved in whole')
    const quietDuring = capture()
    const creating = createAgentWorktree('agent-ad100001')
    const paused = await until(() => existsSync(join(hold, 'paused')))
    const printedDuring = quietDuring.stop()
    const copy = join(home, 'agent-ad100001')
    const besideNow = staged(home)
    check('the clone is under way', paused)
    check('the copy stands, with no node_modules at its own name yet', present(join(copy, 'package.json')) && !present(join(copy, 'node_modules')), listing(join(copy, 'node_modules')).length + ' entries there')
    check('the folder stands whole in one folder beside the copy, named .cloning- and the copy\'s name', besideNow.length === 1 && besideNow[0]!.startsWith('.cloning-agent-ad100001-') && JSON.stringify(listing(join(home, besideNow[0]!, '0'))) === JSON.stringify(whole), besideNow.join(', '))
    check('git status of the project is clean meanwhile, as it is for the worktrees themselves', git(fixture, 'status', '--porcelain') === '', git(fixture, 'status', '--porcelain'))
    check('git lists the checkout and the copy and nothing else', JSON.stringify(registered(fixture)) === JSON.stringify([fixture, copy]), registered(fixture).join(' | '))
    const quietAfter = capture()
    release()
    const made = await creating
    const printedAfter = quietAfter.stop()
    check('when the clone ends the folder is the copy\'s own, whole', made.worktreePath === copy && lstatSync(join(copy, 'node_modules')).isDirectory() && JSON.stringify(listing(join(copy, 'node_modules'))) === JSON.stringify(whole))
    check('…and nothing is left beside the copy', staged(home).length === 0, staged(home).join(', '))
    check('nothing is printed, while it runs or when it ends', printedDuring === '' && printedAfter === '', JSON.stringify((printedDuring + printedAfter).slice(0, 200)))
    rearm()

    section('§2 moving the folder in replaces nothing but an empty folder')
    const racing = createAgentWorktree('agent-ad200001')
    await until(() => existsSync(join(hold, 'paused')))
    const taken = join(home, 'agent-ad200001', 'node_modules')
    mkdirSync(taken, { recursive: true })
    writeFileSync(join(taken, 'mine'), 'made meanwhile\n')
    release()
    const raced = await racing
    check('a folder that took the name while the clone ran is left as it is', JSON.stringify(readdirSync(taken)) === JSON.stringify(['mine']) && read(join(taken, 'mine')) === 'made meanwhile\n', readdirSync(taken).join(', '))
    check('…the clone is dropped, nothing is left beside the copy and the launch has no failure to report', staged(home).length === 0 && raced.prepareFailure === undefined, staged(home).join(', '))
    rearm()
    const overEmpty = createAgentWorktree('agent-ad200002')
    await until(() => existsSync(join(hold, 'paused')))
    mkdirSync(join(home, 'agent-ad200002', 'node_modules'), { recursive: true })
    release()
    await overEmpty
    check('an empty folder at the name gives way to the clone', JSON.stringify(listing(join(home, 'agent-ad200002', 'node_modules'))) === JSON.stringify(whole))
    rearm()

    section('§3 a process killed while it clones leaves no half folder in the copy, and what it leaves beside it is swept')
    const childScript = join(scratch, 'child.ts')
    writeFileSync(
      childScript,
      [
        ';(globalThis as Record<string, unknown>).MACRO = { VERSION: \'1.0.0\' }',
        'process.env.NODE_ENV = \'test\'',
        `const state = await import(${JSON.stringify(join(ROOT, 'src/bootstrap/state.ts'))})`,
        `const config = await import(${JSON.stringify(join(ROOT, 'src/utils/config/globalConfig.ts'))})`,
        `const { createAgentWorktree } = await import(${JSON.stringify(join(ROOT, 'src/utils/worktree.ts'))})`,
        'const fixture = process.argv[2] as string',
        'process.chdir(fixture)',
        'state.setOriginalCwd(fixture)',
        'state.setCwdState(fixture)',
        'state.setIsInteractive(true)',
        'config.enableConfigs()',
        'await createAgentWorktree(process.argv[3] as string)',
        '',
      ].join('\n'),
    )
    const childHome = join(scratch, 'child-home')
    mkdirSync(join(childHome, 'tmp'), { recursive: true })
    const child = spawn(process.execPath, [childScript, fixture, 'agent-ad300001'], {
      cwd: ROOT,
      stdio: 'ignore',
      env: { ...process.env, HOME: childHome, USERPROFILE: childHome, MERCURY_CONFIG_DIR: childHome, MERCURY_CREDENTIAL_STORE: 'file', MERCURY_DESKTOP_DRIVER: 'none' },
    })
    const childExit = new Promise<void>(resolve => child.on('exit', () => resolve()))
    const reached = await until(() => existsSync(join(hold, 'paused')))
    child.kill('SIGKILL')
    await childExit
    release()
    await wait(400)
    const killedCopy = join(home, 'agent-ad300001')
    const left = staged(home)
    check('the process is killed while its clone is under way', reached)
    check('the copy stands without a node_modules: not half of one, not a whole one nobody finished', present(join(killedCopy, 'package.json')) && !present(join(killedCopy, 'node_modules')), listing(join(killedCopy, 'node_modules')).length + ' entries there')
    check('what it had cloned is left beside the copy under its own name', left.length === 1 && left[0]!.startsWith('.cloning-agent-ad300001-'), left.join(', '))
    check('git lists nothing of it as a worktree', !registered(fixture).some(path => path.includes('.cloning-')), registered(fixture).join(' | '))
    const leftovers = await crewLeftoverWorktrees(fixture, Date.now())
    check('the crew\'s list of leftover worktrees does not name it', !leftovers.some(row => row.path.includes('.cloning-')), leftovers.map(row => row.path).join(' | '))
    check('git status of the project is clean while it stands there', git(fixture, 'status', '--porcelain') === '', git(fixture, 'status', '--porcelain'))
    const outside = join(scratch, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'keep.txt'), 'outside the tree\n')
    const old = join(home, `.cloning-agent-ad300009-1-${Date.now().toString(36)}0`)
    mkdirSync(join(old, '0', 'pkg', 'sealed'), { recursive: true })
    writeFileSync(join(old, '0', 'pkg', 'sealed', 'file'), 'x\n')
    symlinkSync(outside, join(old, '0', 'link-out-of-the-tree'))
    if (process.getuid?.() !== 0) chmodSync(join(old, '0', 'pkg', 'sealed'), 0o555)
    await cleanupStaleAgentWorktrees(hoursAgo(8 * 24))
    check('inside its first hour the janitor leaves such a folder alone', present(old) && left.every(name => present(join(home, name))))
    utimesSync(old, hoursAgo(2), hoursAgo(2))
    for (const name of left) utimesSync(join(home, name), hoursAgo(2), hoursAgo(2))
    await cleanupStaleAgentWorktrees(hoursAgo(8 * 24))
    check('an hour on the janitor sweeps it, a read-only folder inside it included', await until(() => !present(old)), listing(old).join(' | '))
    check('…and what the killed process left with it', await until(() => staged(home).length === 0), staged(home).join(', '))
    check('…never through a link: the folder a link in it named is whole', read(join(outside, 'keep.txt')) === 'outside the tree\n')
    check('the copies made before are untouched by the sweep', JSON.stringify(listing(join(copy, 'node_modules'))) === JSON.stringify(whole))
    rearm()

    section('§4 the daemon\'s home is swept the same way at its next reap')
    const daemonHome = join(scratch, 'daemon')
    const workerHome = join(daemonHome, 'worktrees')
    mkdirSync(daemonHome)
    release()
    const worker = await ensureWorkerWorktree(fixture, 'runner-publish', daemonHome)
    rearm()
    check('a worker worktree is made with its folder its own and nothing left beside it', worker.ok === true && lstatSync(join(worker.ok ? worker.path : '', 'node_modules')).isDirectory() && staged(workerHome).length === 0, JSON.stringify(worker))
    const diedThere = join(workerHome, `.cloning-runner-gone-1-${Date.now().toString(36)}0`)
    mkdirSync(join(diedThere, '0'), { recursive: true })
    utimesSync(diedThere, hoursAgo(2), hoursAgo(2))
    const reaped = reapWorkerWorktree(fixture, 'runner-publish', daemonHome)
    check('the reap answers reaped and sweeps what a clone that died there left', reaped.outcome === 'reaped' && (await until(() => !present(diedThere))), JSON.stringify(reaped))

    section('§5 on the platform\'s own road, and with no clone at all, nothing is left beside a copy')
    process.env.PATH = pathBefore
    delete process.env.MERCURY_WORKTREE_CLONE
    const own = await createAgentWorktree('agent-ad500001')
    check('the platform\'s own road leaves the folder in the copy and nothing beside it', (cloneRoadExpected(scratch) ? lstatSync(join(own.worktreePath, 'node_modules')).isDirectory() : lstatSync(join(own.worktreePath, 'node_modules')).isSymbolicLink()) && staged(home).length === 0, staged(home).join(', '))
    process.env.MERCURY_WORKTREE_CLONE = 'off'
    const off = await createAgentWorktree('agent-ad500002')
    delete process.env.MERCURY_WORKTREE_CLONE
    check('MERCURY_WORKTREE_CLONE=off makes the link and stages nothing', lstatSync(join(off.worktreePath, 'node_modules')).isSymbolicLink() && staged(home).length === 0)
  }
} finally {
  release()
  process.env.PATH = pathBefore
  delete process.env.MERCURY_WORKTREE_CLONE
  enter(ROOT)
  await wait(200)
  if (process.platform !== 'win32') execFileSync('chmod', ['-R', 'u+rwx', scratch])
  rmSync(scratch, { recursive: true, force: true })
}
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
