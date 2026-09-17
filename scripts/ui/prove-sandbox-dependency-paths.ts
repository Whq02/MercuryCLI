import '../lib/hermetic.ts'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')
const FIXTURES = join(import.meta.dir, 'fixtures', 'sandbox-paths')
const DRIVER = join(FIXTURES, 'driver.ts')
const PLATFORM_PRELOAD = join(FIXTURES, 'platform.cjs')
const CENSUS_PRELOAD = join(import.meta.dir, 'fixtures', 'spawn-census', 'preload.cjs')
const RUNTIME = join(ROOT, 'node_modules', '@anthropic-ai', 'sandbox-runtime', 'dist')
const KEEP = process.argv.includes('--keep')

const vendoredNode = join(ROOT, 'dist', 'vendor', 'node', 'bin', 'node')
const node = existsSync(vendoredNode) ? vendoredNode : Bun.which('node')
if (!node) {
  console.log('  [SKIP] no node binary on this machine (dist/vendor/node or PATH) — the check runs under node')
  process.exit(0)
}

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)

console.log('prove-sandbox-dependency-paths: the sandbox dependency check on Linux hands the runtime the paths the product resolves itself and creates no process')
console.log(`  node under proof: ${node}`)

section('§0 the dependency still looks tools up by process under node (the reason the product answers the Linux check itself)')
const manager = readFileSync(join(RUNTIME, 'sandbox', 'sandbox-manager.js'), 'utf8')
const linuxUtils = readFileSync(join(RUNTIME, 'sandbox', 'linux-sandbox-utils.js'), 'utf8')
const which = readFileSync(join(RUNTIME, 'utils', 'which.js'), 'utf8')
const seccompLocator = readFileSync(join(RUNTIME, 'sandbox', 'generate-seccomp-filter.js'), 'utf8')
check("the runtime's own check resolves the ripgrep command through its which on every Linux call", manager.includes('whichSync(rgToCheck.command)'))
check("the runtime's which is a process under node", which.includes("spawnSync('which'"))
check('the runtime looks bwrap and socat up by process only when no path is handed', linuxUtils.includes("whichSync('bwrap')") && linuxUtils.includes("whichSync('socat')") && linuxUtils.includes('if (bwrapPath) {') && linuxUtils.includes('if (socatPath) {'))
check('the runtime runs npm for the apply-seccomp binary when no existing path is handed', seccompLocator.includes("'npm root -g'") && seccompLocator.includes('if (seccompBinaryPath) {'))
const WORDS = {
  rg: (command: string): string => `ripgrep (${command}) not found`,
  bwrap: 'bubblewrap (bwrap) not installed',
  socat: 'socat not installed',
  seccomp: 'seccomp not available - unix socket access not restricted',
}
check("the product's words are the runtime's own", manager.includes('`ripgrep (${rgToCheck.command}) not found`') && linuxUtils.includes(`'${WORDS.bwrap}'`) && linuxUtils.includes(`'${WORDS.socat}'`) && linuxUtils.includes(`'${WORDS.seccomp}'`))

section('§1 a node bundle of the adapter, resolved the way the product bundle is')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-paths-')))
const BUNDLE_DIR = join(SCRATCH, 'bundle')
mkdirSync(BUNDLE_DIR)
const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']
const probe = (base: string): string | null => {
  const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, '')
  for (const candidate of [base, ...exts.map(e => stripped + e), ...exts.map(e => stripped + '/index' + e)]) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      continue
    }
  }
  return null
}
const built = await Bun.build({
  entrypoints: [DRIVER],
  outdir: BUNDLE_DIR,
  naming: 'driver.mjs',
  target: 'node',
  format: 'esm',
  sourcemap: 'none',
  define: {
    MACRO: JSON.stringify({ VERSION: '0.0.0-proof', PACKAGE_URL: 'https://github.com/example/example', NATIVE_PACKAGE_URL: 'https://github.com/example/example/releases', FEEDBACK_CHANNEL: '/feedback', BUILD_TIME: '2000-01-01T00:00:00.000Z', VERSION_CHANGELOG: '', ISSUES_EXPLAINER: 'report the issue with /feedback' }),
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  plugins: [
    {
      name: 'product-resolves',
      setup(build) {
        build.onResolve({ filter: /^src\// }, args => {
          const found = probe(resolve(SRC, args.path.slice('src/'.length)))
          return found ? { path: found } : undefined
        })
        build.onResolve({ filter: /^color-diff-napi$/ }, () => ({ path: resolve(SRC, 'native-ts/color-diff/index.ts') }))
        build.onResolve({ filter: /\.node$/ }, args => ({ path: args.path, external: true }))
        build.onResolve({ filter: /^jsonc-parser$/ }, () => ({ path: resolve(ROOT, 'node_modules', 'jsonc-parser', 'lib', 'esm', 'main.js') }))
      },
    },
  ],
  loader: { '.md': 'text', '.txt': 'text', '.sh': 'text', '.py': 'text', '.html': 'text', '.xml': 'text', '.dot': 'text' },
})
if (!built.success) for (const log of built.logs) console.log(`    ${String(log)}`)
const BUNDLE = join(BUNDLE_DIR, 'driver.mjs')
check('the adapter and its graph bundle for node', built.success && existsSync(BUNDLE))
if (!built.success || !existsSync(BUNDLE)) {
  console.log(`\nprove-sandbox-dependency-paths: ${failures} FAILURE(S)`)
  process.exit(1)
}

const ARCH_DIR = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : null
const SHIM = '#!/bin/sh\nexit 0\n'
const WHICH_SHIM = '#!/bin/sh\nIFS=:\nfor d in $PATH; do\n  if [ -x "$d/$1" ]; then\n    echo "$d/$1"\n    exit 0\n  fi\ndone\nexit 1\n'
interface Spawn { kind: string; sync: boolean; cmd: string; args: string[] }
interface Answer {
  platform: string
  check: { errors: string[]; warnings: string[] }
  bwrapPath?: string
  socatPath?: string
  ripgrep?: { command: string; args?: string[]; argv0?: string }
  seccomp?: { applyPath?: string; argv0?: string }
}
interface World { dir: string; bin: string; dist: string; rg: string; applySeccomp: string }
interface Run { world: World; answer: Answer | null; spawns: Spawn[]; status: number | null; stderr: string }

function makeWorld(name: string, tools: { bwrap: boolean; socat: boolean; rg: boolean; applySeccomp: boolean }): World {
  const dir = join(SCRATCH, name)
  const bin = join(dir, 'bin')
  const dist = join(dir, 'dist')
  for (const d of [bin, dist, join(dir, 'home'), join(dir, 'cwd'), join(dir, 'tmp'), join(dir, 'census')]) mkdirSync(d, { recursive: true })
  copyFileSync(BUNDLE, join(dist, 'driver.mjs'))
  const shim = (path: string, body: string): void => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, body)
    chmodSync(path, 0o755)
  }
  shim(join(bin, 'which'), WHICH_SHIM)
  if (tools.bwrap) shim(join(bin, 'bwrap'), SHIM)
  if (tools.socat) shim(join(bin, 'socat'), SHIM)
  const rg = join(dist, 'vendor', 'ripgrep', `${process.arch}-linux`, 'rg')
  if (tools.rg) shim(rg, SHIM)
  const applySeccomp = join(dist, 'vendor', 'seccomp', ARCH_DIR ?? process.arch, 'apply-seccomp')
  if (tools.applySeccomp) shim(applySeccomp, SHIM)
  return { dir, bin, dist, rg, applySeccomp }
}

function runWorld(world: World, platform: string | null): Run {
  const env: Record<string, string> = {
    PATH: world.bin,
    HOME: join(world.dir, 'home'),
    TMPDIR: join(world.dir, 'tmp'),
    MERCURY_CONFIG_DIR: join(world.dir, 'home'),
    MERCURY_CREDENTIAL_STORE: 'file',
    MERCURY_DESKTOP_DRIVER: 'none',
    SPAWN_CENSUS_DIR: join(world.dir, 'census'),
    NODE_OPTIONS: `--require=${CENSUS_PRELOAD} --require=${PLATFORM_PRELOAD}`,
  }
  if (platform) env.SANDBOX_PATHS_PLATFORM = platform
  const result = spawnSync(node, [join(world.dist, 'driver.mjs')], { cwd: join(world.dir, 'cwd'), env, encoding: 'utf8', timeout: 60_000 })
  let answer: Answer | null = null
  try {
    const line = (result.stdout ?? '').trim().split('\n').filter(Boolean).pop() ?? ''
    answer = JSON.parse(line) as Answer
  } catch {
    answer = null
  }
  const spawns: Spawn[] = []
  const log = join(world.dir, 'census', `census-${result.pid}.jsonl`)
  if (existsSync(log)) {
    for (const line of readFileSync(log, 'utf8').split('\n')) {
      if (!line.trim()) continue
      spawns.push(...(JSON.parse(line) as { spawns: Spawn[] }).spawns)
    }
  }
  return { world, answer, spawns, status: result.status, stderr: (result.stderr ?? '').slice(-600) }
}

const describe = (s: Spawn): string => `${s.kind} ${s.cmd} ${s.args.join(' ')}`
const isLookup = (s: Spawn): boolean => basename(s.cmd) === 'which'
const isNpm = (s: Spawn): boolean => basename(s.cmd) === 'npm' || /^npm(\s|$)/.test(s.cmd)
const lookups = (run: Run): Spawn[] => run.spawns.filter(s => isLookup(s) || isNpm(s))

section('§2 every tool present: the paths ride the config, the check is clean, nothing is spawned')
const found = runWorld(makeWorld('found', { bwrap: true, socat: true, rg: true, applySeccomp: false }), 'linux')
check('the driver ran on the Linux arm', found.status === 0 && found.answer?.platform === 'linux', `status ${found.status} ${found.stderr}`)
check('no dependency error', (found.answer?.check.errors ?? ['no answer']).length === 0, (found.answer?.check.errors ?? []).join(' · '))
check("the config carries bubblewrap's path from the product's own lookup", found.answer?.bwrapPath === join(found.world.bin, 'bwrap'), String(found.answer?.bwrapPath))
check("the config carries socat's path from the product's own lookup", found.answer?.socatPath === join(found.world.bin, 'socat'), String(found.answer?.socatPath))
check('the config carries the vendored ripgrep as the command, with the product flags', found.answer?.ripgrep?.command === found.world.rg && (found.answer?.ripgrep?.args ?? []).includes('--no-config'), JSON.stringify(found.answer?.ripgrep))
check('no apply-seccomp beside the bundle: the runtime warning stands and no seccomp path is handed', (found.answer?.check.warnings ?? []).join('|') === WORDS.seccomp && found.answer?.seccomp === undefined, JSON.stringify(found.answer?.check.warnings))
check('no which and no npm process', lookups(found).length === 0, lookups(found).map(describe).join(' · '))
check('no child process of any kind during the check and the hand-over', found.spawns.length === 0, found.spawns.map(describe).join(' · '))

section('§3 apply-seccomp beside the bundle: its path is handed, the warning goes, still nothing is spawned')
const sealed = runWorld(makeWorld('sealed', { bwrap: true, socat: true, rg: true, applySeccomp: true }), 'linux')
check('the driver ran on the Linux arm', sealed.status === 0 && sealed.answer?.platform === 'linux', `status ${sealed.status} ${sealed.stderr}`)
check('no dependency error and no warning', (sealed.answer?.check.errors ?? ['no answer']).length === 0 && (sealed.answer?.check.warnings ?? ['no answer']).length === 0, JSON.stringify(sealed.answer?.check))
check("the config carries apply-seccomp's path beside the bundle", sealed.answer?.seccomp?.applyPath === sealed.world.applySeccomp, JSON.stringify(sealed.answer?.seccomp))
check('no child process of any kind', sealed.spawns.length === 0, sealed.spawns.map(describe).join(' · '))

section("§4 nothing installed: the product answers the misses itself in the runtime's words, without a lookup process")
const bare = runWorld(makeWorld('bare', { bwrap: false, socat: false, rg: false, applySeccomp: false }), 'linux')
check('the driver ran on the Linux arm', bare.status === 0 && bare.answer?.platform === 'linux', `status ${bare.status} ${bare.stderr}`)
check("the three errors in the runtime's words and order", JSON.stringify(bare.answer?.check.errors) === JSON.stringify([WORDS.rg(bare.world.rg), WORDS.bwrap, WORDS.socat]), JSON.stringify(bare.answer?.check.errors))
check('the seccomp warning', (bare.answer?.check.warnings ?? []).join('|') === WORDS.seccomp, JSON.stringify(bare.answer?.check.warnings))
check('no bubblewrap or socat path is handed when none was found', bare.answer?.bwrapPath === undefined && bare.answer?.socatPath === undefined, `${bare.answer?.bwrapPath} ${bare.answer?.socatPath}`)
check('the ripgrep command still names the binary the product would run', bare.answer?.ripgrep?.command === bare.world.rg, JSON.stringify(bare.answer?.ripgrep))
check('no which and no npm process', lookups(bare).length === 0, lookups(bare).map(describe).join(' · '))
check('no child process of any kind', bare.spawns.length === 0, bare.spawns.map(describe).join(' · '))

section('§5 macOS: the check is unchanged — the runtime answers, nothing is handed, no lookup process')
if (process.platform === 'darwin') {
  const mac = runWorld(makeWorld('mac', { bwrap: true, socat: true, rg: true, applySeccomp: true }), null)
  check('the driver ran on the host arm', mac.status === 0 && mac.answer?.platform === 'darwin', `status ${mac.status} ${mac.stderr}`)
  check('no error and no warning', (mac.answer?.check.errors ?? ['no answer']).length === 0 && (mac.answer?.check.warnings ?? ['no answer']).length === 0, JSON.stringify(mac.answer?.check))
  check('no Linux path in the config', mac.answer?.bwrapPath === undefined && mac.answer?.socatPath === undefined && mac.answer?.ripgrep === undefined && mac.answer?.seccomp === undefined, JSON.stringify(mac.answer))
  check('no which and no npm process', lookups(mac).length === 0, lookups(mac).map(describe).join(' · '))
} else {
  console.log(`  [SKIP] the host is ${process.platform}; the macOS arm is read on a Mac`)
}

if (KEEP) console.log(`\n  kept: ${SCRATCH}`)
else rmSync(SCRATCH, { recursive: true, force: true })
console.log(failures === 0 ? '\nprove-sandbox-dependency-paths: all green' : `\nprove-sandbox-dependency-paths: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
