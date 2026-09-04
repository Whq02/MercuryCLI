#!/usr/bin/env bun
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.chdir(join(import.meta.dir, '..', '..'))
const ROOT = process.cwd()
const { RELEASE_TARGETS, archiveNameFor, buildPlatformOf, isReleaseTarget, platformKey, readBuildTargetRecord } = await import('../../src/services/privateChannel/releaseTarget.ts')
const { nodePackPlatform, readRuntimeRecord } = await import('../../src/services/privateChannel/vendoredRuntime.ts')

const argv = process.argv.slice(2)
const REQUIRE = argv.includes('--require')
const targetAt = argv.indexOf('--target')
const TARGET_ARG = targetAt === -1 ? 'macos-x64' : (argv[targetAt + 1] ?? '')
if (!isReleaseTarget(TARGET_ARG)) {
  console.log(`  [FAIL] --target wants one of ${RELEASE_TARGETS.join(', ')} (got ${TARGET_ARG || 'nothing'})`)
  process.exit(1)
}
const TARGET = TARGET_ARG
const SHIP = buildPlatformOf(TARGET)
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }
const VERSION = PKG.version
const ARCHIVE = join(ROOT, 'release-out', archiveNameFor(VERSION, TARGET))

let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}
const skip = (why: string): never => {
  if (REQUIRE) {
    console.log(`  [FAIL] ${why} (--require: a skip is red here)`)
    process.exit(1)
  }
  console.log(`  [SKIP] ${why}`)
  process.exit(0)
}

if (SHIP.platform !== 'darwin' || process.platform !== 'darwin') skip(`${TARGET} under Rosetta is a macOS-host proof (host ${process.platform})`)
const rosetta = spawnSync('arch', ['-x86_64', '/usr/bin/true'], { encoding: 'utf8' })
if (rosetta.status !== 0) skip('Rosetta 2 is absent on this Mac (arch -x86_64 /usr/bin/true failed) — softwareupdate --install-rosetta installs it')
if (!existsSync(ARCHIVE)) skip(`no packaged ${TARGET} archive at release-out/${archiveNameFor(VERSION, TARGET)} — package one first: bun run build.ts --target ${TARGET} && node scripts/release/package.mjs --target ${TARGET}`)

const scratch = mkdtempSync(join(tmpdir(), 'mercury rosetta '))
const home = join(scratch, 'home')
mkdirSync(home, { recursive: true })
const env = {
  ...process.env,
  HOME: home,
  MERCURY_CONFIG_DIR: join(home, '.mercury'),
  MERCURY_VERSIONS_DIR: join(home, 'versions'),
  MERCURY_CREDENTIAL_STORE: 'file',
  CI: '1',
  TERM: 'dumb',
}
const x64 = (cmd: string, args: string[], timeout = 180_000) => spawnSync('arch', ['-x86_64', cmd, ...args], { encoding: 'utf8', env, cwd: home, timeout, maxBuffer: 64 * 1024 * 1024 })

try {
  execFileSync('tar', ['-xzf', ARCHIVE, '-C', scratch], { stdio: 'pipe' })
  const payload = join(scratch, 'mercury')
  const launcher = join(payload, 'mercury')
  check('archive unpacks to mercury/ with the launcher', existsSync(launcher))
  const manifest = JSON.parse(readFileSync(join(payload, 'manifest.json'), 'utf8')) as Record<string, unknown>

  const target = readBuildTargetRecord(manifest)
  check(`manifest declares target ${TARGET} (${SHIP.platform}/${SHIP.arch})`, target !== null && target.release === TARGET && target.platform === SHIP.platform && target.arch === SHIP.arch, JSON.stringify(manifest.target))
  check('manifest names the host it was cross-built on', target !== null && /^[a-z0-9]+-[a-z0-9]+$/.test(target.host), target?.host)
  const runtime = readRuntimeRecord(manifest)
  const packPlatform = nodePackPlatform(SHIP.platform, SHIP.arch)
  check(`the vendored runtime record is ${packPlatform}`, runtime !== null && runtime.vendored && runtime.platform === packPlatform, JSON.stringify(manifest.runtime))
  const search = manifest.search as { vendored?: boolean; path?: string } | undefined
  check(`the search record names vendor/ripgrep/${SHIP.arch}-${SHIP.platform}/rg`, search?.vendored === true && search.path === `vendor/ripgrep/${SHIP.arch}-${SHIP.platform}/rg`, JSON.stringify(search))
  const image = manifest.imageProcessing as { vendored?: boolean; platform?: string } | undefined
  check(`the image processor is vendored for ${platformKey(SHIP.platform, SHIP.arch)} (or honestly absent)`, image?.vendored === false || image?.platform === platformKey(SHIP.platform, SHIP.arch), JSON.stringify(image))
  const voice = manifest.voiceInput as { vendored?: boolean; platform?: string } | undefined
  check(`the voice pack is ${platformKey(SHIP.platform, SHIP.arch)} (or honestly absent)`, voice?.vendored === false || voice?.platform === platformKey(SHIP.platform, SHIP.arch), JSON.stringify(voice))

  const vendoredNode = runtime && runtime.vendored ? join(payload, ...runtime.path.split('/'), ...runtime.binary.split('/')) : null
  check('the vendored runtime binary is on disk', vendoredNode !== null && existsSync(vendoredNode))
  if (vendoredNode && existsSync(vendoredNode)) {
    const arch = x64(vendoredNode, ['-p', 'process.platform + "/" + process.arch + " node " + process.versions.node'])
    check('the vendored runtime runs under Rosetta and reports darwin/x64', arch.status === 0 && arch.stdout.trim().startsWith('darwin/x64 node '), (arch.stdout + arch.stderr).trim().slice(0, 200))
  }
  const rgDirs = existsSync(join(payload, 'vendor', 'ripgrep')) ? readdirSync(join(payload, 'vendor', 'ripgrep')) : []
  check(`the archive carries exactly one search binary directory, the target's (${SHIP.arch}-${SHIP.platform})`, JSON.stringify(rgDirs) === JSON.stringify([`${SHIP.arch}-${SHIP.platform}`]), rgDirs.join(', '))
  if (search?.path) {
    const rg = join(payload, ...search.path.split('/'))
    const file = spawnSync('file', ['-b', rg], { encoding: 'utf8' })
    check('the vendored search binary is an x86_64 Mach-O', file.status === 0 && /x86_64/.test(file.stdout), file.stdout.trim().slice(0, 120))
    const rgRun = x64(rg, ['--version'])
    check('the vendored search binary runs under Rosetta', rgRun.status === 0 && /^ripgrep \d/.test(rgRun.stdout), (rgRun.stdout + rgRun.stderr).trim().slice(0, 120))
  }

  const trap = join(scratch, 'trap')
  mkdirSync(trap, { recursive: true })
  writeFileSync(join(trap, 'node'), '#!/bin/sh\necho "rosetta trap: the PATH node must not be used" >&2\nexit 86\n')
  chmodSync(join(trap, 'node'), 0o755)
  const noNode = { ...env, PATH: `${trap}:/usr/bin:/bin` }
  const version = spawnSync('arch', ['-x86_64', launcher, '--version'], { encoding: 'utf8', env: noNode, cwd: home, timeout: 180_000 })
  check(`arch -x86_64 mercury --version prints ${VERSION} on the vendored runtime alone`, version.status === 0 && version.stdout.includes(VERSION), (version.stdout + version.stderr).trim().slice(0, 200))

  const doctor = x64(launcher, ['doctor', '--json'], 300_000)
  let rows: Array<{ label?: string; status?: string; evidence?: string }> = []
  try {
    const parsed = JSON.parse(doctor.stdout) as unknown
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) node.forEach(collect)
      else if (node && typeof node === 'object') {
        const o = node as Record<string, unknown>
        if (typeof o.label === 'string' && typeof o.status === 'string') rows.push(o as { label: string; status: string; evidence?: string })
        Object.values(o).forEach(collect)
      }
    }
    collect(parsed)
  } catch {
    rows = []
  }
  check('arch -x86_64 mercury doctor --json parses to a certificate with rows', rows.length > 0, (doctor.stdout + doctor.stderr).trim().slice(0, 200))
  const runtimeRow = rows.find(r => r.label === 'Node & ripgrep')
  check('the runtime row is green: the vendored node in use, the vendored ripgrep present', runtimeRow?.status === 'ok' && /vendored node/.test(runtimeRow.evidence ?? '') && /ripgrep builtin/.test(runtimeRow.evidence ?? '') && /present/.test(runtimeRow.evidence ?? ''), JSON.stringify(runtimeRow))
  const buildRow = rows.find(r => r.label === 'Mercury build')
  check('the build identity row is green', buildRow?.status === 'ok', JSON.stringify(buildRow))

  if (vendoredNode && existsSync(vendoredNode)) {
    const verifier = x64(vendoredNode, [join(payload, 'verify-artifact.mjs'), '--json', '--deep'])
    let state: string | null = null
    try {
      state = (JSON.parse(verifier.stdout) as { verdict?: { state?: string } }).verdict?.state ?? null
    } catch {
      state = null
    }
    const expectedExit: Record<string, number> = { signed: 0, unsigned: 3, 'unrecognized-key': 4 }
    check('the shipped verifier answers a known state at full depth, with its exit code', state !== null && expectedExit[state] === verifier.status, `state ${state}, exit ${verifier.status}: ${(verifier.stdout + verifier.stderr).trim().slice(0, 160)}`)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log('')
if (failures === 0) {
  console.log(`PASS prove-cross-archive-rosetta (${TARGET} under arch -x86_64)`)
  process.exit(0)
}
console.log(`FAIL prove-cross-archive-rosetta (${failures})`)
process.exit(1)
