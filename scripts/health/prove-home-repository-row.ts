#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.chdir(join(import.meta.dir, '..', '..'))
const REPO = process.cwd()
const BIN = join(REPO, 'dist', 'mercury.mjs')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'home-repo-row-')))
const HOME_FX = join(SCRATCH, 'home')
const DESKTOP = join(HOME_FX, 'Desktop')
const PROJECT = join(SCRATCH, 'project')
const CFG = join(SCRATCH, 'cfg')
for (const d of [DESKTOP, PROJECT, CFG]) mkdirSync(d, { recursive: true })
writeFileSync(join(PROJECT, 'README.md'), '# project\n')
const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.email=p@p', '-c', 'user.name=proof', ...args], { cwd, stdio: 'ignore', env: { ...process.env, HOME: HOME_FX } })
}
const MERCURY_BASE = 'mercury: base commit — forking unlocked'
const seedHome = (): void => {
  git(HOME_FX, 'init', '-q')
  git(HOME_FX, 'commit', '-q', '--allow-empty', '-m', MERCURY_BASE)
}
seedHome()
git(DESKTOP, 'init', '-q')
git(DESKTOP, 'commit', '-q', '--allow-empty', '-m', 'first')
git(DESKTOP, 'commit', '-q', '--allow-empty', '-m', 'second')

process.env.HOME = HOME_FX
process.env.USERPROFILE = HOME_FX
process.env.MERCURY_CONFIG_DIR = CFG
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_HOME
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}

const { setCwd } = await import('../../src/utils/Shell.js')
const { regroundGitWatch } = await import('../../src/utils/git/gitFilesystem.js')
const report = await import('../../src/utils/healthReport.js')
setCwd(PROJECT)
process.chdir(PROJECT)
regroundGitWatch()

console.log('§1 the fixture home (Mercury-made) and a foreign Desktop repository read red')
{
  const r = await report.homeRepositoryCheck()
  check('status is fail', r.status === 'fail', r.status)
  check('the evidence names the home path', r.evidence.includes(HOME_FX), r.evidence)
  check('the evidence carries the .git creation date', /\.git created \d{4}-\d{2}-\d{2}/.test(r.evidence), r.evidence)
  check('the evidence says Mercury made the home repository', r.evidence.includes('made by Mercury (its base commit is the only commit)'), r.evidence)
  check("the evidence says the Desktop repository is not Mercury's", r.evidence.includes(DESKTOP) && r.evidence.includes("not Mercury's (2 commits"), r.evidence)
  const fix = r.fix ?? ''
  check('the fix carries the sh inspect words for the home', fix.includes('git -C "$HOME" log --oneline'), fix)
  check('the fix carries the sh removal words for the home', fix.includes('rm -rf "$HOME/.git"'), fix)
  check('the fix keeps a foreign repository ("keep it if it is yours") and names its removal words', fix.includes('keep it if it is yours') && fix.includes('rm -rf "$HOME/Desktop/.git"'), fix)
  check('the check is functional evidence', r.probe === 'functional')
  check('the detail explains the swallow and says Mercury removes nothing', (r.detail ?? '').includes('removes nothing'), r.detail)
}

console.log('\n§2 the PowerShell words survive a markdown paste (no $_, no backslash before punctuation)')
{
  const home = report.homeRepositoryRemovalWords(HOME_FX, 'win32')
  check('inspect: git -C $env:USERPROFILE log --oneline', home.inspect === 'git -C $env:USERPROFILE log --oneline', home.inspect)
  check("remove: Remove-Item -Recurse -Force ([IO.Path]::Combine($env:USERPROFILE, '.git'))", home.remove === "Remove-Item -Recurse -Force ([IO.Path]::Combine($env:USERPROFILE, '.git'))", home.remove)
  const desk = report.homeRepositoryRemovalWords(DESKTOP, 'win32')
  check("Desktop: Combine($env:USERPROFILE, 'Desktop', '.git')", desk.remove === "Remove-Item -Recurse -Force ([IO.Path]::Combine($env:USERPROFILE, 'Desktop', '.git'))", desk.remove)
  check('Desktop inspect goes through Combine too', desk.inspect === "git -C ([IO.Path]::Combine($env:USERPROFILE, 'Desktop')) log --oneline", desk.inspect)
  const all = [home.inspect, home.remove, desk.inspect, desk.remove].join('\n')
  check('no $_ and no backslash anywhere in the PowerShell words', !all.includes('$_') && !all.includes('\\'))
  const sh = report.homeRepositoryRemovalWords(DESKTOP, 'darwin')
  check('the sh words for a user folder', sh.inspect === 'git -C "$HOME/Desktop" log --oneline' && sh.remove === 'rm -rf "$HOME/Desktop/.git"', `${sh.inspect} · ${sh.remove}`)
}

console.log('\n§3 the certificate carries the check in its GIT section')
{
  const cert = await report.runHealthReport({ depth: 'fast' })
  const section = cert.sections.find(s => s.id === 'git')
  const row = section?.checks.find(c => c.id === 'home-repository')
  check('the GIT section carries home-repository', row !== undefined, section?.checks.map(c => c.id).join(','))
  check('… red on the fixture home', row?.status === 'fail', row?.status)
  check('… labelled Home repository', row?.label === 'Home repository', row?.label)
}

console.log('\n§4 a normal home reads green')
{
  rmSync(join(HOME_FX, '.git'), { recursive: true, force: true })
  rmSync(join(DESKTOP, '.git'), { recursive: true, force: true })
  const r = await report.homeRepositoryCheck()
  check('status is ok', r.status === 'ok', r.status)
  check('the evidence names the home and its user folders', r.evidence.includes(HOME_FX) && r.evidence.includes('user folders'), r.evidence)
  check('no fix words on a green row', r.fix === undefined)
}

console.log('\n§5 `mercury doctor --json` on the built bundle carries the row')
{
  if (!existsSync(BIN)) {
    check('dist/mercury.mjs present (run `bun run build.ts` first)', false, BIN)
  } else {
    seedHome()
    let stdout = ''
    let status = 0
    try {
      stdout = execFileSync('node', [BIN, 'doctor', '--json'], {
        cwd: PROJECT,
        env: {
          ...process.env,
          HOME: HOME_FX,
          USERPROFILE: HOME_FX,
          MERCURY_CONFIG_DIR: CFG,
          MERCURY_CREDENTIAL_STORE: 'file',
          NODE_ENV: undefined,
        },
        encoding: 'utf8',
        timeout: 60_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e: unknown) {
      const err = e as { status?: number; stdout?: string }
      status = err.status ?? -1
      stdout = err.stdout ?? ''
    }
    check('the doctor produced a certificate (exit 0 or 3)', status === 0 || status === 3, `status=${status}`)
    let cert: { sections?: Array<{ id: string; checks: Array<{ id: string; status: string; evidence?: string; fix?: string }> }> } | null = null
    try {
      cert = JSON.parse(stdout)
    } catch {
      cert = null
    }
    const row = cert?.sections?.flatMap(s => s.checks).find(c => c.id === 'home-repository')
    check('the JSON carries home-repository', row !== undefined)
    check('… red, naming the fixture home', row?.status === 'fail' && (row.evidence ?? '').includes(HOME_FX), JSON.stringify(row))
    check('… with the removal words', (row?.fix ?? '').includes('rm -rf "$HOME/.git"'), row?.fix)
  }
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-home-repository-row: all green' : `\nprove-home-repository-row: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
