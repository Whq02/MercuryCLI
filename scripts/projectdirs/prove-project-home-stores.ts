#!/usr/bin/env bun
//        global exclude road (the settings owner's call, unchanged);
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const HOME = realpathSync(mkdtempSync(join(tmpdir(), 'project-home-home-')))
const REPO = realpathSync(mkdtempSync(join(tmpdir(), 'project-home-repo-')))
process.env.MERCURY_CONFIG_DIR = HOME
process.env.MERCURY_DOCTOR_STATE_DIR = REPO
process.env.MERCURY_EVOLUTION_LEDGER = '1'
delete process.env.MERCURY_ROUTER_STATE_DIR
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
const { adoptiveProjectPath } = await import('../../src/utils/projectStoreAdoption.ts')
const { apolloSpecDirectory } = await import('../../src/utils/projectConfig.ts')
const { workflowRunsRoot, workflowsDir } = await import('../../src/tools/WorkflowTool/runManifest.ts')
const { defaultEvolutionLedgerDir, writeEvolutionRow } = await import('../../src/utils/evolution/evolutionLedger.ts')
const { persistTestRun, testRunsDir } = await import('../../src/services/ide/pythonTests.ts')
const { themisDir, themisDirs } = await import('../../src/substrate/themis/auditChain.ts')
const { routerStateDir } = await import('../../src/substrate/routerPaths.ts')
const { getAgentMemoryDir } = await import('../../src/tools/AgentTool/agentMemory.ts')
const { unityTestResultsPath } = await import('../../src/services/ide/unityProject.ts')
const { lastCertPath, projectEstateCheck } = await import('../../src/utils/healthReport.ts')
const { getSettingsFilePathForSource } = await import('../../src/utils/settings/settings.ts')

section('H1 — the owner')
{
  const projectDir = getProjectDir(REPO)
  check('projectHomePath is the config home\'s project directory plus the segments', homeStores.projectHomePath(REPO, 'a', 'b') === join(projectDir, 'a', 'b'))
  check('…under the config home, never the project folder', projectDir.startsWith(HOME) && !homeStores.projectHomePath(REPO, 'x').startsWith(REPO))
  check('the folder spelling it migrates from is the project\'s .mercury', homeStores.projectFolderPath(REPO, 'evolution') === join(REPO, '.mercury', 'evolution'))
  check('naming a path creates nothing', !existsSync(homeStores.projectHomePath(REPO, 'nothing')) && !existsSync(join(REPO, '.mercury')))
}

section('H2 — a fresh project: the spec in the folder, every local store in the home')
{
  const specDir = apolloSpecDirectory(REPO)
  mkdirSync(specDir, { recursive: true })
  writeFileSync(join(specDir, 'spec.md'), '# the spec\n')
  const runDir = join(workflowRunsRoot(REPO), 'run-1')
  mkdirSync(runDir, { recursive: true })
  writeFileSync(join(runDir, 'run.json'), '{}\n')
  const row = await writeEvolutionRow(defaultEvolutionLedgerDir(REPO), { program: 'the-program', subject: 'the-subject', outcome: 'baseline', notes: 'one row' } as never)
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
  mkdirSync(routerStateDir(), { recursive: true })
  writeFileSync(join(routerStateDir(), 'posture.json'), '{}\n')
  const dirty = status()
  check('git status shows the spec and nothing else under .mercury/', dirty.length === 1 && dirty[0] === '.mercury/apollo/spec.md', JSON.stringify(dirty))
  check('the workflow runs root is under the config home; the by-name scripts stay in the folder', workflowRunsRoot(REPO).startsWith(HOME) && workflowsDir(REPO) === join(REPO, '.mercury', 'workflows'))
  check('the evolution ledger is under the config home', defaultEvolutionLedgerDir(REPO).startsWith(HOME) && (row as { ok?: boolean }).ok === true, JSON.stringify(row))
  check('the test-run store is under the config home', testRunsDir(REPO).startsWith(HOME) && existsSync(join(testRunsDir(REPO), 'latest.json')))
  check('the doctor certificate is under the config home', lastCertPath().startsWith(HOME))
  check('the route state is under the config home', routerStateDir().startsWith(HOME))
  check('the audit chains are under the config home', themisDir(REPO).startsWith(HOME))
  check('local-scope agent memory is under the config home; project scope stays in the folder', getAgentMemoryDir('scout', 'local').startsWith(HOME) && getAgentMemoryDir('scout', 'project').startsWith(join(REPO, '.mercury')))
  check('the unity results path is under the config home', unityTestResultsPath(REPO, 'EditMode').startsWith(HOME))
  check('the folder holds no local store', !existsSync(join(REPO, '.mercury', 'workflows')) && !existsSync(join(REPO, '.mercury', 'evolution')) && !existsSync(join(REPO, '.mercury', 'test-runs')) && !existsSync(join(REPO, '.mercury', 'doctor')) && !existsSync(join(REPO, '.mercury', 'router')))
  const estate = await projectEstateCheck()
  check('the doctor\'s Project estate row reads ok', estate.status === 'ok', JSON.stringify(estate))
}

section('H3 — the migration: read once, the folder copy stays, the doctor names it')
{
  const REPO2 = realpathSync(mkdtempSync(join(tmpdir(), 'project-home-repo2-')))
  const git2 = (...args: string[]): string => execFileSync('git', args, { cwd: REPO2, encoding: 'utf8' })
  git2('init', '-q')
  mkdirSync(join(REPO2, '.mercury', 'evolution'), { recursive: true })
  writeFileSync(join(REPO2, '.mercury', 'evolution', 'the-program-abc.jsonl'), '{"ts":"t","program":"the-program","outcome":"ok"}\n')
  mkdirSync(join(REPO2, '.mercury', 'themis', 'chains'), { recursive: true })
  writeFileSync(join(REPO2, '.mercury', 'themis', 'chains', 'a.jsonl'), '{}\n')
  writeFileSync(join(REPO2, '.mercury', 'themis', 'chains', 'a.jsonl.sig'), 'sidecar\n')
  git2('add', '.')
  git2('-c', 'user.email=p@p', '-c', 'user.name=proof', 'commit', '-q', '-m', 'seed with a local store')
  const homeLedger = defaultEvolutionLedgerDir(REPO2)
  check('the first touch copies the folder store to the home', existsSync(join(homeLedger, 'the-program-abc.jsonl')), homeLedger)
  check('the folder copy stays', existsSync(join(REPO2, '.mercury', 'evolution', 'the-program-abc.jsonl')))
  const homeThemis = themisDir(REPO2)
  check('a chain moves whole — its sidecar with it', existsSync(join(homeThemis, 'chains', 'a.jsonl')) && existsSync(join(homeThemis, 'chains', 'a.jsonl.sig')))
  check('verification merges the home store and the folder copy', themisDirs(REPO2)[0] === homeThemis && themisDirs(REPO2).includes(join(REPO2, '.mercury', 'themis')))
  const leftovers = homeStores.projectHomeLeftovers(REPO2)
  check('the leftover census names the folder copies', JSON.stringify(leftovers.sort()) === JSON.stringify(['.mercury/evolution', '.mercury/themis']), JSON.stringify(leftovers))
  process.env.MERCURY_DOCTOR_STATE_DIR = REPO2
  const estate = await projectEstateCheck()
  check('the doctor\'s Project estate row warns and names them', estate.status === 'warn' && (estate.evidence ?? '').includes('.mercury/evolution') && (estate.evidence ?? '').includes('.mercury/themis'), JSON.stringify(estate))
  check('…with the one git line that untracks the tracked ones', /git rm -r --cached ".mercury\/evolution" ".mercury\/themis"/.test(estate.fix ?? ''), estate.fix)
  check('…and the words that Mercury deletes nothing', /never deletes/.test(estate.detail ?? ''), estate.detail)
  writeFileSync(join(homeLedger, 'the-program-abc.jsonl'), 'home rows\n')
  check('a later touch never overwrites the home copy', homeStores.projectHomeStore(REPO2, 'evolution') === homeLedger && readFileSync(join(homeLedger, 'the-program-abc.jsonl'), 'utf8') === 'home rows\n')
  rmSync(join(REPO2, '.mercury', 'evolution'), { recursive: true, force: true })
  rmSync(join(REPO2, '.mercury', 'themis'), { recursive: true, force: true })
  const clean = await projectEstateCheck()
  check('the row reads ok once the folder copies are gone', clean.status === 'ok', JSON.stringify(clean))
  process.env.MERCURY_DOCTOR_STATE_DIR = REPO
  rmSync(REPO2, { recursive: true, force: true })
}

section('H4 — the shared set stays in the project folder')
{
  check('settings.json resolves in the project folder', adoptiveProjectPath(REPO, 'settings.json') === join(REPO, '.mercury', 'settings.json'))
  check('the machine-local settings file resolves in the project folder too (its global exclude is the settings owner\'s road)', String(getSettingsFilePathForSource('localSettings')).endsWith(join('.mercury', 'settings.local.json')))
  const settingsSource = readFileSync(join(import.meta.dir, '../../src/utils/settings/settings.ts'), 'utf8')
  check('the settings owner still routes the local file through the global-ignore helper', /source === 'localSettings'[\s\S]{0,120}addFileGlobRuleToGitignore\(getRelativeSettingsFilePathForSource\('localSettings'\)\)/.test(settingsSource))
  check('no ignore file was written into the project', !existsSync(join(REPO, '.gitignore')) && !existsSync(join(REPO, '.mercury', '.gitignore')) && !existsSync(join(REPO, '.git', 'info', 'exclude')) || readFileSync(join(REPO, '.git', 'info', 'exclude'), 'utf8').split('\n').every(l => !l.includes('.mercury')))
}

section('H5 — the census')
{
  const named = homeStores.PROJECT_HOME_STORES.map(s => s.join('/')).sort()
  check('every store the home road serves is in the census', JSON.stringify(named) === JSON.stringify(['agent-memory-local', 'doctor', 'evolution', 'ide-transactions', 'reviews', 'router', 'test-runs', 'themis', 'unity-test-results', 'workflows/runs']), JSON.stringify(named))
  check('the census is a path list, relative to the folder home', named.every(n => !n.startsWith('/') && !n.includes('..')))
  console.log(`  [record] the config home's project directory: ${relative(HOME, getProjectDir(REPO))}`)
}

rmSync(HOME, { recursive: true, force: true })
rmSync(REPO, { recursive: true, force: true })
console.log(`\n ${checks} checks, ${failures} failures`)
process.exit(failures === 0 ? 0 : 1)
