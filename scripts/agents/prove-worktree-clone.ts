#!/usr/bin/env bun
import '../lib/hermetic.ts'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statfsSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { cloneRoadExpected, contentShared, volumeClones } from '../lib/cloneRoad.ts'

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
const LARGE_BYTES = 8 * 8 * 1024 * 1024
const spaceUsed = (): number => {
  if (process.platform === 'linux') execFileSync('sync')
  const volume = statfsSync(scratch)
  return (volume.blocks - volume.bfree) * volume.bsize
}
const megabytes = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`
const asked = bigListing.filter(row => !row.endsWith('/') && !row.includes(' -> ')).map(row => row.slice(0, row.lastIndexOf(' '))).filter((rel, index) => index % 40 === 0 || rel.endsWith('bundle.bin'))
const dataRow = (road: string, target: string, cost: number): void => {
  if (process.platform === 'darwin') {
    const shared = contentShared(asked.map(rel => [join(big, 'node_modules', rel), join(target, rel)] as const))
    check(`${road}: each of ${asked.length} files asked, the eight large ones among them, carries the content identifier of the checkout's file, so APFS holds their data once (the volume's used space is a reading: other work writes to it meanwhile)`, shared !== null && shared.every(Boolean), shared === null ? 'the identifiers could not be read' : `${shared.filter(Boolean).length} of ${shared.length}`)
  } else check(`${road}: the data of the eight large files is shared with the checkout, so the clone costs less than they alone would (a file small enough for the filesystem to keep inline is copied)`, cost < LARGE_BYTES, `${megabytes(cost)} of ${megabytes(LARGE_BYTES)}`)
}
if (cloneRoad && cloneModule !== null) {
  const times: number[] = []
  const costs: number[] = []
  for (let round = 0; round < 3; round++) {
    const target = join(scratch, `timed-${round}`, 'node_modules')
    mkdirSync(dirname(target))
    const before = spaceUsed()
    const started = performance.now()
    const outcome = await cloneModule.cloneIntoWorktree([{ source: join(big, 'node_modules'), target }], big, dirname(target))
    times.push(performance.now() - started)
    costs.push(spaceUsed() - before)
    if (round === 0) check('the clone step answers cloned and the folder is whole', outcome[0] === 'cloned' && JSON.stringify(listing(target)) === JSON.stringify(bigListing), String(outcome[0]))
  }
  const best = Math.min(...times)
  console.log(`  three clones: ${times.map(ms => `${ms.toFixed(0)} ms`).join(', ')}; the volume's used space moved by ${costs.map(megabytes).join(', ')}`)
  if (process.platform === 'darwin') check('ten thousand files are cloned in under a second', bigFiles >= 10_000 && best < 1000, `${best.toFixed(0)} ms`)
  else console.log('  the bound of a second is held on APFS, where one call clones the folder; here the time is read, not held')
  dataRow('the folder cloned', join(scratch, 'timed-0', 'node_modules'), Math.min(...costs))
  if (process.platform === 'darwin') {
    const original = join(big, 'node_modules', asked[0]!)
    const byteCopy = join(scratch, 'byte-copy')
    writeFileSync(byteCopy, readFileSync(original))
    const control = contentShared([[original, byteCopy]])
    check('…while a byte copy of one of them carries an identifier of its own', control !== null && control[0] === false, JSON.stringify(control))
  }
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

section("§5b the file-by-file road, Linux's reflinks, read through MERCURY_WORKTREE_CLONE=files wherever the proof's runtime can force a clone of one file")
if (volumeClones(scratch) && process.platform !== 'win32' && cloneModule !== null) {
  const special = join(scratch, 'special')
  makeCheckout(special, 300)
  execFileSync('mkfifo', [join(special, 'node_modules', 'pkg-0', 'a-pipe')])
  const specialListing = listing(join(special, 'node_modules')).filter(row => !row.startsWith('pkg-0/a-pipe'))
  process.env.MERCURY_WORKTREE_CLONE = 'files'
  const byFile = await createAgentWorktree('agent-a8000001', { from: special })
  const byFileModules = join(byFile.worktreePath, 'node_modules')
  check('node_modules and the pack are directories of the copy', isOwnDirectory(byFileModules) && isOwnDirectory(join(byFile.worktreePath, 'vendor', 'pack-a')), read(byFileModules))
  check('every file and folder is there, name for name and size for size, the pipe passed over', JSON.stringify(listing(byFileModules)) === JSON.stringify(specialListing), `${listing(byFileModules).length} against ${specialListing.length}`)
  check('a link inside is kept as written, a file keeps its time and its mode', read(join(byFileModules, '.bin', 'pkg-0')) === 'module.exports = "parent"\n' && readlinkSync(join(byFileModules, '.bin', 'pkg-0')) === '../pkg-0/index.js' && statSync(join(byFileModules, 'pkg-0', 'index.js')).mtimeMs === OLD.getTime() && (statSync(join(byFileModules, '.bin', 'typecheck-fixture')).mode & 0o111) !== 0)
  check('a folder keeps its time, to the millisecond, and its mode', Math.abs(statSync(join(byFileModules, 'pkg-1', 'lib')).mtimeMs - statSync(join(special, 'node_modules', 'pkg-1', 'lib')).mtimeMs) < 1 && (statSync(join(byFileModules, 'pkg-1', 'lib')).mode & 0o7777) === (statSync(join(special, 'node_modules', 'pkg-1', 'lib')).mode & 0o7777), `${statSync(join(byFileModules, 'pkg-1', 'lib')).mtimeMs} against ${statSync(join(special, 'node_modules', 'pkg-1', 'lib')).mtimeMs}`)
  writeFileSync(join(byFileModules, 'pkg-0', 'index.js'), 'module.exports = "copy"\n')
  writeFileSync(join(special, 'node_modules', 'pkg-1', 'package.json'), '{"main":"parent"}')
  check('a write on either side stays on its side', read(join(special, 'node_modules', 'pkg-0', 'index.js')) === 'module.exports = "parent"\n' && read(join(byFileModules, 'pkg-1', 'package.json')) === '{}')
  check('git status in the copy shows nothing', git(byFile.worktreePath, 'status', '--porcelain') === '')
  const fileTimes: number[] = []
  const fileCosts: number[] = []
  for (let round = 0; round < 3; round++) {
    const fileTarget = join(scratch, `timed-files-${round}`, 'node_modules')
    mkdirSync(dirname(fileTarget))
    const usedBefore = spaceUsed()
    const fileStarted = performance.now()
    const fileOutcome = await cloneModule.cloneIntoWorktree([{ source: join(big, 'node_modules'), target: fileTarget }], big, dirname(fileTarget))
    fileTimes.push(performance.now() - fileStarted)
    fileCosts.push(spaceUsed() - usedBefore)
    if (round === 0) check('ten thousand files cloned file by file hold the folder whole', fileOutcome[0] === 'cloned' && JSON.stringify(listing(fileTarget)) === JSON.stringify(bigListing), String(fileOutcome[0]))
  }
  console.log(`  three clones, file by file: ${fileTimes.map(ms => `${ms.toFixed(0)} ms`).join(', ')}; the volume's used space moved by ${fileCosts.map(megabytes).join(', ')}`)
  dataRow('the folder cloned file by file', join(scratch, 'timed-files-0', 'node_modules'), Math.min(...fileCosts))
  const sealedByFile = join(scratch, 'sealed-by-file')
  makeCheckout(sealedByFile, 40)
  mkdirSync(join(sealedByFile, 'node_modules', 'sealed'))
  writeFileSync(join(sealedByFile, 'node_modules', 'sealed', 'inside'), 'x\n')
  chmodSync(join(sealedByFile, 'node_modules', 'sealed'), 0o000)
  const afterFileFailure = await createAgentWorktree('agent-a8000002', { from: sealedByFile })
  chmodSync(join(sealedByFile, 'node_modules', 'sealed'), 0o755)
  if (process.getuid?.() !== 0) check('a folder the walk cannot read whole is linked as before, with no half copy left', isLinkTo(join(afterFileFailure.worktreePath, 'node_modules'), join(sealedByFile, 'node_modules')) && isOwnDirectory(join(afterFileFailure.worktreePath, 'vendor', 'pack-a')))
  else skip('this user reads every folder: nothing to fail')
  delete process.env.MERCURY_WORKTREE_CLONE
} else {
  skip("the proof's runtime cannot force a clone of one file here: the file-by-file road answers that it cannot, and the links stand as in §5")
  process.env.MERCURY_WORKTREE_CLONE = 'files'
  const refusedByFile = await createAgentWorktree('agent-a8000001')
  delete process.env.MERCURY_WORKTREE_CLONE
  check('the file-by-file road on a volume that cannot reflink leaves the links, as before', isLinkTo(join(refusedByFile.worktreePath, 'node_modules'), join(deps, 'node_modules')) && isLinkTo(join(refusedByFile.worktreePath, 'vendor', 'pack-a'), join(deps, 'vendor', 'pack-a')))
}

section("§5c Linux's own road, one `cp -a --reflink=always` a folder where the machine's cp takes the flag, read through MERCURY_WORKTREE_CLONE=cp with a cp of the proof's own that records what it is asked")
if (volumeClones(scratch) && process.platform !== 'win32' && cloneModule !== null) {
  const shims = join(scratch, 'shims')
  const asked = join(shims, 'asked.log')
  const realCp = execFileSync('sh', ['-c', 'command -v cp'], { encoding: 'utf8' }).trim()
  const record = `#!/bin/bash\nprintf '%s\\n' "$*" >> ${JSON.stringify(asked)}\n`
  const takes = 'if [ "$1" = "--reflink=always" ] && [ "$2" = "--version" ]; then exit 0; fi\n'
  const cloneCall = '[ "$1 $2 $3 $4" = "-a --reflink=always -T --" ] || exit 64\n'
  const doubles: Record<string, string> = {
    taking: record + takes + cloneCall + (process.platform === 'darwin' ? `exec ${realCp} -c -R -p "$5/." "$6/"\n` : `exec ${realCp} "$@"\n`),
    failing: record + takes + cloneCall + 'mkdir -p "$6/half"; echo x > "$6/half/file"; echo "cp: cannot clone" >&2; exit 1\n',
    refusing: record + 'echo "cp: unrecognized option" >&2; exit 1\n',
  }
  for (const [name, body] of Object.entries(doubles)) {
    mkdirSync(join(shims, name), { recursive: true })
    writeFileSync(join(shims, name, 'cp'), body)
    chmodSync(join(shims, name, 'cp'), 0o755)
  }
  const askedLines = (): string[] => read(asked).split('\n').filter(line => line !== '' && line !== '<absent>')
  const pathBefore = process.env.PATH ?? ''
  const byCpFixture = join(scratch, 'by-cp')
  makeCheckout(byCpFixture, 60)
  symlinkSync(join(byCpFixture, 'src'), join(byCpFixture, 'node_modules', 'abs-into-checkout'))
  const byCpListing = listing(join(byCpFixture, 'node_modules'))
  process.env.MERCURY_WORKTREE_CLONE = 'cp'
  process.env.PATH = `${join(shims, 'taking')}:${pathBefore}`
  const takenOne = await createAgentWorktree('agent-a9000001', { from: byCpFixture })
  const takenTwo = await createAgentWorktree('agent-a9000002', { from: byCpFixture })
  const afterTaking = askedLines()
  check('the machine\'s cp is asked once whether it takes the flag, however many copies are made', afterTaking.filter(line => line === '--reflink=always --version').length === 1, afterTaking.join(' | '))
  check('each folder is taken by one call, `cp -a --reflink=always -T --` from the checkout\'s real folder to the copy\'s', afterTaking.includes(`-a --reflink=always -T -- ${realpathSync(join(byCpFixture, 'node_modules'))} ${join(takenOne.worktreePath, 'node_modules')}`) && afterTaking.includes(`-a --reflink=always -T -- ${realpathSync(join(byCpFixture, 'vendor', 'pack-a'))} ${join(takenTwo.worktreePath, 'vendor', 'pack-a')}`) && afterTaking.length === 5, afterTaking.join(' | '))
  check('the copy holds the folder whole as its own', isOwnDirectory(join(takenOne.worktreePath, 'node_modules')) && JSON.stringify(listing(join(takenOne.worktreePath, 'node_modules')).filter(row => !row.startsWith('abs-into-checkout'))) === JSON.stringify(byCpListing.filter(row => !row.startsWith('abs-into-checkout'))))
  check('…and is walked afterwards: a link into the checkout names the copy', readlinkSync(join(takenOne.worktreePath, 'node_modules', 'abs-into-checkout')) === join(takenOne.worktreePath, 'src'), readlinkSync(join(takenOne.worktreePath, 'node_modules', 'abs-into-checkout')))
  writeFileSync(join(takenOne.worktreePath, 'node_modules', 'pkg-0', 'index.js'), 'module.exports = "copy"\n')
  check('a write in the copy does not appear in the checkout or in the other copy', read(join(byCpFixture, 'node_modules', 'pkg-0', 'index.js')) === 'module.exports = "parent"\n' && read(join(takenTwo.worktreePath, 'node_modules', 'pkg-0', 'index.js')) === 'module.exports = "parent"\n')
  process.env.PATH = `${join(shims, 'failing')}:${pathBefore}`
  const afterCpFailure = await createAgentWorktree('agent-a9000003', { from: byCpFixture })
  check('a cp that fails leaves the link exactly as a failed walk does, with no half copy', isLinkTo(join(afterCpFailure.worktreePath, 'node_modules'), join(byCpFixture, 'node_modules')) && isLinkTo(join(afterCpFailure.worktreePath, 'vendor', 'pack-a'), join(byCpFixture, 'vendor', 'pack-a')) && afterCpFailure.prepareFailure === undefined)
  rmSync(asked, { force: true })
  process.env.PATH = `${join(shims, 'refusing')}:${pathBefore}`
  const withoutFlag = await createAgentWorktree('agent-a9000004', { from: byCpFixture })
  check('a cp that does not take the flag is asked once and never called: the walk takes the folder', isOwnDirectory(join(withoutFlag.worktreePath, 'node_modules')) && askedLines().join(' | ') === '--reflink=always --version', askedLines().join(' | '))
  process.env.PATH = pathBefore
  delete process.env.MERCURY_WORKTREE_CLONE
} else {
  skip("the proof's runtime cannot force a clone of one file here: Linux's road asks the filesystem first, hears that it cannot, and the links stand as in §5")
}
if (process.platform === 'linux' && cloneRoad) {
  const paired = join(scratch, 'paired')
  makeCheckout(paired, 60)
  linkSync(join(paired, 'node_modules', 'pkg-0', 'index.js'), join(paired, 'node_modules', 'pkg-0', 'second-name.js'))
  const realCpTakes = ((): boolean => {
    try {
      execFileSync('cp', ['--reflink=always', '--version'], { stdio: 'ignore' })
      return true
    } catch {
      return false
    }
  })()
  const byRealCp = await createAgentWorktree('agent-a9000005', { from: paired })
  const firstName = statSync(join(byRealCp.worktreePath, 'node_modules', 'pkg-0', 'index.js'))
  const secondName = statSync(join(byRealCp.worktreePath, 'node_modules', 'pkg-0', 'second-name.js'))
  if (realCpTakes) check('with no seam, on this Linux filesystem, the folder is taken by the machine\'s own cp: two names of one file in the checkout are two names of one file in the copy, and not the checkout\'s file', firstName.ino === secondName.ino && firstName.ino !== statSync(join(paired, 'node_modules', 'pkg-0', 'index.js')).ino, `${firstName.ino} ${secondName.ino}`)
  else check('with no seam and a cp that does not take the flag, the walk takes the folder: each name its own file', firstName.ino !== secondName.ino)
} else {
  skip('the machine\'s own cp road is Linux\'s, on a filesystem that reflinks: read there by the container reading')
}

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
