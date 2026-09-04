#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.chdir(join(import.meta.dir, '..', '..'))
const REAL_GIT = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'project-boundary-')))
const HOME_FX = join(SCRATCH, 'home')
const PROJ = join(HOME_FX, 'Desktop', 'proj')
const DOCS = join(HOME_FX, 'Documents')
const NOTES = join(DOCS, 'notes-proj')
const REAL = join(SCRATCH, 'real')
const SUB = join(REAL, 'sub')
const OUTSIDE = join(SCRATCH, 'outside')
const BIN = join(SCRATCH, 'bin')
const LOG = join(SCRATCH, 'git.log')
const CFG = join(SCRATCH, 'cfg')
for (const d of [join(PROJ, 'src'), NOTES, SUB, OUTSIDE, BIN, CFG]) mkdirSync(d, { recursive: true })
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
git(DOCS, 'init', '-q')
git(DOCS, 'commit', '-q', '--allow-empty', '-m', 'docs')
git(REAL, 'init', '-q')
git(REAL, 'add', '.')
git(REAL, 'commit', '-q', '-m', 'seed')
writeFileSync(join(BIN, 'git'), `#!/bin/sh\nprintf '%s\\t%s\\n' "$PWD" "$*" >> '${LOG}'\nexec '${REAL_GIT}' "$@"\n`)
chmodSync(join(BIN, 'git'), 0o755)
writeFileSync(LOG, '')
process.env.PATH = `${BIN}:${process.env.PATH ?? ''}`
process.env.HOME = HOME_FX
process.env.USERPROFILE = HOME_FX
process.env.MERCURY_CONFIG_DIR = CFG
delete process.env.MERCURY_HOME
delete process.env.NODE_ENV
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const boundary = await import('../../src/utils/projectBoundary.js')
const gitMod = await import('../../src/utils/git.js')
const { setCwd } = await import('../../src/utils/Shell.js')
const { regroundGitWatch } = await import('../../src/utils/git/gitFilesystem.js')
const health = await import('../../src/utils/healthReport.js')
const observe = await import('../../src/services/gitGraph/observe.js')
const wt = await import('../../src/daemon/concourseWorktrees.js')
const context = await import('../../src/context.js')
const { enableConfigs } = await import('../../src/utils/config/globalConfig.js')
enableConfigs()
const suggestions = await import('../../src/hooks/fileSuggestions.js')

console.log('B1 projectBoundaryOf — the owner')
{
  check('a real project answers its git root from a subfolder', boundary.projectBoundaryOf(SUB) === REAL, boundary.projectBoundaryOf(SUB))
  check('… and appends no pathspec', boundary.projectScopePathspec(SUB).length === 0)
  check('a folder under a HOME repository answers itself', boundary.projectBoundaryOf(PROJ) === PROJ, boundary.projectBoundaryOf(PROJ))
  check('… and appends `-- .`', boundary.projectScopePathspec(PROJ).join(' ') === '-- .')
  check('a folder under a user-folder repository (Documents) answers itself', boundary.projectBoundaryOf(NOTES) === NOTES, boundary.projectBoundaryOf(NOTES))
  check('the home itself answers itself', boundary.projectBoundaryOf(HOME_FX) === HOME_FX)
  check('a folder outside any repository answers itself and appends nothing', boundary.projectBoundaryOf(OUTSIDE) === OUTSIDE && boundary.projectScopePathspec(OUTSIDE).length === 0)
  check('launchFolderBoundsProject is true only under a non-project root', boundary.launchFolderBoundsProject(PROJ) && boundary.launchFolderBoundsProject(NOTES) && !boundary.launchFolderBoundsProject(SUB) && !boundary.launchFolderBoundsProject(OUTSIDE))
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
  await gitMod.getFileStatus()
  await context.getGitStatus()
  await health.computeWorkingTreeSha(cwd)
  observe.gitStatus(cwd)
  wt.classifyWorktreeDirt(cwd)
  suggestions.clearFileSuggestionCaches()
  suggestions.startBackgroundCacheRefresh()
  await new Promise(r => setTimeout(r, 1500))
  return drain()
}

console.log('\nB2 the probes from a folder under a home repository carry the boundary')
{
  drain()
  const rows = await exercise(PROJ)
  const probes = rows.filter(isProbe)
  console.log(`  [PROBES] ${probes.length} status/add/ls-files calls: ${probes.map(r => `${r.args} @ ${probeCwd(r).replace(SCRATCH, '$S')}`).join(' · ')}`)
  const kinds = (needle: RegExp): Row[] => probes.filter(r => needle.test(r.args))
  check('the certificate clean flag ran bounded (status --untracked-files=all -- .)', kinds(/--untracked-files=all/).length >= 1 && kinds(/--untracked-files=all/).every(r => r.args.endsWith('-- .')))
  check('the file status ran bounded (status --porcelain -z -- .)', kinds(/--porcelain -z/).length >= 1 && kinds(/--porcelain -z/).every(r => r.args.endsWith('-- .')))
  check('the conversation status block ran bounded (status --short -- .)', kinds(/status --short/).length >= 1 && kinds(/status --short/).every(r => r.args.endsWith('-- .')))
  check('the health digest ran bounded (add -A -- .)', kinds(/(^| )add -A/).length >= 1 && kinds(/(^| )add -A/).every(r => r.args.endsWith('-- .')))
  check('the project-intel status ran bounded (porcelain=v2 -- .)', kinds(/--porcelain=v2/).length >= 1 && kinds(/--porcelain=v2/).every(r => r.args.endsWith('-- .')))
  check("the board's dirt probe ran bounded (-C <folder> status --porcelain -- .)", kinds(/-C .* status --porcelain -- \.$/).length >= 1)
  const lsFiles = kinds(/ls-files/)
  check('the @-file index listed from the boundary (ls-files … -- Desktop/proj at the root)', lsFiles.length >= 1 && lsFiles.every(r => r.args.endsWith('-- Desktop/proj')), lsFiles.map(r => r.args).join(' | '))
  check('no status/add/ls-files probe ran unbounded', probes.every(r => r.args.endsWith('-- .') || r.args.endsWith('-- Desktop/proj')), probes.filter(r => !(r.args.endsWith('-- .') || r.args.endsWith('-- Desktop/proj'))).map(r => r.args).join(' | '))
  check('every probe ran at or below the launch folder (never `-C <home>`)', probes.every(r => probeCwd(r) === PROJ || probeCwd(r) === HOME_FX && /ls-files/.test(r.args)), probes.map(r => probeCwd(r).replace(SCRATCH, '$S')).join(','))
}

console.log('\nB3 the same probes from a real project carry no pathspec tail (nothing else changes)')
{
  const rows = await exercise(SUB)
  const probes = rows.filter(isProbe)
  console.log(`  [PROBES] ${probes.length} status/add/ls-files calls: ${probes.map(r => `${r.args} @ ${probeCwd(r).replace(SCRATCH, '$S')}`).join(' · ')}`)
  check('at least the six probe shapes ran', probes.length >= 6, String(probes.length))
  check('no probe carries a `--` pathspec tail', probes.every(r => !/ -- /.test(r.args) && !r.args.endsWith('--')), probes.filter(r => / -- /.test(r.args)).map(r => r.args).join(' | '))
  check('the @-file index listed the whole repository from its root', probes.some(r => /ls-files --recurse-submodules$/.test(r.args) && probeCwd(r) === REAL))
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-project-boundary: ALL LAWS HOLD' : `\nprove-project-boundary: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
