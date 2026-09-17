#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = process.env.SECCOMP_PACK_DIST ? resolve(process.env.SECCOMP_PACK_DIST) : join(ROOT, 'dist')
const PACKAGE_DIR = join(ROOT, 'node_modules', '@anthropic-ai', 'sandbox-runtime')
const DEGRADATION = 'seccomp-filter'
const ELF_MACHINE: Record<string, number> = { x64: 0x3e, arm64: 0xb7 }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)
const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex')

console.log('prove-seccomp-pack: a dist that ships for Linux carries the sandbox unix-socket filter helper beside the bundle, where the adapter and the runtime read it first')
console.log(`  dist under proof: ${DIST}`)

if (!existsSync(join(DIST, 'mercury.mjs')) || !existsSync(join(DIST, 'manifest.json'))) {
  console.error(`  ✗ ${DIST} carries no mercury.mjs and manifest.json pair — build first (bun run build.ts), or point SECCOMP_PACK_DIST at a built dist`)
  process.exit(1)
}

const { readBuildTargetRecord } = await import('../../src/services/privateChannel/releaseTarget.ts')
type SeccompRecord = { vendored?: boolean; path?: string; arch?: string; bytes?: number; sha256?: string; source?: string; license?: string; licensePath?: string; platform?: string; remedy?: string; note?: string }
const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8')) as { degraded?: string[]; seccomp?: SeccompRecord; target?: unknown }
const target = readBuildTargetRecord(manifest)
const degraded = manifest.degraded ?? []
const row = manifest.seccomp
const pkg = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')) as { version: string; license: string }

section('§0 the manifest names the platform the build ships for and carries a seccomp record')
check('the manifest declares its target', target !== null, JSON.stringify(manifest.target))
check('the manifest carries a seccomp record with a vendored verdict', row !== undefined && typeof row.vendored === 'boolean', JSON.stringify(row))
console.log(`  target ${target?.platform}/${target?.arch} (release ${target?.release ?? 'none'}); record ${JSON.stringify(row)}`)

section('§1 the build writes the helper where the adapter and the runtime read it first: <bundle dir>/vendor/seccomp/<arch>/apply-seccomp')
const adapter = readFileSync(join(ROOT, 'src', 'utils', 'sandbox', 'sandbox-adapter.ts'), 'utf8')
const locator = readFileSync(join(PACKAGE_DIR, 'dist', 'sandbox', 'generate-seccomp-filter.js'), 'utf8')
check("the adapter's first candidate is vendor/seccomp/<arch>/apply-seccomp beside the bundle", adapter.includes("join(moduleDir, 'vendor', 'seccomp', archDir, 'apply-seccomp')"))
check("the runtime's own locator reads the same path beside the bundle first", locator.includes("join('vendor', 'seccomp', arch, filename)") && locator.includes('join(baseDir, relativePath)'))

const seccompDir = join(DIST, 'vendor', 'seccomp')
if (target?.platform === 'linux') {
  section(`§2 a Linux dist carries the ${target.arch} helper, its bytes the dependency's, and the licence text beside it`)
  const arch = target.arch
  const relPath = `vendor/seccomp/${arch}/apply-seccomp`
  const shipped = join(DIST, relPath)
  const source = join(PACKAGE_DIR, 'vendor', 'seccomp', arch, 'apply-seccomp')
  check(`the dependency carries a helper for ${arch}`, existsSync(source), source)
  check(`the dist carries ${relPath}`, existsSync(shipped), shipped)
  if (existsSync(shipped) && existsSync(source)) {
    const st = statSync(shipped)
    const digest = sha256(shipped)
    const head = readFileSync(shipped).subarray(0, 20)
    check('the helper is a regular file with mode 755', st.isFile() && (st.mode & 0o777) === 0o755, (st.mode & 0o777).toString(8))
    check("the helper's size equals the dependency's", st.size === statSync(source).size, `${st.size} vs ${statSync(source).size}`)
    check("the helper's sha256 equals the dependency's", digest === sha256(source), digest)
    check('the helper is a 64-bit ELF executable', head[0] === 0x7f && head[1] === 0x45 && head[2] === 0x4c && head[3] === 0x46 && head[4] === 2 && head.readUInt16LE(16) === 2, head.toString('hex'))
    check(`the ELF machine is ${arch}'s`, head.readUInt16LE(18) === ELF_MACHINE[arch], `0x${head.readUInt16LE(18).toString(16)}`)
    const archDirs = readdirSync(seccompDir).filter(name => statSync(join(seccompDir, name)).isDirectory())
    check('one helper per dist: the shipped arch is the only arch directory', archDirs.join(',') === arch, archDirs.join(','))
    check('the licence text ships beside the helper, the package\'s own', existsSync(join(seccompDir, 'LICENSE')) && sha256(join(seccompDir, 'LICENSE')) === sha256(join(PACKAGE_DIR, 'LICENSE')), join(seccompDir, 'LICENSE'))
    check('the record says vendored and names the path', row?.vendored === true && row.path === relPath, JSON.stringify(row))
    check('the record names the arch, the size and the digest of the shipped file', row?.arch === arch && row?.bytes === st.size && row?.sha256 === digest, JSON.stringify(row))
    check('the record names the package, its installed version and its licence', typeof row?.source === 'string' && row.source === `@anthropic-ai/sandbox-runtime ${pkg.version}` && row.license === pkg.license && row.licensePath === 'vendor/seccomp/LICENSE', JSON.stringify(row))
    check(`${DEGRADATION} is not among the degradations`, !degraded.includes(DEGRADATION), degraded.join(','))
  }
} else {
  section(`§2 a ${target?.platform ?? 'unknown'} dist carries no helper, and its record says the helper serves Linux only`)
  check('no vendor/seccomp directory in the dist', !existsSync(seccompDir), seccompDir)
  check('the record says not vendored and names Linux as the platform the helper serves', row?.vendored === false && row?.platform === 'linux', JSON.stringify(row))
  check(`${DEGRADATION} is not a degradation off Linux`, !degraded.includes(DEGRADATION), degraded.join(','))
  console.log('  [SKIP] the Linux leg reads a dist built for Linux: the hosted gate\'s, or SECCOMP_PACK_DIST pointed at a cross build (bun run build.ts --target linux-x64)')
}

console.log(failures === 0 ? '\nprove-seccomp-pack: all green' : `\nprove-seccomp-pack: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
