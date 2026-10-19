#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const DIST = process.env.SECCOMP_PACK_DIST ? resolve(process.env.SECCOMP_PACK_DIST) : join(ROOT, 'dist')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (title: string): void => console.log(`\n${'─'.repeat(76)}\n${title}\n${'─'.repeat(76)}`)

console.log('prove-seccomp-pack: no build vendors a seccomp helper, on any platform, and no manifest records one')
console.log(`  dist under proof: ${DIST}`)

if (!existsSync(join(DIST, 'mercury.mjs')) || !existsSync(join(DIST, 'manifest.json'))) {
  console.error(`  ✗ ${DIST} carries no mercury.mjs and manifest.json pair — build first (bun run build.ts), or point SECCOMP_PACK_DIST at a built dist`)
  process.exit(1)
}

const { readBuildTargetRecord } = await import('../../src/services/privateChannel/releaseTarget.ts')
const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8')) as Record<string, unknown> & { degraded?: string[] }
const target = readBuildTargetRecord(manifest)
const degraded = manifest.degraded ?? []

section('§0 the manifest names the platform the build ships for and carries no seccomp record')
check('the manifest declares its target', target !== null, JSON.stringify(manifest.target))
check('the manifest carries no seccomp record', !('seccomp' in manifest), JSON.stringify(manifest.seccomp))
check('seccomp-filter is not a degradation', !degraded.includes('seccomp-filter'), degraded.join(','))
console.log(`  target ${target?.platform}/${target?.arch} (release ${target?.release ?? 'none'}); degraded ${JSON.stringify(degraded)}`)

section('§1 the dist carries no vendor/seccomp directory and the build script knows no seccomp seam')
check('no vendor/seccomp directory in the dist', !existsSync(join(DIST, 'vendor', 'seccomp')), join(DIST, 'vendor', 'seccomp'))
const buildScript = readFileSync(join(ROOT, 'build.ts'), 'utf8')
check('build.ts names no seccomp helper, no sandbox runtime package and no MERCURY_BUILD_NO_VENDOR_SECCOMP switch', !/seccomp|sandbox-runtime|MERCURY_BUILD_NO_VENDOR_SECCOMP/.test(buildScript))

console.log(failures === 0 ? '\nprove-seccomp-pack: all green' : `\nprove-seccomp-pack: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
