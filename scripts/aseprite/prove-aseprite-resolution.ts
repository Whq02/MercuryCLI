#!/usr/bin/env bun
// ============================================================================
//  scripts/aseprite/prove-aseprite-resolution.ts
//  PROOF: the Aseprite context + app-location owner (services/aseprite/
//  asepriteApp.ts, MERCURY_ASEPRITE opt-in) and the catalog gate — the
//  registry evidence artifact.
//
//   §1  opt-in polarity: unset ⇒ gate OFF (and the catalog seam with it);
//       =1 arms.
//   §2  sprite awareness: bounded deterministic walk over .aseprite AND
//       .ase, hidden/VCS dirs skipped, cap honest (truncation counted).
//   §3  location rungs: pin honesty both ways · PATH · the darwin
//       app-bundle rung (fake bundles) · the Steam rung (fake library) ·
//       the win32 installer/itch rungs (fake roots, sources named) · the
//       fused unavailable verdict naming every road + the remedy.
//   §4  version probe through a shim fake aseprite (async, bounded):
//       parses the release shape "Aseprite 1.3.7-arm64" AND the
//       source-build shape "Aseprite 1.x-dev"; a foreign binary answers a
//       reason, never a throw; the 30s cache dropped via the test seam.
//   §5  catalog-gate truth table: armed+sprites ⇒ on · armed+located-only
//       ⇒ on (create-from-nothing stays reachable) · armed+neither ⇒ off ·
//       disarmed+both ⇒ off.
//   §6  the spawn owner: every run rides -b FIRST (argv-recording shim),
//       a runaway child is killed at the bound with the reason carried,
//       output caps count what they swallow.
//
//  Hermetic: scratch trees, fake bundles, sh shims — the real app is never
//  required here (the real-engine legs live in their own prover).
//  Run:  ~/.bun/bin/bun run scripts/aseprite/prove-aseprite-resolution.ts
// ============================================================================
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

console.log('============================================================')
console.log(' aseprite context + location owner (MERCURY_ASEPRITE) — proof')
console.log('============================================================')

const {
  mercuryAsepriteEnabled,
  discoverSpriteFiles,
  locateAseprite,
  probeAsepriteVersion,
  resolveAseprite,
  runAseprite,
  _resetAsepriteVersionProbeForTesting,
  ASEPRITE_INSTALL_REMEDY,
  SPRITE_FILE_CAP,
} = await import('../../src/services/aseprite/asepriteApp.js')
const { asepriteToolCatalogEnabled, _resetAsepriteContextCacheForTesting } = await import(
  '../../src/utils/aseprite/gates.js'
)
const { runWithCwdOverride } = await import('../../src/utils/cwd.js')

const savedEnv = { ...process.env }
function restore(): void {
  for (const k of Object.keys(process.env)) {
    if (!(k in savedEnv)) delete process.env[k]
  }
  Object.assign(process.env, savedEnv)
  delete process.env.MERCURY_ASEPRITE
  delete process.env.MERCURY_ASEPRITE_BIN
  _resetAsepriteContextCacheForTesting()
  _resetAsepriteVersionProbeForTesting()
}

const scratch = mkdtempSync(path.join(tmpdir(), 'ase-resolution-'))
function shim(name: string, body: string): string {
  const p = path.join(scratch, name)
  writeFileSync(p, body)
  chmodSync(p, 0o755)
  return p
}

// ── §1 opt-in polarity ──────────────────────────────────────────────────────
section('§1 · opt-in polarity')
{
  restore()
  check('unset ⇒ gate OFF', mercuryAsepriteEnabled() === false)
  check('unset ⇒ catalog seam OFF regardless of context', asepriteToolCatalogEnabled() === false)
  process.env.MERCURY_ASEPRITE = '1'
  check('=1 ⇒ gate ON', mercuryAsepriteEnabled() === true)
  process.env.MERCURY_ASEPRITE = '0'
  check('=0 ⇒ gate OFF', mercuryAsepriteEnabled() === false)
}

// ── §2 sprite awareness ─────────────────────────────────────────────────────
section('§2 · sprite awareness (bounded walk)')
{
  restore()
  const tree = path.join(scratch, 'tree')
  mkdirSync(path.join(tree, 'art', 'chars'), { recursive: true })
  mkdirSync(path.join(tree, '.hidden'), { recursive: true })
  mkdirSync(path.join(tree, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(path.join(tree, 'hero.aseprite'), '')
  writeFileSync(path.join(tree, 'art', 'tiles.ase'), '')
  writeFileSync(path.join(tree, 'art', 'chars', 'npc.aseprite'), '')
  writeFileSync(path.join(tree, '.hidden', 'ghost.aseprite'), '')
  writeFileSync(path.join(tree, 'node_modules', 'pkg', 'vendored.ase'), '')
  writeFileSync(path.join(tree, 'readme.md'), '')
  const d = discoverSpriteFiles(tree)
  check('finds .aseprite AND .ase, skips hidden/VCS dirs', d.total === 3, `total=${d.total}`)
  check(
    'deterministic relative paths',
    d.files.join('|') === 'art/chars/npc.aseprite|art/tiles.ase|hero.aseprite',
    d.files.join('|'),
  )
  const capTree = path.join(scratch, 'cap-tree')
  mkdirSync(capTree, { recursive: true })
  for (let i = 0; i < SPRITE_FILE_CAP + 7; i++) {
    writeFileSync(path.join(capTree, `s${String(i).padStart(3, '0')}.ase`), '')
  }
  const capped = discoverSpriteFiles(capTree)
  check(
    'cap honest: total counted, truncation named',
    capped.files.length === SPRITE_FILE_CAP && capped.total === SPRITE_FILE_CAP + 7 && capped.truncated === 7,
    `files=${capped.files.length} total=${capped.total} truncated=${capped.truncated}`,
  )
}

// ── §3 location rungs ───────────────────────────────────────────────────────
section('§3 · location rungs')
{
  restore()
  const pinTarget = shim('pinned-aseprite', '#!/bin/sh\nexit 0\n')
  process.env.MERCURY_ASEPRITE_BIN = pinTarget
  let census = locateAseprite()
  check('pin rung wins when the file exists', census.aseprite?.source === 'pin' && census.aseprite.path === pinTarget)

  process.env.MERCURY_ASEPRITE_BIN = path.join(scratch, 'nowhere', 'aseprite')
  census = locateAseprite()
  check(
    'broken pin refuses BY NAME, no silent fallback',
    census.aseprite === undefined && (census.pinError ?? '').includes('MERCURY_ASEPRITE_BIN') && (census.pinError ?? '').includes('no silent fallback'),
    census.pinError,
  )

  delete process.env.MERCURY_ASEPRITE_BIN
  const binDir = path.join(scratch, 'path-bin')
  mkdirSync(binDir, { recursive: true })
  const onPath = path.join(binDir, 'aseprite')
  writeFileSync(onPath, '#!/bin/sh\nexit 0\n')
  chmodSync(onPath, 0o755)
  const savedPath = process.env.PATH
  process.env.PATH = binDir
  census = locateAseprite()
  check('PATH rung', census.aseprite?.source === 'path' && census.aseprite.path === onPath)
  process.env.PATH = savedPath

  const bundle = path.join(scratch, 'Aseprite.app', 'Contents', 'MacOS')
  mkdirSync(bundle, { recursive: true })
  const bundleBin = path.join(bundle, 'aseprite')
  writeFileSync(bundleBin, '#!/bin/sh\nexit 0\n')
  census = locateAseprite({ platform: 'darwin', skipPathProbe: true, appBundles: [bundleBin] })
  check('darwin app-bundle rung', census.aseprite?.source === 'app-bundle' && census.aseprite.path === bundleBin)

  const steamDir = path.join(scratch, 'steam-lib', 'steamapps', 'common', 'Aseprite')
  mkdirSync(steamDir, { recursive: true })
  const steamBin = path.join(steamDir, 'aseprite')
  writeFileSync(steamBin, '#!/bin/sh\nexit 0\n')
  census = locateAseprite({ platform: 'linux', skipPathProbe: true, steamCandidates: [steamBin] })
  check('Steam-library rung', census.aseprite?.source === 'steam' && census.aseprite.path === steamBin)

  const pfBin = path.join(scratch, 'pf', 'Aseprite', 'Aseprite.exe')
  mkdirSync(path.dirname(pfBin), { recursive: true })
  writeFileSync(pfBin, '')
  const itchBin = path.join(scratch, 'itch', 'apps', 'aseprite', 'Aseprite.exe')
  mkdirSync(path.dirname(itchBin), { recursive: true })
  writeFileSync(itchBin, '')
  census = locateAseprite({
    platform: 'win32',
    skipPathProbe: true,
    steamCandidates: [],
    win32Candidates: [
      { candidate: pfBin, source: 'program-files' },
      { candidate: itchBin, source: 'itch' },
    ],
  })
  check('win32 installer rung (source named)', census.aseprite?.source === 'program-files' && census.aseprite.path === pfBin)
  census = locateAseprite({
    platform: 'win32',
    skipPathProbe: true,
    steamCandidates: [],
    win32Candidates: [{ candidate: itchBin, source: 'itch' }],
  })
  check('win32 itch rung (source named)', census.aseprite?.source === 'itch' && census.aseprite.path === itchBin)

  census = locateAseprite({ platform: 'linux', skipPathProbe: true, steamCandidates: [] })
  check('nothing found ⇒ empty census, never a throw', census.aseprite === undefined && census.pinError === undefined)

  // The fused verdict — teaching sentences, every road named. The
  // ambient-state seam keeps a real install on THIS box out of the proof.
  process.env.MERCURY_ASEPRITE_NO_DISCOVERY = '1'
  const r = resolveAseprite()
  check(
    'unavailable verdict names the roads probed',
    r.state === 'unavailable' &&
      r.note.includes('PATH') &&
      r.note.includes('Steam') &&
      r.note.includes('MERCURY_ASEPRITE_BIN'),
    r.state === 'unavailable' ? r.note : r.state,
  )
  check(
    'unavailable verdict carries the install remedy (never-installs sentence)',
    r.state === 'unavailable' && r.remedies.includes(ASEPRITE_INSTALL_REMEDY) && ASEPRITE_INSTALL_REMEDY.includes('never installs'),
  )
  process.env.MERCURY_ASEPRITE_BIN = pinTarget
  const ok = resolveAseprite()
  check('resolved verdict carries the location (pin wins above the seam)', ok.state === 'ok' && ok.location.source === 'pin')
  delete process.env.MERCURY_ASEPRITE_NO_DISCOVERY
}

// ── §4 version probe (shim fake, async + bounded) ───────────────────────────
section('§4 · the version probe (shim fake)')
{
  restore()
  const release = shim('release-aseprite', '#!/bin/sh\necho "Aseprite 1.3.7-arm64"\nexit 0\n')
  let v = await probeAsepriteVersion(release)
  check('parses the release shape "Aseprite 1.3.7-arm64"', v.version === '1.3.7-arm64' && v.reason === undefined, v.reason)
  _resetAsepriteVersionProbeForTesting()
  const dev = shim('dev-aseprite', '#!/bin/sh\necho "Aseprite 1.x-dev"\nexit 0\n')
  v = await probeAsepriteVersion(dev)
  check('parses the source-build shape "Aseprite 1.x-dev"', v.version === '1.x-dev' && v.reason === undefined, v.reason)
  _resetAsepriteVersionProbeForTesting()
  const foreign = shim('foreign-aseprite', '#!/bin/sh\necho "something else"\nexit 0\n')
  v = await probeAsepriteVersion(foreign)
  check('foreign output ⇒ reason, never a throw', v.version === undefined && (v.reason ?? '').includes('unparseable'), v.reason)
  // The cache: the same bin re-answers without a spawn (the shim now lies —
  // a changed answer proves the cache served).
  _resetAsepriteVersionProbeForTesting()
  const flip = shim('flip-aseprite', '#!/bin/sh\necho "Aseprite 9.9.9"\nexit 0\n')
  v = await probeAsepriteVersion(flip)
  writeFileSync(flip, '#!/bin/sh\necho "Aseprite 0.0.0"\nexit 0\n')
  const again = await probeAsepriteVersion(flip)
  check('30s cache serves the second read', v.version === '9.9.9' && again.version === '9.9.9')
}

// ── §5 catalog-gate truth table ─────────────────────────────────────────────
section('§5 · catalog-gate truth table')
{
  restore()
  const spriteTree = path.join(scratch, 'gate-sprites')
  mkdirSync(spriteTree, { recursive: true })
  writeFileSync(path.join(spriteTree, 'hero.aseprite'), '')
  const bareTree = path.join(scratch, 'gate-bare')
  mkdirSync(bareTree, { recursive: true })
  // The seam keeps a real install on THIS box out of the located rung; the
  // pin (which wins above the seam) plays the located app.
  process.env.MERCURY_ASEPRITE_NO_DISCOVERY = '1'

  process.env.MERCURY_ASEPRITE = '1'
  _resetAsepriteContextCacheForTesting()
  runWithCwdOverride(spriteTree, () => {
    check('armed + sprite context (no app) ⇒ ON', asepriteToolCatalogEnabled() === true)
  })

  _resetAsepriteContextCacheForTesting()
  runWithCwdOverride(bareTree, () => {
    check('armed + neither ⇒ OFF (no ghost tool)', asepriteToolCatalogEnabled() === false)
  })

  process.env.MERCURY_ASEPRITE_BIN = shim('gate-aseprite', '#!/bin/sh\nexit 0\n')
  _resetAsepriteContextCacheForTesting()
  runWithCwdOverride(bareTree, () => {
    check('armed + located only ⇒ ON (create-from-nothing reachable)', asepriteToolCatalogEnabled() === true)
  })

  delete process.env.MERCURY_ASEPRITE
  _resetAsepriteContextCacheForTesting()
  runWithCwdOverride(spriteTree, () => {
    check('disarmed + both ⇒ OFF', asepriteToolCatalogEnabled() === false)
  })
}

// ── §6 the spawn owner ──────────────────────────────────────────────────────
section('§6 · the spawn owner (-b law, bounds, caps)')
{
  restore()
  const argvLog = path.join(scratch, 'argv.log')
  const recorder = shim(
    'recorder-aseprite',
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argvLog)}\necho ok\nexit 0\n`,
  )
  const r1 = await runAseprite(recorder, ['--version'], { timeoutMs: 5_000 })
  const recorded = readFileSync(argvLog, 'utf8').trim().split('\n')
  check('-b is ALWAYS the first argument (the never-a-GUI law)', recorded[0] === '-b' && recorded[1] === '--version', recorded.join(' '))
  check('healthy run carries stdout + code 0', r1.code === 0 && r1.stdout.trim() === 'ok' && r1.error === undefined)

  // exec replaces the sh with sleep so the kill lands on the process holding
  // the pipes — the faithful shape (the real binary is the direct child).
  const sleeper = shim('sleeper-aseprite', '#!/bin/sh\nexec sleep 30\n')
  const t0 = Date.now()
  const r2 = await runAseprite(sleeper, [], { timeoutMs: 1_000 })
  const elapsed = Date.now() - t0
  check('runaway child killed at the bound, reason carried', r2.code !== 0 && r2.error !== undefined && elapsed < 15_000, `elapsed=${elapsed}ms error=${r2.error}`)

  const shouter = shim(
    'shouter-aseprite',
    '#!/bin/sh\nawk \'BEGIN { for (i = 0; i < 80000; i++) printf "xxxxxxxxxxxxxxxx\\n" }\'\nexit 0\n',
  )
  const r3 = await runAseprite(shouter, [], { timeoutMs: 10_000 })
  check('output cap counts what it swallowed', r3.truncated === true && r3.stdout.includes('truncated'), r3.stdout.slice(-80))
}

restore()
rmSync(scratch, { recursive: true, force: true })

console.log('\n============================================================')
if (failures > 0) {
  console.log(`❌ ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ ALL CHECKS PASS')
