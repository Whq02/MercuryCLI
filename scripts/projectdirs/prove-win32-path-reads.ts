import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'win32-path-reads-')))
const HOME = join(SCRATCH, 'home')
mkdirSync(HOME, { recursive: true })
process.env.MERCURY_CONFIG_DIR = HOME
process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const record = (label: string, detail: string): void => console.log(`  [record] ${label}: ${detail}`)
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)
const source = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8')

const withPlatform = <T,>(platform: string, fn: () => T): T => {
  const desc = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', desc)
  }
}

type Reads = typeof import('../lib/platformPath.ts')
let reads: Reads | null = null
try {
  reads = await import('../lib/platformPath.ts')
} catch {
  reads = null
}

section("§1 the estate walk's names are read with the platform's path semantics, never a slice at the host separator")
{
  const estate = win32.join('C:\\Users\\r\\AppData\\Local\\Temp\\estate-caps-x', 'small')
  const answer = [
    win32.join(estate, 'A.MD'),
    win32.join(estate, 'b.md'),
    win32.join(estate, 'linked', 'd.md'),
    win32.join(estate, 'nested', 'c.md'),
  ].sort()
  const expected = ['A.MD', 'b.md', 'linked/d.md', 'nested/c.md']
  const loop = win32.join('C:\\Users\\r\\AppData\\Local\\Temp\\estate-caps-x', 'loop')
  const looped = win32.join(loop, 'inner', 'x.md')
  const hostSlice = answer.map(f => f.slice(estate.length + 1))
  record("the walk's win32 answer sliced at the host separator", hostSlice.join(', '))
  if (reads) {
    const r = reads
    check(
      'the names read A.MD, b.md, linked/d.md, nested/c.md (relativeSlashed, win32)',
      JSON.stringify(answer.map(f => r.relativeSlashed(estate, f, 'win32'))) === JSON.stringify(expected),
      answer.map(f => r.relativeSlashed(estate, f, 'win32')).join(', '),
    )
    check('the looped file reads inner/x.md', r.relativeSlashed(loop, looped, 'win32') === 'inner/x.md', r.relativeSlashed(loop, looped, 'win32'))
    check(
      'under the process.platform seam set to win32 the default read agrees',
      withPlatform('win32', () => JSON.stringify(answer.map(f => r.relativeSlashed(estate, f))) === JSON.stringify(expected) && r.relativeSlashed(loop, looped) === 'inner/x.md'),
    )
    check(
      'the POSIX arm is untouched',
      r.relativeSlashed('/private/tmp/estate-caps-x/small', '/private/tmp/estate-caps-x/small/linked/d.md', 'darwin') === 'linked/d.md' &&
        withPlatform('linux', () => r.relativeSlashed('/tmp/estate-caps-x/loop', '/tmp/estate-caps-x/loop/inner/x.md') === 'inner/x.md'),
    )
  } else {
    check(
      'the platform-path reads have an owner (scripts/lib/platformPath.ts)',
      false,
      `absent — the names are read by a slice at the host separator: on win32 the walk's answer reads as ${hostSlice.join(', ')}, and the looped file as ${looped}`,
    )
  }
  const proof = source('scripts', 'projectdirs', 'prove-estate-walk-caps.ts')
  check(
    'prove-estate-walk-caps.ts reads the names through relativeSlashed',
    proof.includes("from '../lib/platformPath.ts'") && proof.includes('relativeSlashed(estate, f)') && !proof.includes('slice(estate.length + 1)'),
  )
  check('…and the looped file too, never endsWith at a fixed separator', proof.includes("relativeSlashed(estate, walk.files[0]!) === 'inner/x.md'") && !proof.includes("endsWith('inner/x.md')"))
}

section("§2 the leftover census names each store in git's spelling on every platform")
{
  const REPO = realpathSync(mkdtempSync(join(SCRATCH, 'repo-')))
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' })
  git('init', '-q')
  mkdirSync(join(REPO, '.mercury', 'router'), { recursive: true })
  mkdirSync(join(REPO, '.mercury', 'workflows', 'runs'), { recursive: true })
  writeFileSync(join(REPO, '.mercury', 'router', 'routes.json'), '{}\n')
  writeFileSync(join(REPO, '.mercury', 'workflows', 'runs', 'run.json'), '{}\n')
  git('add', '.')
  git('-c', 'user.email=p@p', '-c', 'user.name=proof', 'commit', '-q', '-m', 'seed with two local stores')
  const { PROJECT_HOME_STORES, projectHomeLeftovers } = await import('../../src/utils/projectHomeStores.ts')
  const rows = projectHomeLeftovers(REPO).sort()
  check('the census names .mercury/router and .mercury/workflows/runs', JSON.stringify(rows) === JSON.stringify(['.mercury/router', '.mercury/workflows/runs']), JSON.stringify(rows))
  const bySegments = new Set(PROJECT_HOME_STORES.map(s => ['.mercury', ...s].join('/')))
  check('every row is the /-joined spelling of its store and carries no win32 separator', rows.every(r => bySegments.has(r) && !r.includes('\\')), JSON.stringify(rows))
  const listed = git('ls-files', '-z', '--', ...rows).split('\0').filter(f => f !== '')
  check("git answers every row as a pathspec and lists its files under `<row>/` — /health's compare holds", rows.every(dir => listed.some(f => f.startsWith(`${dir}/`))), JSON.stringify(listed))
  const store = source('src', 'utils', 'projectHomeStores.ts')
  check(
    'the census spells its rows with posix.join, never the host join',
    /out\.push\(posix\.join\(MERCURY_PROJECT_DIR, \.\.\.segments\)\)/.test(store) && !/out\.push\(join\(MERCURY_PROJECT_DIR/.test(store),
    `the host join spells ${win32.join('.mercury', 'workflows', 'runs')} on win32 — git lists .mercury/workflows/runs/…, /health's prefix compare never matches, and the row answers "not tracked by git"`,
  )
  rmSync(REPO, { recursive: true, force: true })
}

section("§3 the isolation read compares the product's resolved home with the private root under the platform's path semantics")
{
  const root = 'C:\\Users\\r\\AppData\\Local\\Temp\\mercury-parity-1-abcdef'
  const { canonicalHomeSpelling } = await import('../../src/utils/envUtils.ts')
  const { isPathInside } = await import('../../src/utils/pathPrefix.ts')
  const home = win32.join(root, 'home')
  const canonical = canonicalHomeSpelling(home, 'win32')
  const projects = win32.join(canonical, 'projects')
  const templated = `${root}/home`
  check("the platform's join spells the private home with the platform's separator and the product keeps that spelling", home === `${root}\\home` && canonical === home, canonical)
  record('the /-templated home against the resolved projects dir', `${JSON.stringify(projects)}.startsWith(${JSON.stringify(templated)}) → ${projects.startsWith(templated)}`)
  check('the product re-spells a /-templated home, so a startsWith on the template can never hold on win32', canonicalHomeSpelling(templated, 'win32') === home && !projects.startsWith(templated))
  if (reads) {
    const r = reads
    check('the resolved projects dir reads inside the private home (isInside, win32)', r.isInside(projects, home, 'win32'))
    check('under the process.platform seam set to win32 the default read agrees', withPlatform('win32', () => r.isInside(projects, home)))
    check('a sibling home never reads inside, nor does the root itself', !r.isInside(win32.join(root, 'home2', 'projects'), home, 'win32') && !r.isInside(root, home, 'win32'))
    check("the product's own prefix test agrees", isPathInside(projects, home, 'win32'))
    check('the presentation fold spells the root the way the golden harness presents it', r.slashed(root, 'win32') === 'C:/Users/r/AppData/Local/Temp/mercury-parity-1-abcdef')
    check(
      'the POSIX arm is untouched',
      r.isInside('/private/tmp/mercury-parity-1-abcdef/home/projects', '/private/tmp/mercury-parity-1-abcdef/home', 'darwin') && r.slashed('/private/tmp/a', 'darwin') === '/private/tmp/a',
    )
  } else {
    check('the platform-path reads have an owner (scripts/lib/platformPath.ts)', false, `absent — the isolation tests startsWith on a /-templated home: ${projects} does not start with ${templated}`)
  }
  const proof = source('scripts', 'sessionStorage', 'prove-sessionstorage-parity.ts')
  check(
    "prove-sessionstorage-parity.ts builds its private roots with the platform's join",
    proof.includes("join(PRIVATE_ROOT, 'home')") && proof.includes("join(PRIVATE_ROOT, 'cwd')") && !proof.includes('`${PRIVATE_ROOT}/home`'),
  )
  check('…reads the isolation through isInside', proof.includes('isInside(S.getProjectsDir(), PRIVATE_HOME)') && !proof.includes('startsWith(PRIVATE_HOME)'))
  check('…neutralises and screens the presentation on the slashed spelling', proof.includes('slashed(PRIVATE_HOME)') && proof.includes('slashed(PRIVATE_ROOT)'))
  check('…and leaves the root before removing it', proof.includes('process.chdir(dirname(PRIVATE_ROOT))') && !proof.includes('process.chdir(PRIVATE_ROOT)'))
  const preload = join(SCRATCH, 'win32-platform.ts')
  writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })\n")
  const childEnv: NodeJS.ProcessEnv = { ...process.env, MERCURY_CONFIG_DIR: HOME }
  delete childEnv.NODE_ENV
  const run = spawnSync(process.execPath, ['--preload', preload, join(ROOT, 'scripts', 'sessionStorage', 'prove-sessionstorage-parity.ts')], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    env: childEnv,
  })
  const lines = run.stdout.split('\n')
  const isolationLine = lines.find(l => l.includes('isolation: the product resolved the config home')) ?? '(no isolation line)'
  const verdict = lines.find(l => l.includes('SESSIONSTORAGE PARITY')) ?? '(no verdict line)'
  check(
    'the parity proof under the win32 platform seam resolves the config home to the private root and stays green',
    run.status === 0 && isolationLine.includes('[PASS]'),
    `exit ${run.status} · ${isolationLine.trim()} · ${verdict.trim()}`,
  )
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-win32-path-reads: all green' : `\nprove-win32-path-reads: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
