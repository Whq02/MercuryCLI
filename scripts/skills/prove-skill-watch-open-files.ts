#!/usr/bin/env bun
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
const { startFixtureApi } = await import('../lib/fixtureApi.ts')
const { seedFirstRun } = await import('../lib/firstRunSeed.ts')

const arg = (name: string): string | undefined => {
  const at = process.argv.indexOf(name)
  return at < 0 ? undefined : process.argv[at + 1]
}
const ROOT = resolve(import.meta.dir, '../..')
const DIST = resolve(arg('--dist') ?? join(ROOT, 'dist', 'mercury.mjs'))
const SRC = process.env.PROVE_SRC ?? join(ROOT, 'src')
const HOMES = Number(process.env.SKILL_WATCH_HOMES ?? '2000')
const OPEN_BUDGET = 50
const SCALE = Number(process.env.MERCURY_VSHOT_BUDGET_SCALE ?? '1')
const FIRST_REQUEST_BUDGET_MS = 60_000 * (Number.isFinite(SCALE) && SCALE > 0 ? SCALE : 1)
const SAMPLE_EVERY_MS = 2_000
const SAMPLE_UNTIL_MS = 14_000

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function buildWorld(world: string): void {
  for (let i = 0; i < HOMES; i++) {
    const home = join(world, `home-${String(i).padStart(4, '0')}`)
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, '.mercury.json'), '{"theme":"dark","hasCompletedOnboarding":true}\n')
    writeFileSync(join(home, '.apex-qualification.json'), '{"qualified":true}\n')
    writeFileSync(join(home, 'notes.txt'), 'scratch home fixture\n')
  }
  mkdirSync(join(world, 'sanity', 'pass-1'), { recursive: true })
  writeFileSync(join(world, 'sanity', 'pass-1', 'README.md'), '# sanity pass fixture\n')
}

type Held = { regularReadOnly: number; kqueue: number; inotifyWatches: number; example: string }
function heldUnder(pid: number, world: string): Held {
  const held: Held = { regularReadOnly: 0, kqueue: 0, inotifyWatches: 0, example: '' }
  if (process.platform === 'linux') {
    const fdDir = `/proc/${pid}/fd`
    for (const fd of readdirSync(fdDir)) {
      let target = ''
      try {
        target = readlinkSync(join(fdDir, fd))
      } catch {
        continue
      }
      if (target.startsWith(world + '/')) {
        held.regularReadOnly++
        if (held.example === '') held.example = target
      }
      if (target.includes('inotify')) {
        try {
          held.inotifyWatches += readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8').split('\n').filter(line => line.startsWith('inotify wd:')).length
        } catch {
          continue
        }
      }
    }
    return held
  }
  const out = spawnSync('lsof', ['-p', String(pid), '-n', '-P'], { encoding: 'utf8', maxBuffer: 1 << 30 })
  for (const line of (out.stdout ?? '').split('\n').slice(1)) {
    const cols = line.split(/\s+/)
    const fd = cols[3] ?? ''
    const type = cols[4] ?? ''
    const name = cols.slice(8).join(' ')
    if (type === 'KQUEUE') held.kqueue++
    if (type === 'REG' && fd.endsWith('r') && name.startsWith(world + '/')) {
      held.regularReadOnly++
      if (held.example === '') held.example = name
    }
  }
  return held
}

console.log('a session whose starting folder has no .mercury/skills yet holds none of that folder\'s files open: the watch that waits for the skills folder to be born follows only the .mercury/skills chain, never the folder\'s other children — and the same rule for every folder added to the session and for the config home')

console.log(`\n§1 the built product, headless, started in a folder of ${HOMES} scratch homes (three files each), the model held at its first byte`)
if (process.platform === 'win32') {
  console.log('  (not measured on win32: no lsof and no /proc — §2 carries the rule there)')
} else if (!existsSync(DIST)) {
  check('dist/mercury.mjs exists (build first — this prover drives the artifact)', false)
} else {
  const vendoredNode = join(dirname(DIST), 'vendor', 'node', 'bin', 'node')
  const node = existsSync(vendoredNode) ? vendoredNode : 'node'
  const world = mkdtempSync(join(tmpdir(), 'skill-watch-open-files-world-'))
  const scratch = mkdtempSync(join(tmpdir(), 'skill-watch-open-files-home-'))
  const home = join(scratch, 'config')
  buildWorld(world)
  seedFirstRun(home, [world])
  writeFileSync(join(home, 'settings.json'), '{}\n')
  const fixture = await startFixtureApi([{ kind: 'hang', deltas: [] }])
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERCURY_CONFIG_DIR: home,
    MERCURY_HOME: join(scratch, 'proof-home'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_LOCAL_PROBE_TARGETS: 'none',
    MERCURY_BOOT_PREFLIGHT: '0',
    MERCURY_UPDATE_NOTICE: '0',
    ANTHROPIC_BASE_URL: fixture.url,
    ANTHROPIC_API_KEY: 'fixture-key-000',
    BROWSER: '/usr/bin/true',
  }
  delete env.NODE_ENV
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.MERCURY_MODEL
  const startedAt = Date.now()
  const child = spawn(node, [DIST, 'run', 'reply with the word ready', '--format', 'text', '--sovereign', '--model', 'claude-opus-4-8'], { cwd: world, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', c => { stderr += String(c) })
  child.stdout.on('data', () => undefined)
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null
  child.on('exit', (code, signal) => { exited = { code, signal } })
  let firstRequestMs: number | null = null
  void fixture.messageRequestStarted(1).then(() => { firstRequestMs = Date.now() - startedAt })
  const endChild = (): void => { if (exited === null) child.kill('SIGKILL') }
  process.on('exit', endChild)
  let peak: Held = { regularReadOnly: 0, kqueue: 0, inotifyWatches: 0, example: '' }
  const readings: string[] = []
  try {
    while (Date.now() - startedAt < SAMPLE_UNTIL_MS && exited === null) {
      await sleep(SAMPLE_EVERY_MS)
      if (exited !== null) break
      const held = heldUnder(child.pid!, world)
      readings.push(`t=${Math.round((Date.now() - startedAt) / 1000)}s ${held.regularReadOnly} open under the world, ${held.kqueue} kqueue, ${held.inotifyWatches} inotify watches`)
      if (held.regularReadOnly + held.inotifyWatches > peak.regularReadOnly + peak.inotifyWatches) peak = held
    }
  } finally {
    endChild()
    process.off('exit', endChild)
    await fixture.close()
    rmSync(world, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
  for (const r of readings) console.log(`  ${r}`)
  console.log(`  first message request after ${firstRequestMs === null ? 'no request within the sampling window' : firstRequestMs + ' ms'}`)
  check('the session stayed up through the sampling window', exited === null, `exited ${JSON.stringify(exited)}; stderr tail: ${stderr.slice(-400)}`)
  check(`at most ${OPEN_BUDGET} of the folder's files are held open at any sample (the leak held every file of every home: ${HOMES * 3} of them)`, peak.regularReadOnly <= OPEN_BUDGET, `peak ${peak.regularReadOnly}${peak.example ? ', e.g. ' + peak.example : ''}`)
  if (process.platform === 'linux') check(`at most ${OPEN_BUDGET} inotify watches (the same leak spends one watch per file there)`, peak.inotifyWatches <= OPEN_BUDGET, `peak ${peak.inotifyWatches}`)
  check(`the first request left within ${Math.round(FIRST_REQUEST_BUDGET_MS / 1000)} s (the walk over the homes never stands between the session and its first request)`, firstRequestMs !== null && firstRequestMs <= FIRST_REQUEST_BUDGET_MS, `${firstRequestMs ?? 'none'} ms`)
}

console.log('\n§2 the rule at the seam: the birth watcher\'s ignore rule admits only the missing .mercury/skills chains')
{
  const project = mkdtempSync(join(tmpdir(), 'skill-watch-open-files-project-'))
  const home = mkdtempSync(join(tmpdir(), 'skill-watch-open-files-config-'))
  mkdirSync(join(project, 'home-0001'), { recursive: true })
  writeFileSync(join(project, 'home-0001', '.mercury.json'), '{}\n')
  mkdirSync(join(home, 'debug'), { recursive: true })
  writeFileSync(join(home, 'debug', 'old.txt'), 'log\n')
  process.env.MERCURY_CONFIG_DIR = home
  delete process.env.MERCURY_HOME
  process.chdir(project)
  const detector = await import(join(SRC, 'utils/skills/skillChangeDetector.ts'))
  type Armed = { paths: string[]; options: { depth?: number; ignored?: unknown } }
  const armed: Armed[] = []
  await detector.resetForTesting({
    watcherFactory: (paths: string[], options: unknown) => {
      armed.push({ paths, options: options as Armed['options'] })
      return { on: () => undefined, close: async () => undefined }
    },
  })
  await detector.initialize()
  const birth = armed.find(a => a.options.depth === 1)
  const rule = typeof birth?.options.ignored === 'function' ? (birth.options.ignored as (p: string) => boolean) : null
  const projectRoot = resolve(project)
  const homeRoot = resolve(home)
  check('one birth watcher armed over the starting folder and the config home (neither has a skills folder yet)', birth !== undefined && birth.paths.includes(projectRoot) && birth.paths.includes(homeRoot), JSON.stringify(armed.map(a => [a.options.depth, a.paths])))
  check('its ignore rule is a function', rule !== null, String(birth?.options.ignored))
  if (rule !== null) {
    check('a sibling home under the starting folder is ignored, and so are its files', rule(join(projectRoot, 'home-0001')) === true && rule(join(projectRoot, 'home-0001', '.mercury.json')) === true)
    check('the config home\'s other children are ignored (a debug log among them)', rule(join(homeRoot, 'debug')) === true && rule(join(homeRoot, 'debug', 'old.txt')) === true)
    check('the starting folder\'s .mercury, its skills folder and a skill born inside pass', rule(join(projectRoot, '.mercury')) === false && rule(join(projectRoot, '.mercury', 'skills')) === false && rule(join(projectRoot, '.mercury', 'skills', 'demo', 'SKILL.md')) === false)
    check('the config home\'s skills folder passes', rule(join(homeRoot, 'skills')) === false && rule(join(homeRoot, 'skills', 'demo', 'SKILL.md')) === false)
    check('the watched roots themselves pass', rule(projectRoot) === false && rule(homeRoot) === false)
  }
  await detector.dispose()
  process.chdir(ROOT)
  rmSync(project, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'prove-skill-watch-open-files: ALL LAWS HOLD' : `prove-skill-watch-open-files: ${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
