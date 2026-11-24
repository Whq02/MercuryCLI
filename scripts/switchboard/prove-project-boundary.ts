#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeScratch } from '../lib/removeScratch.ts'

process.chdir(join(import.meta.dir, '..', '..'))
const REAL_GIT = process.platform === 'win32'
  ? execFileSync('where.exe', ['git'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0]!
  : execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'project-boundary-')))
const HOME_FX = join(SCRATCH, 'home')
const PROJ = join(HOME_FX, 'Desktop', 'proj')
const PICS = join(HOME_FX, 'Pictures')
const VOXEL = join(HOME_FX, 'Documents', 'voxel')
const NOTES = join(PICS, 'notes-proj')
const REAL = join(SCRATCH, 'real')
const SUB = join(REAL, 'sub')
const OUTSIDE = join(SCRATCH, 'outside')
const BIN = join(SCRATCH, 'bin')
const LOG = join(SCRATCH, 'git.log')
const CFG = join(SCRATCH, 'cfg')
for (const d of [join(PROJ, 'src'), NOTES, join(VOXEL, 'src'), SUB, OUTSIDE, BIN, CFG]) mkdirSync(d, { recursive: true })
writeFileSync(join(VOXEL, 'src', 'main.gd'), 'extends Node\n')
writeFileSync(join(PROJ, 'README.md'), '# proj\n')
writeFileSync(join(PROJ, 'src', 'a.txt'), 'hello\n')
writeFileSync(join(NOTES, 'notes.md'), '# notes\n')
writeFileSync(join(REAL, 'a.txt'), 'a\n')
writeFileSync(join(SUB, 'b.txt'), 'b\n')
writeFileSync(join(OUTSIDE, 'c.txt'), 'c\n')
const identity = ['-c', 'user.email=proof@example.invalid', '-c', 'user.name=proof']
const git = (cwd: string, ...args: string[]): string =>
  execFileSync(REAL_GIT, [...identity, ...args], { cwd, encoding: 'utf8', env: { ...process.env, HOME: HOME_FX }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
git(HOME_FX, 'init', '-q')
git(HOME_FX, 'commit', '-q', '--allow-empty', '-m', 'mercury: base commit — forking unlocked')
git(PICS, 'init', '-q')
git(PICS, 'commit', '-q', '--allow-empty', '-m', 'pics')
const voxelTop = git(VOXEL, 'rev-parse', '--show-toplevel')
git(REAL, 'init', '-q')
git(REAL, 'add', '.')
git(REAL, 'commit', '-q', '-m', 'seed')
if (process.platform !== 'win32') {
  writeFileSync(join(BIN, 'git'), `#!/bin/sh\nprintf '%s\\t%s\\n' "$PWD" "$*" >> '${LOG}'\nexec '${REAL_GIT}' "$@"\n`)
  chmodSync(join(BIN, 'git'), 0o755)
  writeFileSync(LOG, '')
  process.env.PATH = `${BIN}:${process.env.PATH ?? ''}`
}
process.env.HOME = HOME_FX
process.env.USERPROFILE = HOME_FX
process.env.MERCURY_CONFIG_DIR = CFG
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && hint ? ` — ${hint}` : ''}`)
}
const HINT_BOUNDARY = 'fix projectScopePathspec or launchFolderBoundsProject in src/platform/files/projectBoundary.ts'
const HINT_PROBE = 'the git probe named in the label must append the pathspec from projectScopePathspec (src/platform/files/projectBoundary.ts); the PROBES line above lists every call that ran'

const boundary = await import('../../src/platform/files/projectBoundary.js')
const gitMod = await import('../../src/platform/git/git.js')
const { setCwd } = await import('../../src/platform/shell/shellExec.js')
const { regroundGitWatch } = await import('../../src/platform/git/gitFilesystem.js')
const health = await import('../../src/platform/health/healthReport.js')
const observe = await import('../../src/platform/git-graph/observe.js')
const wt = await import('../../src/daemon/concourse-workers/concourseWorktrees.js')
const context = await import('../../src/engine/requestContext.js')
const { enableConfigs } = await import('../../src/platform/config/globalConfig.js')
enableConfigs()
const suggestions = await import('../../src/screen/composer/typeahead/fileSuggestions.js')

console.log('B1 projectScopePathspec and launchFolderBoundsProject — the owner')
{
  check('a real project appends no pathspec from a subfolder', boundary.projectScopePathspec(SUB).length === 0, '', HINT_BOUNDARY)
  check('a folder under a HOME repository appends `-- .`', boundary.projectScopePathspec(PROJ).join(' ') === '-- .', '', HINT_BOUNDARY)
  check('a nested Documents folder resolves to the home root today (git says so)', realpathSync(voxelTop) === HOME_FX, voxelTop, 'the fixture is wrong: git rev-parse from Documents/voxel no longer answers the home root')
  check('… and appends `-- .` for the nested Documents folder', boundary.projectScopePathspec(VOXEL).join(' ') === '-- .', '', HINT_BOUNDARY)
  check('a folder outside any repository appends nothing', boundary.projectScopePathspec(OUTSIDE).length === 0, '', HINT_BOUNDARY)
  check('launchFolderBoundsProject is true only under a non-project root', boundary.launchFolderBoundsProject(PROJ) && boundary.launchFolderBoundsProject(NOTES) && !boundary.launchFolderBoundsProject(SUB) && !boundary.launchFolderBoundsProject(OUTSIDE), '', HINT_BOUNDARY)
}

type Row = { cwd: string; args: string }
function drain(): Row[] {
  const rows = readFileSync(LOG, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [cwd, args] = line.split('\t') as [string, string]
      return { cwd, args }
    })
  writeFileSync(LOG, '')
  return rows
}
const isProbe = (r: Row): boolean => /(^| )(status|add|ls-files)( |$)/.test(r.args)
const probeCwd = (r: Row): string => {
  const m = /(?:^| )-C ([^ ]+)/.exec(r.args)
  return m ? m[1]! : r.cwd
}

async function exercise(cwd: string): Promise<Row[]> {
  setCwd(cwd)
  process.chdir(cwd)
  regroundGitWatch()
  gitMod.getIsGit.cache.clear?.()
  context.getGitStatus.cache.clear?.()
  await gitMod.getIsClean()
  await context.getGitStatus()
  await health.computeWorkingTreeSha(cwd)
  observe.gitStatus(cwd)
  wt.classifyWorktreeDirt(cwd)
  suggestions.clearFileSuggestionCaches()
  suggestions.startBackgroundCacheRefresh()
  await new Promise(r => setTimeout(r, 1500))
  return drain()
}

if (process.platform === 'win32') {
  console.log('\n  [SKIP] not read on Windows: git shim requires a POSIX executable script (B2, B2b, B3)')
} else {
console.log('\nB2 the probes from a folder under a home repository carry the boundary')
{
  drain()
  const rows = await exercise(PROJ)
  const probes = rows.filter(isProbe)
  console.log(`  [PROBES] ${probes.length} status/add/ls-files calls: ${probes.map(r => `${r.args} @ ${probeCwd(r).replace(SCRATCH, '$S')}`).join(' · ')}`)
  const kinds = (needle: RegExp): Row[] => probes.filter(r => needle.test(r.args))
  check('the certificate clean flag ran bounded (status --untracked-files=all -- .)', kinds(/--untracked-files=all/).length >= 1 && kinds(/--untracked-files=all/).every(r => r.args.endsWith('-- .')), '', 'getIsClean in src/platform/git/git.ts must append the pathspec; ' + HINT_PROBE)
  check('the conversation status block ran bounded (status --short -- .)', kinds(/status --short/).length >= 1 && kinds(/status --short/).every(r => r.args.endsWith('-- .')), '', 'getGitStatus in src/engine/requestContext.ts must append the pathspec; ' + HINT_PROBE)
  check('the health digest ran bounded (add -A -- .)', kinds(/(^| )add -A/).length >= 1 && kinds(/(^| )add -A/).every(r => r.args.endsWith('-- .')), '', 'computeWorkingTreeSha in src/platform/health/healthReport.ts must append the pathspec; ' + HINT_PROBE)
  check('the project-intel status ran bounded (porcelain=v2 -- .)', kinds(/--porcelain=v2/).length >= 1 && kinds(/--porcelain=v2/).every(r => r.args.endsWith('-- .')), '', 'gitStatus in src/platform/git-graph/observe.ts must append the pathspec; ' + HINT_PROBE)
  check("the board's dirt probe ran bounded (-C <folder> status --porcelain [--untracked-files=normal] -- .)", kinds(/-C .* status --porcelain( --untracked-files=normal)? -- \.$/).length >= 1, '', 'classifyWorktreeDirt in src/daemon/concourse-workers/concourseWorktrees.ts must run -C <folder> status bounded; ' + HINT_PROBE)
  const lsFiles = kinds(/ls-files/)
  check('the @-file index listed from the boundary (ls-files … -- Desktop/proj at the root)', lsFiles.length >= 1 && lsFiles.every(r => r.args.endsWith('-- Desktop/proj')), lsFiles.map(r => r.args).join(' | '), 'the @-file index in src/screen/composer/typeahead/fileSuggestions.ts must list from the boundary with the pathspec; ' + HINT_PROBE)
  check('no status/add/ls-files probe ran unbounded', probes.every(r => r.args.endsWith('-- .') || r.args.endsWith('-- Desktop/proj')), probes.filter(r => !(r.args.endsWith('-- .') || r.args.endsWith('-- Desktop/proj'))).map(r => r.args).join(' | '), HINT_PROBE)
  check('every probe ran at or below the launch folder (never `-C <home>`)', probes.every(r => probeCwd(r) === PROJ || probeCwd(r) === HOME_FX && /ls-files/.test(r.args)), probes.map(r => probeCwd(r).replace(SCRATCH, '$S')).join(','), 'a probe ran with -C <home>; ' + HINT_PROBE)
}

console.log('\nB2b the same from a nested Documents folder (the home root, not the Desktop)')
{
  const rows = await exercise(VOXEL)
  const probes = rows.filter(isProbe)
  check('every status/add/ls-files probe from Documents/voxel carries the boundary', probes.length >= 6 && probes.every(r => r.args.endsWith('-- .') || r.args.endsWith('-- Documents/voxel')), probes.filter(r => !(r.args.endsWith('-- .') || r.args.endsWith('-- Documents/voxel'))).map(r => r.args).join(' | '), HINT_PROBE)
}

console.log('\nB3 the same probes from a real project carry no pathspec tail (nothing else changes)')
{
  const rows = await exercise(SUB)
  const probes = rows.filter(isProbe)
  console.log(`  [PROBES] ${probes.length} status/add/ls-files calls: ${probes.map(r => `${r.args} @ ${probeCwd(r).replace(SCRATCH, '$S')}`).join(' · ')}`)
  check('at least the six probe shapes ran', probes.length >= 6, String(probes.length), 'a probe site did not run: look at the exercise function in this file and the probes it calls')
  check('no probe carries a `--` pathspec tail', probes.every(r => !/ -- /.test(r.args) && !r.args.endsWith('--')), probes.filter(r => / -- /.test(r.args)).map(r => r.args).join(' | '), 'projectScopePathspec in src/platform/files/projectBoundary.ts must return no pathspec for a real project root')
  check('the @-file index listed the whole repository from its root', probes.some(r => /ls-files --recurse-submodules$/.test(r.args) && probeCwd(r) === REAL), '', 'the @-file index in src/screen/composer/typeahead/fileSuggestions.ts must list the whole repository from its root')
}
}

removeScratch(SCRATCH)
console.log(failures === 0 ? '\nprove-project-boundary: ALL LAWS HOLD' : `\nprove-project-boundary: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
