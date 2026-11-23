import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
const readsFix = ' — fix the function in scripts/lib/platformPath.ts that the label names (relativeSlashed, isInside or slashed) and keep the walk reading names through it'
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

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
      answer.map(f => r.relativeSlashed(estate, f, 'win32')).join(', ') + readsFix,
    )
    check('the looped file reads inner/x.md', r.relativeSlashed(loop, looped, 'win32') === 'inner/x.md', r.relativeSlashed(loop, looped, 'win32') + readsFix)
    check(
      'under the process.platform seam set to win32 the default read agrees',
      withPlatform('win32', () => JSON.stringify(answer.map(f => r.relativeSlashed(estate, f))) === JSON.stringify(expected) && r.relativeSlashed(loop, looped) === 'inner/x.md'),
      'relativeSlashed and isInside in scripts/lib/platformPath.ts must default to process.platform when no platform is passed',
    )
    check(
      'the POSIX arm is untouched',
      r.relativeSlashed('/private/tmp/estate-caps-x/small', '/private/tmp/estate-caps-x/small/linked/d.md', 'darwin') === 'linked/d.md' &&
        withPlatform('linux', () => r.relativeSlashed('/tmp/estate-caps-x/loop', '/tmp/estate-caps-x/loop/inner/x.md') === 'inner/x.md'),
      'the posix arm of relativeSlashed in scripts/lib/platformPath.ts changed behaviour',
    )
  } else {
    check(
      'the platform-path reads have an owner (scripts/lib/platformPath.ts)',
      false,
      `absent — the names are read by a slice at the host separator: on win32 the walk's answer reads as ${hostSlice.join(', ')}, and the looped file as ${looped}`,
    )
  }
}

section("§2 the leftover census names each store in git's spelling on every platform")
{
  const REPO = realpathSync(mkdtempSync(join(SCRATCH, 'repo-')))
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' })
  git('init', '-q')
  mkdirSync(join(REPO, '.mercury', 'reviews'), { recursive: true })
  mkdirSync(join(REPO, '.mercury', 'workflows', 'runs'), { recursive: true })
  writeFileSync(join(REPO, '.mercury', 'reviews', 'latest.json'), '{}\n')
  writeFileSync(join(REPO, '.mercury', 'workflows', 'runs', 'run.json'), '{}\n')
  git('add', '.')
  git('-c', 'user.email=p@p', '-c', 'user.name=proof', 'commit', '-q', '-m', 'seed with two local stores')
  const { PROJECT_HOME_STORES, projectHomeLeftovers } = await import('../../src/platform/storage/projectHomeStores.ts')
  const rows = projectHomeLeftovers(REPO).sort()
  check('the census names .mercury/reviews and .mercury/workflows/runs', JSON.stringify(rows) === JSON.stringify(['.mercury/reviews', '.mercury/workflows/runs']), JSON.stringify(rows) + ' — fix projectHomeLeftovers or PROJECT_HOME_STORES in src/platform/storage/projectHomeStores.ts')
  const bySegments = new Set(PROJECT_HOME_STORES.map(s => ['.mercury', ...s].join('/')))
  check('every row is the /-joined spelling of its store and carries no win32 separator', rows.every(r => bySegments.has(r) && !r.includes('\\')), JSON.stringify(rows) + ' — projectHomeLeftovers in src/platform/storage/projectHomeStores.ts must return /-joined store paths')
  const listed = git('ls-files', '-z', '--', ...rows).split('\0').filter(f => f !== '')
  check("git answers every row as a pathspec and lists its files under `<row>/` — /health's compare holds", rows.every(dir => listed.some(f => f.startsWith(`${dir}/`))), JSON.stringify(listed) + ' — projectHomeLeftovers in src/platform/storage/projectHomeStores.ts must return rows that git accepts as pathspecs')
  rmSync(REPO, { recursive: true, force: true })
}

section("§3 the isolation read compares the product's resolved home with the private root under the platform's path semantics")
{
  const root = 'C:\\Users\\r\\AppData\\Local\\Temp\\mercury-parity-1-abcdef'
  const { canonicalHomeSpelling } = await import('../../src/platform/environment/envUtils.ts')
  const { isPathInside } = await import('../../src/tools/read/pathPrefix.ts')
  const home = win32.join(root, 'home')
  const canonical = canonicalHomeSpelling(home, 'win32')
  const projects = win32.join(canonical, 'projects')
  const templated = `${root}/home`
  check("the platform's join spells the private home with the platform's separator and the product keeps that spelling", home === `${root}\\home` && canonical === home, canonical + ' — fix canonicalHomeSpelling in src/platform/environment/envUtils.ts')
  record('the /-templated home against the resolved projects dir', `${JSON.stringify(projects)}.startsWith(${JSON.stringify(templated)}) → ${projects.startsWith(templated)}`)
  check('the product re-spells a /-templated home, so a startsWith on the template can never hold on win32', canonicalHomeSpelling(templated, 'win32') === home && !projects.startsWith(templated), 'canonicalHomeSpelling in src/platform/environment/envUtils.ts must re-spell a /-templated home with the platform separator')
  if (reads) {
    const r = reads
    check('the resolved projects dir reads inside the private home (isInside, win32)', r.isInside(projects, home, 'win32'), 'fix isInside in scripts/lib/platformPath.ts')
    check('under the process.platform seam set to win32 the default read agrees', withPlatform('win32', () => r.isInside(projects, home)), 'isInside in scripts/lib/platformPath.ts must default to process.platform')
    check('a sibling home never reads inside, nor does the root itself', !r.isInside(win32.join(root, 'home2', 'projects'), home, 'win32') && !r.isInside(root, home, 'win32'), 'fix isInside in scripts/lib/platformPath.ts so a sibling home and the root never read inside')
    check("the product's own prefix test agrees", isPathInside(projects, home, 'win32'), 'fix isPathInside in src/tools/read/pathPrefix.ts to agree with isInside under win32')
    check('the presentation fold spells the root the way the golden harness presents it', r.slashed(root, 'win32') === 'C:/Users/r/AppData/Local/Temp/mercury-parity-1-abcdef', 'fix slashed in scripts/lib/platformPath.ts')
    check(
      'the POSIX arm is untouched',
      r.isInside('/private/tmp/mercury-parity-1-abcdef/home/projects', '/private/tmp/mercury-parity-1-abcdef/home', 'darwin') && r.slashed('/private/tmp/a', 'darwin') === '/private/tmp/a',
      'the posix arm of isInside or slashed in scripts/lib/platformPath.ts changed behaviour',
    )
  } else {
    check('the platform-path reads have an owner (scripts/lib/platformPath.ts)', false, `absent — the isolation tests startsWith on a /-templated home: ${projects} does not start with ${templated}`)
  }
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
    `exit ${run.status} · ${isolationLine.trim()} · ${verdict.trim()} — run scripts/sessionStorage/prove-sessionstorage-parity.ts with a preload that sets process.platform to win32 and read its isolation line; the config home is resolved in src/platform/environment/envUtils.ts`,
  )
}

rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-win32-path-reads: all green' : `\nprove-win32-path-reads: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
