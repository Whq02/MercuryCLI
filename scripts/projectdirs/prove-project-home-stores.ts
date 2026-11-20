#!/usr/bin/env bun
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'project-home-home-')))
const REPO = realpathSync(mkdtempSync(join(tmpdir(), 'project-home-repo-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_HEALTH_STATE_DIR = REPO
process.env.MERCURY_EVOLUTION_LEDGER = '1'
delete process.env.MERCURY_WORKSPACE_EVIDENCE
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const git = (...args: string[]): string => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' })
git('init', '-q')
writeFileSync(join(REPO, 'README.md'), '# a project\n')
git('add', '.')
git('-c', 'user.email=p@p', '-c', 'user.name=proof', 'commit', '-q', '-m', 'seed')
process.chdir(REPO)

let failures = 0
let checks = 0
const check = (label: string, ok: boolean, detail = ''): void => {
  checks++
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const status = (): string[] =>
  git('status', '--porcelain', '--untracked-files=all')
    .split('\n')
    .filter(l => l.trim() !== '')
    .map(l => l.slice(3).trim())

const homeStores = await import('../../src/utils/projectHomeStores.ts')
const { getProjectDir } = await import('../../src/utils/sessionStoragePortable.ts')
const { projectLocalPath } = await import('../../src/services/projectLocal/paths.ts')
const { apolloSpecDirectory } = await import('../../src/utils/projectConfig.ts')
const { persistTestRun, testRunsDir } = await import('../../src/services/ide/pythonTests.ts')
const { getAgentMemoryDir } = await import('../../src/tools/AgentTool/agentMemory.ts')
const { unityTestResultsPath } = await import('../../src/services/ide/unityProject.ts')
const { lastCertPath, projectEstateCheck } = await import('../../src/services/health/healthReport.ts')
const { getSettingsFilePathForSource } = await import('../../src/utils/settings/settings.ts')

section('H1 — the owner')
{
  const projectDir = getProjectDir(REPO)
  check('projectHomePath is the config home\'s project directory plus the segments', homeStores.projectHomePath(REPO, 'a', 'b') === join(projectDir, 'a', 'b'))
  check('…under the config home, never the project folder', projectDir.startsWith(HOME) && !homeStores.projectHomePath(REPO, 'x').startsWith(REPO))
  check('the folder spelling it migrates from is the project\'s .mercury', homeStores.projectFolderPath(REPO, 'reviews') === join(REPO, '.mercury', 'reviews'))
  check('naming a path creates nothing', !existsSync(homeStores.projectHomePath(REPO, 'nothing')) && !existsSync(join(REPO, '.mercury')))
}

section('H2 — a fresh project: the spec in the folder, every local store in the home')
{
  const specDir = apolloSpecDirectory(REPO)
  mkdirSync(specDir, { recursive: true })
  writeFileSync(join(specDir, 'spec.md'), '# the spec\n')
  await persistTestRun(REPO, {
    schema: 1,
    id: 'run-1-pytest',
    framework: 'pytest',
    selection: 'all',
    command: ['pytest'],
    cwd: REPO,
    interpreter: 'python3',
    startedAt: Date.now(),
    durationMs: 1,
    counts: { passed: 1, failed: 0, skipped: 0, errored: 0 },
    cases: [],
    failures: [],
  } as never)
  mkdirSync(join(lastCertPath(), '..'), { recursive: true })
  writeFileSync(lastCertPath(), '{}\n')
  const reviewsHome = homeStores.projectHomeStore(REPO, 'reviews')
  mkdirSync(reviewsHome, { recursive: true })
  writeFileSync(join(reviewsHome, 'latest.json'), '{}\n')
  const dirty = status()
  check('git status shows the spec and nothing else under .mercury/', dirty.length === 1 && dirty[0] === '.mercury/apollo/spec.md', JSON.stringify(dirty))
  check('the test-run store is under the config home', testRunsDir(REPO).startsWith(HOME) && existsSync(join(testRunsDir(REPO), 'latest.json')))
  check('the health certificate is under the config home', lastCertPath().startsWith(HOME))
  check('the review store is under the config home', reviewsHome.startsWith(HOME))
  check('local-scope agent memory is under the config home; project scope stays in the folder', getAgentMemoryDir('scout', 'local').startsWith(HOME) && getAgentMemoryDir('scout', 'project').startsWith(join(REPO, '.mercury')))
  check("the unity results path is the editor's output inside the project (the bridge package's fence), never a home store", unityTestResultsPath(REPO, 'EditMode').startsWith(join(REPO, '.mercury')) && !unityTestResultsPath(REPO, 'EditMode').startsWith(HOME))
  check('the folder holds no local store', !existsSync(join(REPO, '.mercury', 'workflows')) && !existsSync(join(REPO, '.mercury', 'test-runs')) && !existsSync(join(REPO, '.mercury', 'health')) && !existsSync(join(REPO, '.mercury', 'reviews')))
  const estate = await projectEstateCheck()
  check('/health\'s Project estate row reads ok', estate.status === 'ok', JSON.stringify(estate))
}

section('H3 — the migration: read once, the folder copy stays, /health names it')
{
  const REPO2 = realpathSync(mkdtempSync(join(tmpdir(), 'project-home-repo2-')))
  const git2 = (...args: string[]): string => execFileSync('git', args, { cwd: REPO2, encoding: 'utf8' })
  git2('init', '-q')
  mkdirSync(join(REPO2, '.mercury', 'reviews'), { recursive: true })
  writeFileSync(join(REPO2, '.mercury', 'reviews', 'latest.json'), '{}\n')
  git2('add', '.')
  git2('-c', 'user.email=p@p', '-c', 'user.name=proof', 'commit', '-q', '-m', 'seed with a local store')
  const homeReviews = homeStores.projectHomeStore(REPO2, 'reviews')
  writeFileSync(join(homeReviews, 'latest.json'), '{}\n')
  check('the first touch seeds the home store beside the folder copy', existsSync(join(homeReviews, 'latest.json')), homeReviews)
  check('the folder copy stays', existsSync(join(REPO2, '.mercury', 'reviews', 'latest.json')))
  const leftovers = homeStores.projectHomeLeftovers(REPO2)
  check('the leftover census names the folder copies', JSON.stringify(leftovers.sort()) === JSON.stringify(['.mercury/reviews']), JSON.stringify(leftovers))
  process.env.MERCURY_HEALTH_STATE_DIR = REPO2
  const estate = await projectEstateCheck()
  check('/health\'s Project estate row warns and names them', estate.status === 'warn' && (estate.evidence ?? '').includes('.mercury/reviews'), JSON.stringify(estate))
  check('…with the one git line that untracks the tracked ones', /git rm -r --cached ".mercury\/reviews"/.test(estate.fix ?? ''), estate.fix)
  check('…and the words that Mercury deletes nothing', /never deletes/.test(estate.detail ?? ''), estate.detail)
  writeFileSync(join(homeReviews, 'latest.json'), 'home rows\n')
  check('a later touch never overwrites the home copy', homeStores.projectHomeStore(REPO2, 'reviews') === homeReviews && readFileSync(join(homeReviews, 'latest.json'), 'utf8') === 'home rows\n')
  rmSync(join(REPO2, '.mercury', 'reviews'), { recursive: true, force: true })
  const clean = await projectEstateCheck()
  check('the row reads ok once the folder copies are gone', clean.status === 'ok', JSON.stringify(clean))
  process.env.MERCURY_HEALTH_STATE_DIR = REPO
  rmSync(REPO2, { recursive: true, force: true })
}

section('H4 — the shared set stays in the project folder')
{
  check('settings.json resolves in the project folder', projectLocalPath(REPO, 'settings.json') === join(REPO, '.mercury', 'settings.json'))
  check('the machine-local settings file resolves in the project folder too (its global exclude is the settings owner\'s road)', String(getSettingsFilePathForSource('localSettings')).endsWith(join('.mercury', 'settings.local.json')))
  check('no ignore file was written into the project', !existsSync(join(REPO, '.gitignore')) && !existsSync(join(REPO, '.mercury', '.gitignore')) && !existsSync(join(REPO, '.git', 'info', 'exclude')) || readFileSync(join(REPO, '.git', 'info', 'exclude'), 'utf8').split('\n').every(l => !l.includes('.mercury')))
}

section('H5 — the census')
{
  const named = homeStores.PROJECT_HOME_STORES.map(s => s.join('/')).sort()
  check('every store the home road serves is in the census', JSON.stringify(named) === JSON.stringify(['agent-memory-local', 'health', 'ide-transactions', 'reviews', 'test-runs', 'workflows/runs']), JSON.stringify(named))
  check('the census is a path list, relative to the folder home', named.every(n => !n.startsWith('/') && !n.includes('..')))
  console.log(`  [record] the config home's project directory: ${relative(HOME, getProjectDir(REPO))}`)
}

section('H6 — running from the user home or config-home parent never migrates or flags .mercury stores')
{
  const FAKE_HOME = realpathSync(mkdtempSync(join(tmpdir(), 'project-home-user-')))
  const FAKE_PARENT = realpathSync(mkdtempSync(join(tmpdir(), 'project-home-parent-')))
  const fakeHomeConfig = join(FAKE_HOME, '.mercury')
  const fakeParentConfig = join(FAKE_PARENT, '.mercury')
  mkdirSync(join(fakeHomeConfig, 'health', 'other-project'), { recursive: true })
  writeFileSync(join(fakeHomeConfig, 'health', 'other-project', 'last-preflight.json'), '{"other":true}\n')
  mkdirSync(join(fakeParentConfig, 'health', 'other-project'), { recursive: true })
  writeFileSync(join(fakeParentConfig, 'health', 'other-project', 'last-preflight.json'), '{"other":true}\n')
  const subproject = join(FAKE_HOME, 'child-project')
  mkdirSync(join(subproject, '.mercury', 'reviews'), { recursive: true })
  writeFileSync(join(subproject, '.mercury', 'reviews', 'latest.json'), '{"review":1}\n')
  const savedHome = process.env.HOME
  const savedConfigDir = process.env.MERCURY_CONFIG_DIR
  const savedHealthStateDir = process.env.MERCURY_HEALTH_STATE_DIR
  const withPlatform = <T,>(platform: NodeJS.Platform, fn: () => T): T => {
    const desc = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    try {
      return fn()
    } finally {
      Object.defineProperty(process, 'platform', desc)
    }
  }
  try {
    process.env.HOME = FAKE_HOME
    process.env.MERCURY_CONFIG_DIR = HOME
    process.env.MERCURY_HEALTH_STATE_DIR = FAKE_HOME
    const scratchHealth = homeStores.projectHomeStore(FAKE_HOME, 'health')
    check('from the user home with a scratch config home, ~/.mercury/health is not copied into the scratch store', !existsSync(join(scratchHealth, 'other-project', 'last-preflight.json')), scratchHealth)
    const scratchLeftovers = homeStores.projectHomeLeftovers(FAKE_HOME)
    check('from the user home with a scratch config home, leftovers skips ~/.mercury stores', scratchLeftovers.length === 0, JSON.stringify(scratchLeftovers))
    const scratchEstate = await projectEstateCheck()
    check('from the user home with a scratch config home, /health Project estate reads ok', scratchEstate.status === 'ok', JSON.stringify(scratchEstate))

    process.env.HOME = savedHome
    process.env.MERCURY_CONFIG_DIR = fakeParentConfig
    process.env.MERCURY_HEALTH_STATE_DIR = FAKE_PARENT
    const ownHealth = homeStores.projectHomeStore(FAKE_PARENT, 'health')
    check('from the parent of the active config home, <root>/.mercury/health is not copied into projects/', !existsSync(join(ownHealth, 'other-project', 'last-preflight.json')), ownHealth)
    const ownLeftovers = homeStores.projectHomeLeftovers(FAKE_PARENT)
    check('from the parent of the active config home, leftovers skips <root>/.mercury stores', ownLeftovers.length === 0, JSON.stringify(ownLeftovers))
    const ownEstate = await projectEstateCheck()
    check('from the parent of the active config home, /health Project estate reads ok', ownEstate.status === 'ok', JSON.stringify(ownEstate))

    process.env.MERCURY_CONFIG_DIR = fakeParentConfig.toUpperCase().replaceAll('/', '\\')
    const win32Leftovers = withPlatform('win32', () => homeStores.projectHomeLeftovers(FAKE_PARENT))
    check('on win32, case and separator differences between <root>/.mercury and the config home still match', win32Leftovers.length === 0, JSON.stringify(win32Leftovers))

    process.env.HOME = FAKE_HOME
    process.env.MERCURY_CONFIG_DIR = HOME
    const childReviews = homeStores.projectHomeStore(subproject, 'reviews')
    check('a child project under the user home still migrates its own .mercury store', existsSync(join(childReviews, 'latest.json')), childReviews)
    const childLeftovers = homeStores.projectHomeLeftovers(subproject)
    check('a child project under the user home still reports its own leftover store', JSON.stringify(childLeftovers) === JSON.stringify(['.mercury/reviews']), JSON.stringify(childLeftovers))
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    if (savedConfigDir === undefined) delete process.env.MERCURY_CONFIG_DIR
    else process.env.MERCURY_CONFIG_DIR = savedConfigDir
    if (savedHealthStateDir === undefined) delete process.env.MERCURY_HEALTH_STATE_DIR
    else process.env.MERCURY_HEALTH_STATE_DIR = savedHealthStateDir
    rmSync(FAKE_HOME, { recursive: true, force: true })
    rmSync(FAKE_PARENT, { recursive: true, force: true })
  }
}

rmSync(HOME, { recursive: true, force: true })
rmSync(REPO, { recursive: true, force: true })
console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
