#!/usr/bin/env bun
// ============================================================================
//  scripts/updater/prove-splash-ship.ts — the enter screen SHIPS on the
//  release channel.
//
//  Before this fix the splash + boot menu were chained ONLY by the operator's
//  local launcher — every release-channel user on every OS booted straight
//  into the wizard/REPL. This prover pins the packaging census, the canonical
//  splash's own safety laws, and the structural half of the Windows
//  qualification (stream-writes only ⇒ libuv tty ⇒ WriteConsoleW, immune to
//  the console codepage; the live half is the friend confirmation).
//    (1) packaging census — package.mjs copies + allowlists + smoke-asserts
//        the splash on BOTH platform branches
//    (2) the canonical splash — parses, dependency-free (node: builtins
//        only), baked menu present, TTY/off self-guard present
//    (3) WriteConsoleW safety — ONE stream owner (process.stdout), zero raw
//        fd writes, the only child spawns are the fail-soft git probes
//    (4) behavioral self-guard — piped stdio ⇒ instant silent exit 0,
//        nothing written (the belt under launchers that cannot test TTY)
//    (5) the layout law — a payload WITH splash.mjs is valid; one WITHOUT
//        stays valid (rollback to an install without it keeps working)
// ============================================================================
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { judgeExtractedLayout } from '../../src/services/privateChannel/channelCore.js'
import { validatePayloadDir } from '../../src/services/privateChannel/installLayout.js'

const ROOT = join(import.meta.dir, '..', '..')
let failures = 0
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${name}${cond || !detail ? '' : ` — ${detail}`}`)
  if (!cond) failures++
}
const section = (s: string): void => console.log(`\n── ${s} ──`)

const SPLASH = join(ROOT, 'assets', 'splash', 'mercury-splash.mjs')
const splashSrc = readFileSync(SPLASH, 'utf8')
const packageSrc = readFileSync(join(ROOT, 'scripts', 'release', 'package.mjs'), 'utf8')

//
section('(1) packaging census — the splash is a first-class archive member')
check('package.mjs copies the canonical splash beside mercury.mjs', packageSrc.includes("join(ROOT, 'assets', 'splash', 'mercury-splash.mjs')") && packageSrc.includes("join(pkgDir, 'splash.mjs')"))
check('package.mjs refuses a missing splash', packageSrc.includes('the enter screen must ship'))
check('package.mjs syntax-checks the splash PAIR before packaging (ruling 1: driver + core)', packageSrc.includes("for (const f of [splashSrc, splashCoreSrc])") && packageSrc.includes("['--check', f]"))
check('package.mjs copies the compose core beside the driver', packageSrc.includes("join(pkgDir, 'splash-core.mjs')") && packageSrc.includes('the splash ships as a pair'))
{
  // The allowlist moved to the ONE member-role authority (payloadContract.mjs,
  // UPDATE-RELIABILITY U2) — assert the derived list itself, not source text.
  const { topAllowlist, readCompatFloor } = await import('../release/payloadContract.mjs')
  const floor = readCompatFloor()
  check('splash.mjs sits in the windows top allowlist', topAllowlist('windows-x64', floor).includes('splash.mjs'))
  check('splash.mjs sits in the posix top allowlist', topAllowlist('linux-x64', floor).includes('splash.mjs'))
  check('splash-core.mjs sits in BOTH top allowlists (the ruling-1 pair)', topAllowlist('windows-x64', floor).includes('splash-core.mjs') && topAllowlist('linux-x64', floor).includes('splash-core.mjs'))
}
check('the friend-path smoke asserts the splash is in the archive', packageSrc.includes("splash.mjs (the enter screen) missing from the archive"))
check('the friend-path smoke asserts the compose core is in the archive', packageSrc.includes('splash-core.mjs (the enter-screen compose core) missing from the archive'))

//
section('(2) the canonical splash — parses, dependency-free, menu baked, self-guarded')
{
  let parses = true
  try {
    execFileSync('node', ['--check', SPLASH], { stdio: 'pipe' })
  } catch {
    parses = false
  }
  check('node --check passes', parses)
  // the driver is a dependency-free PAIR member — node: builtins
  // plus exactly its sibling compose core; the CORE imports nothing at all
  // (the purity law), so the shipped pair stays self-contained.
  const coreSrc = readFileSync(join(ROOT, 'assets', 'splash', 'splash-core.mjs'), 'utf8')
  const imports = splashSrc.split('\n').filter(l => /^import /.test(l))
  check('every driver import is a node: builtin or the sibling core (zero-dependency pair)', imports.length > 0 && imports.every(l => l.includes("from 'node:") || l.includes("from './splash-core.mjs'")), imports.filter(l => !l.includes("from 'node:") && !l.includes('./splash-core.mjs')).join(' | '))
  check('the compose core imports NOTHING (pure, side-effect-free)', !/^import /m.test(coreSrc) && !coreSrc.includes('require('))
  check('the boot menu is baked into the core (MERCURY-MENU markers)', coreSrc.includes('MERCURY-MENU-START') && coreSrc.includes('MERCURY-MENU-END'))
  // 3.6.1: the guard is canonical-first (MERCURY_SPLASH ?? MERCURY_SPLASH) —
  // the needle moved WITH that ruling; the silent-exit-0 law is unchanged.
  // The guard grew its 'static' arm with that mode — the silent-exit-0 law
  // is unchanged; the pin rides the living spelling.
  check('the TTY/off/static self-guard exists (exit 0, silent)', splashSrc.includes("process.env.MERCURY_SPLASH === 'off' || process.env.MERCURY_SPLASH === 'static' || !out.isTTY) process.exit(0)"))
  check('boot-env handover targets <config-home>/boot-env.json', splashSrc.includes("join(CONFIG_HOME, 'boot-env.json')"))
  check('the launcher handover targets <config-home>/splash-action.json', splashSrc.includes("join(CONFIG_HOME, 'splash-action.json')"))
}

//
section('(3) WriteConsoleW safety — the structural half of the win32 qualification')
{
  check('ONE stream owner: const out = process.stdout', splashSrc.includes('const out = process.stdout'))
  check('zero raw fd writes (no writeSync — stream path ⇒ WriteConsoleW on a win32 TTY)', !/[^.\w]writeSync\(/.test(splashSrc))
  const spawns = splashSrc.match(/spawnSync\(/g) ?? []
  const gitSpawns = splashSrc.match(/spawnSync\('git'/g) ?? []
  check('the only child spawns are the fail-soft git probes', spawns.length === gitSpawns.length && spawns.length > 0, `${spawns.length} spawnSync vs ${gitSpawns.length} git`)
  check('no posix-only shellouts (stty/tput)', !splashSrc.includes("'stty'") && !splashSrc.includes("'tput'"))
}

//
section('(4) behavioral self-guard — piped stdio ⇒ silent exit 0, writes nothing')
{
  const scratch = mkdtempSync(join(tmpdir(), 'splash ship '))
  const home = join(scratch, 'proof-home')
  mkdirSync(home, { recursive: true })
  const env: NodeJS.ProcessEnv = { ...process.env, MERCURY_HOME: home }
  for (const k of ['MERCURY_SPLASH', 'MERCURY_SPLASH_ONESHOT', 'MERCURY_SPLASH_VIEW', 'MERCURY_NO_BANNER']) delete env[k]
  const t0 = Date.now()
  const r = spawnSync('node', [SPLASH], { encoding: 'utf8', env, timeout: 30_000, input: '' })
  const ms = Date.now() - t0
  check('piped: exit 0', r.status === 0, `status=${r.status} err=${(r.stderr ?? '').slice(0, 120)}`)
  check('piped: silent (no frame bytes on a pipe)', (r.stdout ?? '') === '' && (r.stderr ?? '') === '', JSON.stringify((r.stdout ?? '').slice(0, 60)))
  check('piped: fast (self-guard, not a hung UI)', ms < 15_000, `${ms}ms`)
  check('piped: wrote nothing into the home', readdirSync(home).length === 0, readdirSync(home).join(','))
  rmSync(scratch, { recursive: true, force: true })
}

//
section('(5) the layout law — splash optional, never required')
{
  check('extracted layout accepts a payload carrying splash.mjs', judgeExtractedLayout(['mercury'], ['mercury.mjs', 'manifest.json', 'vendor', 'mercury', 'splash.mjs']).state === 'ok')
  const scratch = mkdtempSync(join(tmpdir(), 'splash layout '))
  const withSplash = join(scratch, 'with')
  mkdirSync(join(withSplash, 'vendor', 'ripgrep'), { recursive: true })
  writeFileSync(join(withSplash, 'mercury.mjs'), '// stub\n')
  writeFileSync(join(withSplash, 'manifest.json'), '{"version":"9.9.9-beta.1"}\n')
  writeFileSync(join(withSplash, 'mercury'), '#!/bin/sh\n')
  writeFileSync(join(withSplash, 'splash.mjs'), '// stub splash\n')
  check('validatePayloadDir: ok WITH the splash', validatePayloadDir(withSplash).state === 'ok')
  rmSync(join(withSplash, 'splash.mjs'))
  check('validatePayloadDir: still ok WITHOUT it (rollback to an install without it keeps working)', validatePayloadDir(withSplash).state === 'ok')
  rmSync(scratch, { recursive: true, force: true })
}

console.log('\n============================================================')
if (failures === 0) {
  console.log(' ✅ SPLASH-SHIP PROOFS PASS')
  process.exit(0)
}
console.log(` ❌ ${failures} CHECK(S) FAILED`)
process.exit(1)
