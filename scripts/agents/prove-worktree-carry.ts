#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { contentShared, volumeClones } from '../lib/cloneRoad.ts'

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
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const scenario = process.argv[2]
if (scenario !== undefined && process.env.CARRY_SCENARIO_HOME !== undefined) process.env.MERCURY_CONFIG_DIR = process.env.CARRY_SCENARIO_HOME
const state = await import('../../src/bootstrap/state.ts')
const config = await import('../../src/utils/config/globalConfig.ts')
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const worktree = await import('../../src/utils/worktree.ts')
const instructions = await import('../../src/services/instructions/engine.ts')
const cloneModule = (await import('../../src/utils/worktreeClone.ts')) as unknown as { planCloneCalls: (source: string, held?: (path: string) => boolean, leaveOut?: boolean) => Promise<{ folders: string[]; clones: string[]; links: string[] }> }
type Made = { worktreePath: string; prepareFailure?: string; ready?: Promise<void> }
const make = (slug: string, options: Record<string, unknown> = {}): Promise<Made> => (worktree.createAgentWorktree as (slug: string, options: unknown) => Promise<Made>)(slug, options)
const prepare = worktree.prepareWorktreeFiles as (repo: string, path: string, from?: string, preserve?: boolean, permission?: unknown, carry?: boolean) => Promise<void>

if (scenario !== undefined) {
  const dir = process.argv[3] as string
  process.chdir(dir)
  state.setOriginalCwd(dir)
  state.setCwdState(dir)
  state.setIsInteractive(true)
  config.enableConfigs()
  const composed = process.env.CARRY_SCENARIO_LOADS === '1' ? (await instructions.getInstructionFiles(), instructions.getInstructionCompositionState().fallbackComposed) : undefined
  const copy = (await make('agent-ad900001')).worktreePath
  const kind = (rel: string): string => {
    try {
      const entry = lstatSync(join(copy, rel))
      return entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'folder' : 'file'
    } catch {
      return 'absent'
    }
  }
  console.log('RESULT ' + JSON.stringify({ ...Object.fromEntries(process.argv.slice(4).map(rel => [rel, kind(rel)])), ...(composed === undefined ? {} : { 'other tools composed': String(composed) }) }))
  process.exit(0)
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-carry-')))
const outside = join(scratch, 'outside')
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const kindOf = (path: string): string => {
  try {
    const entry = lstatSync(path)
    return entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'folder' : 'file'
  } catch {
    return 'absent'
  }
}
const read = (path: string): string => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return '<absent>'
  }
}
const enter = (dir: string): void => {
  process.chdir(dir)
  state.setOriginalCwd(dir)
  state.setCwdState(dir)
  resetSettingsCache()
}
const adminOf = (path: string): string => resolve(path, readFileSync(join(path, '.git'), 'utf8').trim().slice('gitdir:'.length).trim())
const recorded = (path: string): string[] => read(join(adminOf(path), 'WORKTREE_CLONES')).split('\n').filter(line => line !== '' && line !== '<absent>').sort()
const IGNORES = ['node_modules/', 'dist/', '*.log', '.env', '.env.production', '__pycache__/', '.venv/', 'build/', 'cache/', 'other-trees/', 'top-tree/', 'linked-out', 'linked-in', '.mercury/', 'MERCURY.local.md', 'AGENTS.md']
const CARRIED: Record<string, string> = {
  'dist/app.js': 'built\n',
  'dist/sub/chunk.js': 'chunk\n',
  'src/pkg/__pycache__/mod.cpython.pyc': 'bytecode\n',
  'run.log': 'a line\n',
  'src/pkg/debug.log': 'debug\n',
  'reports/run.log': 'report\n',
  '.env': 'TOKEN=1\n',
  'cache/keep/data.bin': 'kept\n',
  'other-trees/plain/file.txt': 'plain\n',
}
const BEHIND = ['.venv', 'build', 'cache/cmake-out', 'other-trees/wt', 'top-tree', 'dist/secret', '.env.production', '.mercury/worktrees', '.mercury/settings.json', 'MERCURY.local.md', 'src/pkg/MERCURY.local.md', 'AGENTS.md', 'cache/keep/MERCURY.md']

const makeFixture = (name: string, settings: (dir: string) => Record<string, unknown>, more: string[] = []): string => {
  const dir = join(scratch, name)
  mkdirSync(join(dir, 'src', 'pkg'), { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, '.gitignore'), [...IGNORES, ...more, ''].join('\n'))
  writeFileSync(join(dir, 'package.json'), `{"name":"${name}"}\n`)
  writeFileSync(join(dir, 'src', 'pkg', 'mod.py'), 'value = 1\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'first')
  writeFileSync(join(dir, 'src', 'pkg', 'mod.py'), 'value = 2\n')
  git(dir, 'commit', '-q', '-am', 'second')
  for (const [file, body] of Object.entries({
    ...CARRIED,
    'node_modules/dep/index.js': 'module.exports = 1\n',
    'dist/secret/key.txt': 'the key\n',
    '.env.production': 'TOKEN=live\n',
    '.venv/pyvenv.cfg': 'home = /somewhere\n',
    '.venv/bin/python': 'binary\n',
    'build/CMakeCache.txt': 'CMAKE_HOME_DIRECTORY:INTERNAL=/somewhere\n',
    'build/obj.o': 'object\n',
    'cache/cmake-out/CMakeCache.txt': 'CMAKE_HOME_DIRECTORY:INTERNAL=/somewhere\n',
    'cache/cmake-out/obj.o': 'object\n',
    'other-trees/wt/.git': 'gitdir: /nowhere/.git/worktrees/wt\n',
    'other-trees/wt/file.txt': 'another tree\n',
    'top-tree/.git': 'gitdir: /nowhere/.git/worktrees/top-tree\n',
    'top-tree/file.txt': 'another tree at the top\n',
    'MERCURY.local.md': 'private instructions for this project\n',
    'cache/keep/MERCURY.md': 'instructions that lie inside an ignored folder\n',
    'src/pkg/MERCURY.local.md': 'private instructions for this folder\n',
    'AGENTS.md': 'instructions another tool reads, kept out of git here\n',
    '.mercury/settings.local.json': '{}\n',
    '.mercury/settings.json': JSON.stringify(settings(dir)),
  })) {
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), body)
  }
  mkdirSync(join(dir, 'node_modules', '.bin'))
  symlinkSync('../dep/index.js', join(dir, 'node_modules', '.bin', 'tool'))
  symlinkSync(join(outside, 'target.txt'), join(dir, 'linked-out'))
  symlinkSync('src/pkg/mod.py', join(dir, 'linked-in'))
  return dir
}
const denying = (dir: string): Record<string, unknown> => ({ guardrails: { deny: [`Read(/${dir}/dist/secret/**)`, `Read(/${dir}/.env.production)`] } })
const carriedAll = (copy: string): string[] => Object.entries(CARRIED).filter(([file, body]) => read(join(copy, file)) !== body).map(([file]) => file)
const behindAll = (copy: string): string[] => BEHIND.filter(rel => kindOf(join(copy, rel)) !== 'absent')

try {
  mkdirSync(outside)
  writeFileSync(join(outside, 'target.txt'), 'outside the checkout\n')
  state.setIsInteractive(true)
  config.enableConfigs()
  const cloning = volumeClones(scratch) && process.platform !== 'win32'
  const fixture = makeFixture('carry', denying)
  enter(fixture)

  if (!cloning) {
    section('a volume that cannot clone: nothing git ignores is carried, the folders are linked as before')
    skip("the proof's runtime cannot force a clone of one file here: there is nothing to carry with")
    const linked = await make('agent-ad000001')
    check('the dependency folder is the link, and no ignored build output or file came along', kindOf(join(linked.worktreePath, 'node_modules')) === 'link' && carriedAll(linked.worktreePath).length === Object.keys(CARRIED).length, carriedAll(linked.worktreePath).join(', '))
  } else {
    section('§1 a copy that stands on the commit its checkout is on starts with what git ignores there')
    const made = await make('agent-ad100001')
    const copy = made.worktreePath
    check('every ignored folder and file is there with its content: build output, a cache beside tracked code, logs, an .env file', carriedAll(copy).length === 0, carriedAll(copy).join(', '))
    check('each is the copy\'s own: a write there does not reach the checkout', (() => {
      if (kindOf(join(copy, 'dist', 'app.js')) !== 'file' || kindOf(join(copy, '.env')) !== 'file') return false
      writeFileSync(join(copy, 'dist', 'app.js'), 'rebuilt in the copy\n')
      writeFileSync(join(copy, '.env'), 'TOKEN=copy\n')
      return read(join(fixture, 'dist', 'app.js')) === 'built\n' && read(join(fixture, '.env')) === 'TOKEN=1\n'
    })())
    const shared = contentShared([[join(fixture, 'dist', 'sub', 'chunk.js'), join(copy, 'dist', 'sub', 'chunk.js')], [join(fixture, 'run.log'), join(copy, 'run.log')]])
    if (shared === null) skip('APFS is not asked here whether a carried file shares its blocks with the checkout\'s')
    else check('a carried file shares its blocks with the checkout\'s: a clone, not a copy of bytes', shared.every(Boolean), JSON.stringify(shared))
    check('git sees nothing to commit in the copy, and calls what came ignored', git(copy, 'status', '--porcelain') === '' && ['!! dist/', '!! .env', '!! run.log', '!! cache/'].every(row => git(copy, 'status', '--porcelain', '--ignored').split('\n').includes(row)), git(copy, 'status', '--porcelain', '--ignored').slice(0, 300))
    check('a Python environment and a CMake build folder stay behind, at the top and inside a carried folder', ['.venv', 'build', 'cache/cmake-out'].every(rel => kindOf(join(copy, rel)) === 'absent') && read(join(copy, 'cache', 'keep', 'data.bin')) === 'kept\n', behindAll(copy).join(', '))
    check('a folder that is another git worktree (its .git a pointer) stays behind at the top of the checkout', kindOf(join(copy, 'top-tree')) === 'absent', kindOf(join(copy, 'top-tree')))
    check('…and inside a carried folder, where the folder beside it comes', kindOf(join(copy, 'other-trees', 'wt')) === 'absent' && read(join(copy, 'other-trees', 'plain', 'file.txt')) === 'plain\n', kindOf(join(copy, 'other-trees', 'wt')))
    check('what a Read deny rule names where it lies in the checkout is not carried: a folder inside build output, a file at the top', kindOf(join(copy, 'dist', 'secret')) === 'absent' && kindOf(join(copy, '.env.production')) === 'absent', `${kindOf(join(copy, 'dist', 'secret'))}, ${kindOf(join(copy, '.env.production'))}`)
    check('Mercury\'s own folder is never carried: the copy holds its local settings and nothing else of it', readdirSync(join(copy, '.mercury')).join(',') === 'settings.local.json', readdirSync(join(copy, '.mercury')).join(','))
    check('an ignored instruction file is not carried, at the top, beside tracked code or inside a carried folder', ['MERCURY.local.md', 'src/pkg/MERCURY.local.md', 'AGENTS.md', 'cache/keep/MERCURY.md'].every(rel => kindOf(join(copy, rel)) === 'absent' && kindOf(join(fixture, rel)) === 'file'), ['MERCURY.local.md', 'src/pkg/MERCURY.local.md', 'AGENTS.md', 'cache/keep/MERCURY.md'].map(rel => kindOf(join(copy, rel))).join(', '))
    enter(copy)
    instructions.clearInstructionFileCaches()
    const composed = (await instructions.getInstructionFiles()) as Array<{ path: string; content: string }>
    const dropped = instructions.getInstructionCompositionState().skippedDuplicates.map(entry => entry.path)
    enter(fixture)
    instructions.clearInstructionFileCaches()
    const privately = composed.filter(entry => entry.content.includes('private instructions for this project'))
    check('a session in the copy reads the checkout\'s MERCURY.local.md once, from the checkout, as before', privately.length === 1 && realpathSync((privately[0] as { path: string }).path) === realpathSync(join(fixture, 'MERCURY.local.md')), privately.map(entry => entry.path).join(', '))
    check('…and meets no second copy of it to drop', dropped.length === 0, dropped.join(', '))
    check('an ignored link out of the checkout comes as a link to the same place, and nothing of that place is copied', kindOf(join(copy, 'linked-out')) === 'link' && realpathSync(join(copy, 'linked-out')) === realpathSync(join(outside, 'target.txt')) && readdirSync(outside).join(',') === 'target.txt', `${kindOf(join(copy, 'linked-out'))} ${kindOf(join(copy, 'linked-out')) === 'link' ? readlinkSync(join(copy, 'linked-out')) : ''}`)
    check('an ignored link into the checkout names the copy\'s own file', kindOf(join(copy, 'linked-in')) === 'link' && realpathSync(join(copy, 'linked-in')) === realpathSync(join(copy, 'src', 'pkg', 'mod.py')))
    check('the dependency folder is the copy\'s own, as before', kindOf(join(copy, 'node_modules')) === 'folder' && read(join(copy, 'node_modules', 'dep', 'index.js')) === 'module.exports = 1\n')
    check('the folders that came are recorded with the dependency folder, so leaving the copy does not wait for their delete', JSON.stringify(recorded(copy)) === JSON.stringify(['cache', 'dist', 'node_modules', 'other-trees', 'src/pkg/__pycache__']), JSON.stringify(recorded(copy)))
    check('no failure is reported and nothing is left beside the copy', made.prepareFailure === undefined && readdirSync(dirname(copy)).every(name => !name.startsWith('.cloning-')))
    check('the checkout is as it was', read(join(fixture, 'dist', 'secret', 'key.txt')) === 'the key\n' && read(join(fixture, '.venv', 'pyvenv.cfg')) === 'home = /somewhere\n' && read(join(fixture, 'other-trees', 'wt', '.git')) === 'gitdir: /nowhere/.git/worktrees/wt\n' && read(join(fixture, 'top-tree', 'file.txt')) === 'another tree at the top\n' && kindOf(join(fixture, 'linked-out')) === 'link')
    const treesPlan = await cloneModule.planCloneCalls(join(fixture, 'other-trees'), undefined, true)
    const cachePlan = await cloneModule.planCloneCalls(join(fixture, 'cache'), undefined, true)
    check('what stays behind inside a carried folder is left out of the calls, never cloned and then deleted', JSON.stringify(treesPlan) === JSON.stringify({ folders: [''], clones: ['/plain'], links: ['/wt'] }) && JSON.stringify(cachePlan) === JSON.stringify({ folders: [''], clones: ['/keep'], links: ['/cmake-out'] }), `${JSON.stringify(treesPlan)} ${JSON.stringify(cachePlan)}`)
    const worktreeSource = readFileSync(join(ROOT, 'src/utils/worktree.ts'), 'utf8')
    check('which file is an instruction file is the instruction engine\'s own answer, for every convention it knows', worktreeSource.includes("const { conventionsForProfile, isInstructionFilePath } = await import('../services/instructions/engine.js')") && worktreeSource.includes('return path => names.has(basename(path)) || conventions.some(convention => (convention.folderOf?.(path) ?? null) !== null) || isInstructionFilePath(path, conventions)'))

    section('§2 a copy frozen at a commit, or standing on another, starts with the dependency folders only')
    const frozen = await make('agent-ad200001', { at: 'HEAD' })
    check('worktree_at, even naming the checkout\'s own commit: the dependency folder and nothing else git ignores', kindOf(join(frozen.worktreePath, 'node_modules')) === 'folder' && carriedAll(frozen.worktreePath).length === Object.keys(CARRIED).length && kindOf(join(frozen.worktreePath, 'dist')) === 'absent', `${Object.keys(CARRIED).length - carriedAll(frozen.worktreePath).length} came`)
    const older = join(fixture, '.mercury', 'worktrees', 'older')
    git(fixture, 'worktree', 'add', '-q', '--detach', older, 'HEAD~1')
    await prepare(fixture, older, fixture, false, undefined, true)
    check('a copy cut at another commit than the checkout stands on: the dependency folder only', kindOf(join(older, 'node_modules')) === 'folder' && kindOf(join(older, 'dist')) === 'absent' && kindOf(join(older, '.env')) === 'absent', `${kindOf(join(older, 'dist'))}, ${kindOf(join(older, '.env'))}`)
    const worker = join(fixture, '.mercury', 'worktrees', 'worker')
    git(fixture, 'worktree', 'add', '-q', '-b', 'worker', worker, 'HEAD')
    await prepare(fixture, worker, fixture, true, undefined, true)
    check('a daemon worker made on the checkout\'s own commit is carried into', carriedAll(worker).length === 0 && behindAll(worker).length === 0, `${carriedAll(worker).join(', ')} | ${behindAll(worker).join(', ')}`)
    const resumed = join(fixture, '.mercury', 'worktrees', 'resumed')
    git(fixture, 'worktree', 'add', '-q', '-b', 'resumed', resumed, 'HEAD')
    await prepare(fixture, resumed, fixture, true, undefined, false)
    check('…and one the daemon finds already made is not', kindOf(join(resumed, 'node_modules')) === 'folder' && kindOf(join(resumed, 'dist')) === 'absent')

    section('§3 the session road carries the same')
    const session = await worktree.createWorktreeForSession(state.getSessionId(), 'carry-session', undefined, { gitRoot: fixture })
    worktree.restoreWorktreeSession(null)
    check('a worktree a session enters starts with what git ignores, with the same things left behind', carriedAll(session.worktreePath).length === 0 && behindAll(session.worktreePath).length === 0 && git(session.worktreePath, 'status', '--porcelain') === '', `${carriedAll(session.worktreePath).join(', ')} | ${behindAll(session.worktreePath).join(', ')}`)

    section('§4 the file-by-file road')
    process.env.MERCURY_WORKTREE_CLONE = 'files'
    const walked = await make('agent-ad400001')
    delete process.env.MERCURY_WORKTREE_CLONE
    check('the same folders and files come', carriedAll(walked.worktreePath).length === 0, carriedAll(walked.worktreePath).join(', '))
    check('the same things stay behind', behindAll(walked.worktreePath).length === 0, behindAll(walked.worktreePath).join(', '))
    check('git sees nothing to commit there', git(walked.worktreePath, 'status', '--porcelain') === '')

    section('§5 the switch turns all of it off')
    process.env.MERCURY_WORKTREE_CLONE = 'off'
    const off = await make('agent-ad500001')
    delete process.env.MERCURY_WORKTREE_CLONE
    check('the dependency folder is the link and nothing git ignores is carried', kindOf(join(off.worktreePath, 'node_modules')) === 'link' && carriedAll(off.worktreePath).length === Object.keys(CARRIED).length && kindOf(join(off.worktreePath, 'dist')) === 'absent')

    section('§6 a rule of the checkout that the commit does not hold')
    writeFileSync(join(fixture, '.gitignore'), [...IGNORES, 'extra/', ''].join('\n'))
    mkdirSync(join(fixture, 'extra'))
    writeFileSync(join(fixture, 'extra', 'scratch.txt'), 'ignored only by an uncommitted line\n')
    const unruled = await make('agent-ad600001')
    check('what only an uncommitted .gitignore line ignores is not carried: the copy would show it as new work', kindOf(join(unruled.worktreePath, 'extra')) === 'absent' && git(unruled.worktreePath, 'status', '--porcelain') === '', `${kindOf(join(unruled.worktreePath, 'extra'))} | ${git(unruled.worktreePath, 'status', '--porcelain')}`)
    check('…and everything the commit\'s own rules ignore still comes', carriedAll(unruled.worktreePath).length === 0 && behindAll(unruled.worktreePath).length === 0, carriedAll(unruled.worktreePath).join(', '))

    section('§7 workspace.worktree.symlinkDirectories stays the override for a folder')
    const linkedFixture = makeFixture('linked', dir => ({ ...denying(dir), workspace: { worktree: { symlinkDirectories: ['dist'] } } }))
    enter(linkedFixture)
    const overridden = await make('agent-ad700001')
    check('a folder named there is a link to the checkout\'s where it would otherwise be cloned', kindOf(join(overridden.worktreePath, 'dist')) === 'link' && realpathSync(join(overridden.worktreePath, 'dist')) === realpathSync(join(linkedFixture, 'dist')) && !recorded(overridden.worktreePath).includes('dist'), kindOf(join(overridden.worktreePath, 'dist')))
    check('…and the rest still comes', read(join(overridden.worktreePath, '.env')) === 'TOKEN=1\n' && read(join(overridden.worktreePath, 'cache', 'keep', 'data.bin')) === 'kept\n')

    section('§8 a sparse worktree stays small')
    const sparseFixture = makeFixture('sparse', dir => ({ ...denying(dir), workspace: { worktree: { sparsePaths: ['src'] } } }))
    enter(sparseFixture)
    const sparse = await make('agent-ad750001')
    check('with workspace.worktree.sparsePaths set the copy starts with the dependency folders only', kindOf(join(sparse.worktreePath, 'node_modules')) === 'folder' && kindOf(join(sparse.worktreePath, 'dist')) === 'absent' && kindOf(join(sparse.worktreePath, '.env')) === 'absent' && kindOf(join(sparse.worktreePath, 'cache')) === 'absent', `${kindOf(join(sparse.worktreePath, 'dist'))}, ${kindOf(join(sparse.worktreePath, '.env'))}`)

    section('§9 Mercury\'s own home and the user\'s home are never cloned')
    const inChild = (name: string, dir: string, env: Record<string, string>, rels: string[]): Record<string, string> | null => {
      const child = spawnSync(process.execPath, [import.meta.path, name, dir, ...rels], { encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL', env: { ...process.env, ...env } })
      const line = (child.stdout ?? '').split('\n').find(row => row.startsWith('RESULT '))
      if (line === undefined) console.log(`  (${name}: no answer: ${`${child.stdout ?? ''}${child.stderr ?? ''}`.trim().split('\n').slice(-2).join(' | ').slice(0, 300)})`)
      return line === undefined ? null : (JSON.parse(line.slice('RESULT '.length)) as Record<string, string>)
    }
    const ownHome = makeFixture('own-home', () => ({}), ['local-home/'])
    for (const [file, body] of Object.entries({ 'local-home/.credentials.json': '{"token":"secret"}\n', 'local-home/settings.json': '{}\n', 'local-home/projects/one/session.jsonl': '{}\n' })) {
      mkdirSync(dirname(join(ownHome, file)), { recursive: true })
      writeFileSync(join(ownHome, file), body)
    }
    const withOwnHome = inChild('own-home', ownHome, { CARRY_SCENARIO_HOME: join(ownHome, 'local-home') }, ['local-home', 'local-home/.credentials.json', 'local-home/projects/one/session.jsonl', 'dist/app.js', '.env', 'node_modules'])
    check('a Mercury home that lies inside a project with no Read rule at all, and is ignored there, is not carried: not its credentials file, not a session of it, not the folder', withOwnHome !== null && withOwnHome['local-home/.credentials.json'] === 'absent' && withOwnHome['local-home/projects/one/session.jsonl'] === 'absent' && withOwnHome['local-home'] === 'absent', JSON.stringify(withOwnHome))
    check('…while the rest git ignores still comes', withOwnHome !== null && withOwnHome['dist/app.js'] === 'file' && withOwnHome['.env'] === 'file' && withOwnHome['node_modules'] === 'folder', JSON.stringify(withOwnHome))
    const elsewhere = join(scratch, 'home-elsewhere')
    const WATCHED = ['dist/app.js', '.env', 'run.log', 'cache/keep/data.bin', 'node_modules']
    const carriedThere = (result: Record<string, string> | null): boolean => result !== null && result['dist/app.js'] === 'file' && result['.env'] === 'file' && result['run.log'] === 'file' && result['cache/keep/data.bin'] === 'file'
    const nothingThere = (result: Record<string, string> | null): boolean => result !== null && result['dist/app.js'] === 'absent' && result['.env'] === 'absent' && result['run.log'] === 'absent' && result['cache/keep/data.bin'] === 'absent'
    const homeIs = makeFixture('home-is-checkout', denying)
    const atHome = inChild('home-is-checkout', homeIs, { HOME: homeIs, CARRY_SCENARIO_HOME: elsewhere }, WATCHED)
    check('a checkout that IS the user\'s home directory is carried nothing: what it ignores is the user\'s whole home', nothingThere(atHome), JSON.stringify(atHome))
    check('…and its dependency folder is the copy\'s own, as in any checkout', atHome !== null && atHome['node_modules'] === 'folder', JSON.stringify(atHome))
    const homeInside = makeFixture('home-inside-checkout', denying, ['users/'])
    mkdirSync(join(homeInside, 'users', 'me'), { recursive: true })
    writeFileSync(join(homeInside, 'users', 'me', 'private.txt'), 'in the home\n')
    const aroundHome = inChild('home-inside-checkout', homeInside, { HOME: join(homeInside, 'users', 'me'), CARRY_SCENARIO_HOME: elsewhere }, [...WATCHED, 'users'])
    check('a checkout that CONTAINS the user\'s home directory is carried nothing either', nothingThere(aroundHome) && aroundHome !== null && aroundHome['users'] === 'absent', JSON.stringify(aroundHome))
    const homeBeside = makeFixture('home-beside-checkout', denying)
    mkdirSync(join(scratch, 'a-home-beside'), { recursive: true })
    const besideHome = inChild('home-beside-checkout', homeBeside, { HOME: join(scratch, 'a-home-beside'), CARRY_SCENARIO_HOME: elsewhere }, WATCHED)
    check('a checkout BESIDE the home is carried into as before', carriedThere(besideHome), JSON.stringify(besideHome))
    const homeAbove = makeFixture('home-above-checkout', denying)
    const underHome = inChild('home-above-checkout', homeAbove, { HOME: scratch, CARRY_SCENARIO_HOME: elsewhere }, WATCHED)
    check('a checkout UNDER the home, where a project usually lies, is carried into as before', carriedThere(underHome), JSON.stringify(underHome))

    section('§10 a .worktreeinclude file beside the carry')
    const including = makeFixture('including', denying)
    writeFileSync(join(including, '.worktreeinclude'), '.env\n.env.production\n')
    enter(including)
    const included = await make('agent-ad800001', { foldersBehindLaunch: true })
    check('the launch waits for the folders, as with any .worktreeinclude', included.ready === undefined)
    const again = contentShared([[join(including, '.env'), join(included.worktreePath, '.env')]])
    if (again === null) check('a file the carry brought is there once', read(join(included.worktreePath, '.env')) === 'TOKEN=1\n')
    else check('a file the carry brought is not copied a second time: it still shares its blocks with the checkout\'s', again[0] === true && read(join(included.worktreePath, '.env')) === 'TOKEN=1\n', JSON.stringify(again))
    check('a file the carry left behind and the include file names is copied as before', read(join(included.worktreePath, '.env.production')) === 'TOKEN=live\n', read(join(included.worktreePath, '.env.production')))

    section('§11 another tool\'s instruction files stay behind whatever the process that makes the copy has loaded')
    const OTHER_TOOLS = ['GEMINI.md', '.gemini/GEMINI.md', '.cursorrules', '.cursor/rules/style.mdc', '.windsurfrules', '.windsurf/rules/style.md', '.devin/global_rules.md', '.clinerules', '.cline/rules/style.md', '.github/instructions/style.instructions.md', '.agents/rules/style.md']
    const OTHER_IGNORES = ['/GEMINI.md', '.gemini/', '.cursorrules', '.cursor/', '.windsurfrules', '.windsurf/', '.devin/', '.clinerules', '.cline/', '.github/instructions/', '.agents/']
    const BESIDE_THEM = ['.cursor/mcp.json', 'dist/app.js', '.env']
    const TRACKED_GUIDES: Record<string, string> = { '.github/copilot-instructions.md': 'a guide of another tool, kept in git\n' }
    const otherTools = (name: string, guided: boolean): string => {
      const dir = makeFixture(name, () => ({}), OTHER_IGNORES)
      for (const [file, body] of Object.entries({ ...TRACKED_GUIDES, ...(guided ? { 'MERCURY.md': 'the guide that decides\n' } : {}) })) {
        mkdirSync(dirname(join(dir, file)), { recursive: true })
        writeFileSync(join(dir, file), body)
        git(dir, 'add', '--', file)
      }
      git(dir, 'commit', '-q', '-m', 'guides')
      for (const file of [...OTHER_TOOLS, '.cursor/mcp.json']) {
        mkdirSync(dirname(join(dir, file)), { recursive: true })
        writeFileSync(join(dir, file), `${file}\n`)
      }
      return dir
    }
    const noHome = join(scratch, 'no-home')
    mkdirSync(noHome, { recursive: true })
    const watched = [...OTHER_TOOLS, ...BESIDE_THEM]
    const quiet = { HOME: noHome, USERPROFILE: noHome, CARRY_SCENARIO_HOME: elsewhere }
    const unloadedIn = otherTools('other-tools-unloaded', false)
    const composedIn = otherTools('other-tools-composed', false)
    const decidedIn = otherTools('other-tools-decided', true)
    const unloaded = inChild('other-tools-unloaded', unloadedIn, quiet, watched)
    const composedThere = inChild('other-tools-composed', composedIn, { ...quiet, CARRY_SCENARIO_LOADS: '1' }, watched)
    const decided = inChild('other-tools-decided', decidedIn, { ...quiet, CARRY_SCENARIO_LOADS: '1' }, watched)
    const cameOf = (result: Record<string, string> | null): string[] => (result === null ? ['no answer'] : OTHER_TOOLS.filter(rel => result[rel] !== 'absent'))
    const restCame = (result: Record<string, string> | null): boolean => result !== null && BESIDE_THEM.every(rel => result[rel] === 'file')
    check('a process that has loaded no instruction file, as the daemon making a worker\'s copy, leaves every other tool\'s ignored guide, rule file and rules folder behind', cameOf(unloaded).length === 0, cameOf(unloaded).join(', '))
    check('a session that composed those files leaves them behind', composedThere !== null && composedThere['other tools composed'] === 'true' && cameOf(composedThere).length === 0, `${composedThere?.['other tools composed']} | ${cameOf(composedThere).join(', ')}`)
    check('a session whose MERCURY.md decides, which composed none of them, leaves them behind all the same', decided !== null && decided['other tools composed'] === 'false' && cameOf(decided).length === 0, `${decided?.['other tools composed']} | ${cameOf(decided).join(', ')}`)
    check('…and in all three the rest git ignores comes, with what else lies in another tool\'s ignored folder', restCame(unloaded) && restCame(composedThere) && restCame(decided), `${JSON.stringify(unloaded)} ${JSON.stringify(composedThere)} ${JSON.stringify(decided)}`)
    const asGitPutsIt = (dir: string, guided: boolean): boolean => {
      const copy = join(dir, '.mercury', 'worktrees', 'agent-ad900001')
      const tracked = { ...TRACKED_GUIDES, ...(guided ? { 'MERCURY.md': 'the guide that decides\n' } : {}) }
      return Object.entries(tracked).every(([file, body]) => read(join(copy, file)) === body) && git(copy, 'ls-files', '--', ...Object.keys(tracked)).split('\n').length === Object.keys(tracked).length && git(copy, 'status', '--porcelain') === ''
    }
    check('a tracked instruction file is in the copy exactly as git puts it there: the carry is about ignored files only', asGitPutsIt(unloadedIn, false) && asGitPutsIt(composedIn, false) && asGitPutsIt(decidedIn, true))
  }
} finally {
  delete process.env.MERCURY_WORKTREE_CLONE
  enter(ROOT)
  await wait(200)
  if (process.platform !== 'win32') execFileSync('chmod', ['-R', 'u+rwx', scratch])
  rmSync(scratch, { recursive: true, force: true })
}
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
