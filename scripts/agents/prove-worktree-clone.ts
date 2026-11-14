#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statfsSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
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
const { resetSettingsCache } = await import('../../src/utils/settings/settingsCache.ts')
const { createAgentWorktree, createWorktreeForSession, keepWorktree, prepareWorktreeFiles, readWorktreeDelta } = await import('../../src/utils/worktree.ts')
const cloneModule = await import('../../src/utils/worktreeClone.ts').catch(() => null)

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-clone-')))
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'proof', GIT_AUTHOR_EMAIL: 'proof@invalid', GIT_COMMITTER_NAME: 'proof', GIT_COMMITTER_EMAIL: 'proof@invalid' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv }).trim()
const authoredStatus = (cwd: string): string => git(cwd, 'status', '--porcelain', '-uall').split('\n').filter(line => line !== '' && !line.slice(3).startsWith('.mercury/')).join('\n')
const isLinkTo = (path: string, target: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink() && realpathSync(path) === realpathSync(target)
  } catch {
    return false
  }
}
const isOwnDirectory = (path: string): boolean => {
  try {
    return lstatSync(path).isDirectory()
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
  walk(root, '')
  return rows
}
const excludeLines = (repo: string): string[] => read(join(repo, '.git', 'info', 'exclude')).split('\n').filter(line => line.startsWith('/'))
const enter = (dir: string): void => {
  process.chdir(dir)
  state.setOriginalCwd(dir)
  state.setCwdState(dir)
}

const OLD = new Date('2021-03-04T05:06:07Z')
const makeCheckout = (dir: string, dependencyFiles: number): void => {
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '-b', 'main')
  for (const [name, body] of Object.entries({
    '.gitignore': 'node_modules/\nvendor/*/\n',
    'package.json': JSON.stringify({ name: 'clone-fixture', scripts: { typecheck: 'typecheck-fixture' } }),
    'vendor/pack-a.lock.json': '{}\n',
    'src/index.js': 'module.exports = 1\n',
  })) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), body)
  }
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', 'first')
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '.bin', 'typecheck-fixture'), '#!/bin/sh\nprintf typecheck-ok\n')
  chmodSync(join(dir, 'node_modules', '.bin', 'typecheck-fixture'), 0o755)
  const body = Buffer.alloc(1024, 'd')
  let made = 1
  for (let pkg = 0; made < dependencyFiles; pkg++) {
    const home = join(dir, 'node_modules', `pkg-${pkg}`)
    mkdirSync(join(home, 'lib'), { recursive: true })
    for (let index = 0; index < 19 && made < dependencyFiles; index++, made++) writeFileSync(join(home, 'lib', `m${index}.js`), body)
    if (made < dependencyFiles) {
      writeFileSync(join(home, 'package.json'), '{}')
      made++
    }
  }
  writeFileSync(join(dir, 'node_modules', 'pkg-0', 'index.js'), 'module.exports = "parent"\n')
  utimesSync(join(dir, 'node_modules', 'pkg-0', 'index.js'), OLD, OLD)
  symlinkSync('../pkg-0/index.js', join(dir, 'node_modules', '.bin', 'pkg-0'))
  mkdirSync(join(dir, 'vendor', 'pack-a'))
  writeFileSync(join(dir, 'vendor', 'pack-a', 'marker'), 'pack\n')
  mkdirSync(join(dir, 'authored'))
  writeFileSync(join(dir, 'authored', 'note'), 'not ignored\n')
}

section('§1 what this volume can do, read by the proof apart from the product')
const cloneRoad = cloneRoadExpected(scratch)
console.log(`  the proof's own forced clone of one file ${volumeClones(scratch) ? 'succeeds' : 'is refused'} here (${process.platform}); the product's clone road is ${cloneRoad ? 'expected' : 'not expected'}`)
check('the clone step is part of the tree', cloneModule !== null && typeof cloneModule.cloneIntoWorktree === 'function')

section("§2 an isolated crewmate's copy holds its own dependency folders")
const deps = join(scratch, 'deps')
makeCheckout(deps, 400)
const parentStatusBefore = authoredStatus(deps)
const parentListingBefore = listing(join(deps, 'node_modules'))
enter(deps)
state.setIsInteractive(true)
config.enableConfigs()
const first = await createAgentWorktree('agent-a1000001')
const firstModules = join(first.worktreePath, 'node_modules')
const firstPack = join(first.worktreePath, 'vendor', 'pack-a')
if (cloneRoad) {
  check('node_modules is a directory of the copy, not a link', isOwnDirectory(firstModules), read(firstModules))
  check('every vendored pack is a directory of the copy too', isOwnDirectory(firstPack) && read(join(firstPack, 'marker')) === 'pack\n')
  check('the copy holds every file of the checkout\'s folder, name for name and size for size', JSON.stringify(listing(firstModules)) === JSON.stringify(parentListingBefore), `${listing(firstModules).length} against ${parentListingBefore.length}`)
  check('a link inside the folder is kept as it was written', readlinkSync(join(firstModules, '.bin', 'pkg-0')) === '../pkg-0/index.js')
  check('a file keeps its time and its mode', statSync(join(firstModules, 'pkg-0', 'index.js')).mtimeMs === OLD.getTime() && (statSync(join(firstModules, '.bin', 'typecheck-fixture')).mode & 0o111) !== 0)
  writeFileSync(join(firstModules, 'pkg-0', 'index.js'), 'module.exports = "copy"\n')
  check('a write in the copy does not appear in the main checkout', read(join(deps, 'node_modules', 'pkg-0', 'index.js')) === 'module.exports = "parent"\n', read(join(deps, 'node_modules', 'pkg-0', 'index.js')))
  writeFileSync(join(deps, 'node_modules', 'pkg-1', 'package.json'), '{"main":"parent"}')
  check('a write in the main checkout does not appear in the copy', read(join(firstModules, 'pkg-1', 'package.json')) === '{}')
  writeFileSync(join(firstModules, 'installed-by-the-copy'), 'x\n')
  rmSync(join(firstModules, 'pkg-2'), { recursive: true, force: true })
  check('what the copy installs or removes stays in the copy', !existsSync(join(deps, 'node_modules', 'installed-by-the-copy')) && existsSync(join(deps, 'node_modules', 'pkg-2', 'package.json')))
  writeFileSync(join(firstPack, 'marker'), 'rebuilt in the copy\n')
  check('a pack rebuilt in the copy leaves the checkout\'s pack as it was', read(join(deps, 'vendor', 'pack-a', 'marker')) === 'pack\n')
  check('the exclude file of the clone gains no line', excludeLines(deps).length === 0, excludeLines(deps).join('|'))
} else {
  skip('this volume or platform cannot clone: the copy is linked as before, read in §5')
  check("node_modules is a link to the parent checkout's", isLinkTo(firstModules, join(deps, 'node_modules')))
  check('every vendored pack is a link too', isLinkTo(firstPack, join(deps, 'vendor', 'pack-a')))
}
check('an authored untracked directory of the parent is not carried', !existsSync(join(first.worktreePath, 'authored')))
const laneStatus = git(first.worktreePath, 'status', '--porcelain')
check('git status in the copy shows nothing', laneStatus === '', laneStatus)
check("the parent checkout's status is unchanged", authoredStatus(deps) === parentStatusBefore, authoredStatus(deps))
const delta = await readWorktreeDelta(first.worktreePath, first.headCommit)
check('the copy reads as holding no authored work', delta.untrackedAuthored.length === 0 && delta.tracked.length === 0 && delta.uncertainty === null, JSON.stringify(delta))
let typecheck = ''
try {
  typecheck = execFileSync(process.execPath, ['run', 'typecheck'], { cwd: first.worktreePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
} catch (error) {
  typecheck = `failed: ${String((error as { stderr?: string }).stderr ?? error)}`
}
check('bun run typecheck exits 0 in the copy', typecheck.includes('typecheck-ok'), typecheck.slice(0, 200))
check('the copy is still a git worktree on its own branch at the checkout\'s commit', git(first.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD') === 'worktree-agent-a1000001' && git(first.worktreePath, 'rev-parse', 'HEAD') === git(deps, 'rev-parse', 'HEAD') && first.headCommit === git(deps, 'rev-parse', 'HEAD'))
const removed = git(deps, 'worktree', 'unlock', first.worktreePath) === '' && git(deps, 'worktree', 'remove', first.worktreePath) === ''
check('an ordinary git worktree remove takes the copy, its cloned folders with it', removed && !existsSync(first.worktreePath))

section('§3 two crewmates at once build in their own folders')
const [left, right] = await Promise.all([createAgentWorktree('agent-a2000001'), createAgentWorktree('agent-a2000002')])
for (const [lane, word] of [[left, 'left'], [right, 'right']] as const) {
  mkdirSync(join(lane.worktreePath, 'node_modules', '.cache'), { recursive: true })
  writeFileSync(join(lane.worktreePath, 'node_modules', '.cache', 'build-marker'), `${word}\n`)
  writeFileSync(join(lane.worktreePath, 'node_modules', 'pkg-3', 'package.json'), `{"built-by":"${word}"}`)
}
const leftSees = `${read(join(left.worktreePath, 'node_modules', '.cache', 'build-marker'))}${read(join(left.worktreePath, 'node_modules', 'pkg-3', 'package.json'))}`
const rightSees = `${read(join(right.worktreePath, 'node_modules', '.cache', 'build-marker'))}${read(join(right.worktreePath, 'node_modules', 'pkg-3', 'package.json'))}`
const parentSees = `${read(join(deps, 'node_modules', '.cache', 'build-marker'))}${read(join(deps, 'node_modules', 'pkg-3', 'package.json'))}`
if (cloneRoad) {
  check('each crewmate reads its own build output', leftSees === 'left\n{"built-by":"left"}' && rightSees === 'right\n{"built-by":"right"}', `${leftSees} · ${rightSees}`)
  check('the checkout reads neither', parentSees === '<absent>{}', parentSees)
} else {
  skip('this volume or platform cannot clone: the two crewmates write through one linked folder, as before')
  check('the two crewmates and the checkout read one folder', leftSees === rightSees && rightSees === parentSees, `${leftSees} · ${rightSees} · ${parentSees}`)
}
check('each stands on its own branch', git(left.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD') === 'worktree-agent-a2000001' && git(right.worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD') === 'worktree-agent-a2000002')

section('§4 ten thousand files: the time and the disk')
const big = join(scratch, 'big')
makeCheckout(big, 10_000)
for (let index = 0; index < 8; index++) writeFileSync(join(big, 'node_modules', `pkg-${index}`, 'lib', 'bundle.bin'), Buffer.alloc(8 * 1024 * 1024, index + 1))
const bigListing = listing(join(big, 'node_modules'))
const bigFiles = bigListing.filter(row => !row.endsWith('/') && !row.includes(' -> ')).length
const bigBytes = bigListing.reduce((sum, row) => sum + (row.endsWith('/') || row.includes(' -> ') ? 0 : Number(row.slice(row.lastIndexOf(' ') + 1))), 0)
console.log(`  the folder: ${bigFiles} files, ${bigListing.filter(row => row.endsWith('/')).length} folders, ${(bigBytes / 1024 / 1024).toFixed(1)} MB`)
if (cloneRoad && cloneModule !== null) {
  const times: number[] = []
  const costs: number[] = []
  for (let round = 0; round < 3; round++) {
    const target = join(scratch, `timed-${round}`, 'node_modules')
    mkdirSync(dirname(target))
    const free = (): number => {
      const volume = statfsSync(scratch)
      return volume.bavail * volume.bsize
    }
    const before = free()
    const started = performance.now()
    const outcome = await cloneModule.cloneIntoWorktree([{ source: join(big, 'node_modules'), target }], big)
    times.push(performance.now() - started)
    costs.push(before - free())
    if (round === 0) check('the clone step answers cloned and the folder is whole', outcome[0] === 'cloned' && JSON.stringify(listing(target)) === JSON.stringify(bigListing), String(outcome[0]))
  }
  const best = Math.min(...times)
  const cost = Math.min(...costs)
  console.log(`  three clones: ${times.map(ms => `${ms.toFixed(0)} ms`).join(', ')}; the volume's free space moved by ${costs.map(bytes => `${(bytes / 1024 / 1024).toFixed(1)} MB`).join(', ')}`)
  check('ten thousand files are cloned in under a second', bigFiles >= 10_000 && best < 1000, `${best.toFixed(0)} ms`)
  check('at a disk cost under a tenth of the folder', cost < bigBytes / 10, `${(cost / 1024 / 1024).toFixed(1)} MB of ${(bigBytes / 1024 / 1024).toFixed(1)} MB`)
  enter(big)
  const started = performance.now()
  const whole = await createAgentWorktree('agent-a3000001')
  const elapsed = performance.now() - started
  console.log(`  the whole copy (git worktree add, the clones, the lock): ${elapsed.toFixed(0)} ms`)
  check('the whole copy holds the ten thousand files as its own', isOwnDirectory(join(whole.worktreePath, 'node_modules')) && JSON.stringify(listing(join(whole.worktreePath, 'node_modules'))) === JSON.stringify(bigListing))
  enter(deps)
} else {
  skip('this volume or platform cannot clone: no time and no disk cost to read')
}

section('§5 MERCURY_WORKTREE_CLONE=off reads as a volume that cannot clone: the links, as before')
process.env.MERCURY_WORKTREE_CLONE = 'off'
const linked = await createAgentWorktree('agent-a4000001')
delete process.env.MERCURY_WORKTREE_CLONE
const tracked = git(deps, 'ls-files').split('\n')
const expected = [
  '.git 0',
  '.mercury/',
  ...tracked.filter(name => !name.includes('/')).map(name => `${name} ${statSync(join(deps, name)).size}`),
  `node_modules -> ${join(deps, 'node_modules')}`,
  'src/',
  ...tracked.filter(name => name.startsWith('src/')).map(name => `${name} ${statSync(join(deps, name)).size}`),
  'vendor/',
  `vendor/pack-a -> ${join(deps, 'vendor', 'pack-a')}`,
  ...tracked.filter(name => name.startsWith('vendor/')).map(name => `${name} ${statSync(join(deps, name)).size}`),
].sort()
const actual = listing(linked.worktreePath).map(row => (row.startsWith('.git ') ? '.git 0' : row)).sort()
check('the copy holds its tracked files, the empty folder its local settings would go in and two links, and nothing else', JSON.stringify(actual) === JSON.stringify(expected), `${actual.join(' | ')} against ${expected.join(' | ')}`)
check("node_modules is a link to the parent checkout's", isLinkTo(join(linked.worktreePath, 'node_modules'), join(deps, 'node_modules')))
check('every vendored pack is a link too', isLinkTo(join(linked.worktreePath, 'vendor', 'pack-a'), join(deps, 'vendor', 'pack-a')))
check("the clone's exclude file carries the link names, anchored, once each", excludeLines(deps).filter(line => line === '/node_modules').length === 1 && excludeLines(deps).filter(line => line === '/vendor/pack-a').length === 1, excludeLines(deps).join('|'))
check('git status in the linked copy shows nothing', git(linked.worktreePath, 'status', '--porcelain') === '')
writeFileSync(join(linked.worktreePath, 'node_modules', 'pkg-4', 'package.json'), '{"through":"the link"}')
check('a write through the link lands in the checkout, as before', read(join(deps, 'node_modules', 'pkg-4', 'package.json')) === '{"through":"the link"}')

section('§6 what is linked by the user\'s word, what is left alone, what a link out of the checkout brings, and what a failed clone leaves')
mkdirSync(join(deps, '.mercury'), { recursive: true })
writeFileSync(join(deps, '.mercury', 'settings.json'), JSON.stringify({ workspace: { worktree: { symlinkDirectories: ['node_modules/'] } } }))
resetSettingsCache()
const overridden = await createAgentWorktree('agent-a5000001')
check('a dependency folder named in workspace.worktree.symlinkDirectories stays a link', isLinkTo(join(overridden.worktreePath, 'node_modules'), join(deps, 'node_modules')))
check('…while the pack beside it is cloned where the volume clones', cloneRoad ? isOwnDirectory(join(overridden.worktreePath, 'vendor', 'pack-a')) : isLinkTo(join(overridden.worktreePath, 'vendor', 'pack-a'), join(deps, 'vendor', 'pack-a')))
rmSync(join(deps, '.mercury', 'settings.json'))
resetSettingsCache()
const kept = join(scratch, 'kept')
mkdirSync(join(kept, 'node_modules'), { recursive: true })
writeFileSync(join(kept, 'node_modules', 'mine'), 'already here\n')
await prepareWorktreeFiles(deps, kept, deps, true)
check('a folder already in the copy is left as it is', read(join(kept, 'node_modules', 'mine')) === 'already here\n' && readdirSync(join(kept, 'node_modules')).length === 1)
const viaLink = join(scratch, 'via-link')
makeCheckout(viaLink, 40)
const elsewhere = join(scratch, 'elsewhere-modules')
execFileSync('mv', [join(viaLink, 'node_modules'), elsewhere])
symlinkSync(elsewhere, join(viaLink, 'node_modules'))
writeFileSync(join(viaLink, '.gitignore'), 'node_modules\nvendor/*/\nkept-modules/\n')
git(viaLink, 'commit', '-q', '-am', 'the dependency folder may be a link')
const fromLink = await createAgentWorktree('agent-a6000001', { from: viaLink })
check('a dependency folder that is a link out of the checkout stays a link through it: no file from outside the checkout enters the copy', lstatSync(join(fromLink.worktreePath, 'node_modules')).isSymbolicLink() && realpathSync(join(fromLink.worktreePath, 'node_modules')) === realpathSync(elsewhere))
check('…while the pack inside the checkout is cloned where the volume clones', cloneRoad ? isOwnDirectory(join(fromLink.worktreePath, 'vendor', 'pack-a')) : isLinkTo(join(fromLink.worktreePath, 'vendor', 'pack-a'), join(viaLink, 'vendor', 'pack-a')))
rmSync(join(viaLink, 'node_modules'))
execFileSync('mv', [elsewhere, join(viaLink, 'kept-modules')])
symlinkSync('kept-modules', join(viaLink, 'node_modules'))
const fromInnerLink = await createAgentWorktree('agent-a6000002', { from: viaLink })
if (cloneRoad) {
  check('a dependency folder that is a link to a folder inside the checkout is cloned from that folder', isOwnDirectory(join(fromInnerLink.worktreePath, 'node_modules')) && read(join(fromInnerLink.worktreePath, 'node_modules', 'pkg-0', 'index.js')) === 'module.exports = "parent"\n')
  writeFileSync(join(fromInnerLink.worktreePath, 'node_modules', 'pkg-0', 'index.js'), 'module.exports = "copy"\n')
  check('…and a write in the copy reaches neither the link nor the folder behind it', read(join(viaLink, 'kept-modules', 'pkg-0', 'index.js')) === 'module.exports = "parent"\n')
} else {
  skip('this volume or platform cannot clone: the folder behind the link is linked as before')
  check('a dependency folder that is a link to a folder inside the checkout is linked through it', realpathSync(join(fromInnerLink.worktreePath, 'node_modules')) === realpathSync(join(viaLink, 'kept-modules')))
}
const unreadable = join(scratch, 'unreadable')
makeCheckout(unreadable, 40)
mkdirSync(join(unreadable, 'node_modules', 'sealed'))
writeFileSync(join(unreadable, 'node_modules', 'sealed', 'inside'), 'x\n')
chmodSync(join(unreadable, 'node_modules', 'sealed'), 0o000)
const afterFailure = await createAgentWorktree('agent-a7000001', { from: unreadable })
chmodSync(join(unreadable, 'node_modules', 'sealed'), 0o755)
if (cloneRoad && process.getuid?.() !== 0) {
  check('a folder the clone cannot read whole is linked as before, with no half copy left', isLinkTo(join(afterFailure.worktreePath, 'node_modules'), join(unreadable, 'node_modules')))
  check('…and the folder beside it is still cloned', isOwnDirectory(join(afterFailure.worktreePath, 'vendor', 'pack-a')))
} else {
  skip('no clone is attempted here, or this user reads every folder: nothing to fail')
  check('the copy was made', existsSync(join(afterFailure.worktreePath, 'package.json')))
}
check('the copy was made and prepared without a failure to report', afterFailure.prepareFailure === undefined && existsSync(join(afterFailure.worktreePath, 'package.json')))

section('§7 the session road makes the same copy')
enter(deps)
const session = await createWorktreeForSession('proof-session', 'clone-proof')
check('the session worktree holds its dependency folders the same way', cloneRoad ? isOwnDirectory(join(session.worktreePath, 'node_modules')) && isOwnDirectory(join(session.worktreePath, 'vendor', 'pack-a')) : isLinkTo(join(session.worktreePath, 'node_modules'), join(deps, 'node_modules')))
check('git status in the session worktree shows nothing', git(session.worktreePath, 'status', '--porcelain') === '')
await keepWorktree()

section('§8 the pages say what the code does')
const crewDoc = readFileSync(join(ROOT, 'docs/CREW.md'), 'utf8').replace(/\s+/g, ' ')
const sessionsDoc = readFileSync(join(ROOT, 'docs/SESSIONS.md'), 'utf8').replace(/\s+/g, ' ')
const settingsDoc = readFileSync(join(ROOT, 'docs/SETTINGS.md'), 'utf8')
check('the crew page says a crewmate has its own copy where the filesystem can clone', crewDoc.includes("On a filesystem that can clone (APFS on macOS, a Linux filesystem with reflinks) each is the worktree's own copy, made at once and sharing disk space until one side writes, so what a crewmate installs or builds there reaches neither the checkout nor another crewmate"))
check('…and a link elsewhere and for a directory named in the setting', crewDoc.includes("elsewhere, and for a directory named in `workspace.worktree.symlinkDirectories`, each is a link to the checkout's copy"))
check('the sessions page says an install stays in the worktree where the filesystem can clone', sessionsDoc.includes('an install run inside the worktree stays in the worktree'))
check('…and lands in the checkout elsewhere', sessionsDoc.includes("Elsewhere each is a link to the checkout's copy") && sessionsDoc.includes('an install run inside the worktree installs into the checkout'))
check('the settings page says the setting keeps a dependency folder a link', settingsDoc.includes("| `workspace.worktree.symlinkDirectories` | Directories linked into a managed worktree; a dependency folder named here stays a link to the checkout's where it would otherwise be cloned. |"))

enter(ROOT)
for (const folder of [join(unreadable, 'node_modules', 'sealed')]) {
  try {
    chmodSync(folder, 0o755)
  } catch {
  }
}
rmSync(scratch, { recursive: true, force: true })
console.log('\n' + '─'.repeat(76))
console.log(failures === 0 ? '  ALL PASS' : `  ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
