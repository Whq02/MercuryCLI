#!/usr/bin/env bun
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fakeCommand } from '../dap/fakeCommand.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

let failures = 0
function check(label: string, cond: boolean, detail = '', hint = ''): void {
  if (!cond) failures++
  const shown = !cond && hint ? (detail ? `${detail} — to fix: ${hint}` : `to fix: ${hint}`) : detail
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${shown ? ` — ${shown}` : ''}`)
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
} = await import('../../src/integrations/aseprite/asepriteApp.js')
const { asepriteToolCatalogEnabled, _resetAsepriteContextCacheForTesting } = await import(
  '../../src/integrations/aseprite/gates.js'
)
const { runWithCwdOverride } = await import('../../src/platform/files/cwd.js')

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

section('§1 · opt-in polarity')
{
  restore()
  check('unset ⇒ gate OFF', mercuryAsepriteEnabled() === false, '', 'mercuryAsepriteEnabled in src/integrations/aseprite/asepriteApp.ts must read MERCURY_ASEPRITE as opt-in, false when unset')
  check('unset ⇒ catalog seam OFF regardless of context', asepriteToolCatalogEnabled() === false, '', 'asepriteToolCatalogEnabled in src/integrations/aseprite/gates.ts must return false while MERCURY_ASEPRITE is unset')
  process.env.MERCURY_ASEPRITE = '1'
  check('=1 ⇒ gate ON', mercuryAsepriteEnabled() === true, '', 'mercuryAsepriteEnabled in src/integrations/aseprite/asepriteApp.ts must return true when MERCURY_ASEPRITE=1')
  process.env.MERCURY_ASEPRITE = '0'
  check('=0 ⇒ gate OFF', mercuryAsepriteEnabled() === false, '', 'mercuryAsepriteEnabled in src/integrations/aseprite/asepriteApp.ts must return false when MERCURY_ASEPRITE=0')
}

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
  check('finds .aseprite AND .ase, skips hidden/VCS dirs', d.total === 3, `total=${d.total}`, 'discoverSpriteFiles in src/integrations/aseprite/asepriteApp.ts must count .aseprite and .ase files and skip hidden, VCS and node_modules directories')
  check(
    'deterministic relative paths',
    d.files.join('|') === 'art/chars/npc.aseprite|art/tiles.ase|hero.aseprite',
    d.files.join('|'),
    'discoverSpriteFiles in src/integrations/aseprite/asepriteApp.ts must return sorted paths relative to the start folder',
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
    'discoverSpriteFiles in src/integrations/aseprite/asepriteApp.ts must keep SPRITE_FILE_CAP files, count every sprite in total and report the rest as truncated',
  )
}

section('§3 · location rungs')
{
  restore()
  const pinTarget = shim('pinned-aseprite', '#!/bin/sh\nexit 0\n')
  process.env.MERCURY_ASEPRITE_BIN = pinTarget
  let census = locateAseprite()
  check('pin rung wins when the file exists', census.aseprite?.source === 'pin' && census.aseprite.path === pinTarget, '', 'locateAseprite in src/integrations/aseprite/asepriteApp.ts must try MERCURY_ASEPRITE_BIN first and report source pin')

  process.env.MERCURY_ASEPRITE_BIN = path.join(scratch, 'nowhere', 'aseprite')
  census = locateAseprite()
  check(
    'broken pin refuses BY NAME, no silent fallback',
    census.aseprite === undefined && (census.pinError ?? '').includes('MERCURY_ASEPRITE_BIN is set to') && (census.pinError ?? '').includes('which does not exist'),
    census.pinError,
    'locateAseprite in src/integrations/aseprite/asepriteApp.ts must return a pinError naming MERCURY_ASEPRITE_BIN and that the file does not exist, with no fallback to other rungs',
  )

  delete process.env.MERCURY_ASEPRITE_BIN
  const binDir = path.join(scratch, 'path-bin')
  mkdirSync(binDir, { recursive: true })
  const onPath = path.join(binDir, process.platform === 'win32' ? 'aseprite.cmd' : 'aseprite')
  if (process.platform === 'win32') {
    writeFileSync(onPath, '@echo off\r\nexit /b 0\r\n')
  } else {
    writeFileSync(onPath, '#!/bin/sh\nexit 0\n')
    chmodSync(onPath, 0o755)
  }
  const savedPath = process.env.PATH
  process.env.PATH = binDir
  census = locateAseprite()
  check('PATH rung', census.aseprite?.source === 'path' && census.aseprite.path === onPath, '', 'locateAseprite in src/integrations/aseprite/asepriteApp.ts must find aseprite on PATH and report source path')
  process.env.PATH = savedPath

  const bundle = path.join(scratch, 'Aseprite.app', 'Contents', 'MacOS')
  mkdirSync(bundle, { recursive: true })
  const bundleBin = path.join(bundle, 'aseprite')
  writeFileSync(bundleBin, '#!/bin/sh\nexit 0\n')
  census = locateAseprite({ platform: 'darwin', skipPathProbe: true, appBundles: [bundleBin] })
  check('darwin app-bundle rung', census.aseprite?.source === 'app-bundle' && census.aseprite.path === bundleBin, '', 'locateAseprite in src/integrations/aseprite/asepriteApp.ts must try the appBundles candidates on darwin and report source app-bundle')

  const steamDir = path.join(scratch, 'steam-lib', 'steamapps', 'common', 'Aseprite')
  mkdirSync(steamDir, { recursive: true })
  const steamBin = path.join(steamDir, 'aseprite')
  writeFileSync(steamBin, '#!/bin/sh\nexit 0\n')
  census = locateAseprite({ platform: 'linux', skipPathProbe: true, steamCandidates: [steamBin] })
  check('Steam-library rung', census.aseprite?.source === 'steam' && census.aseprite.path === steamBin, '', 'locateAseprite in src/integrations/aseprite/asepriteApp.ts must try the steamCandidates and report source steam')

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
  check('win32 installer rung (source named)', census.aseprite?.source === 'program-files' && census.aseprite.path === pfBin, '', 'locateAseprite in src/integrations/aseprite/asepriteApp.ts must take the first existing win32Candidates entry and report its source')
  census = locateAseprite({
    platform: 'win32',
    skipPathProbe: true,
    steamCandidates: [],
    win32Candidates: [{ candidate: itchBin, source: 'itch' }],
  })
  check('win32 itch rung (source named)', census.aseprite?.source === 'itch' && census.aseprite.path === itchBin, '', 'locateAseprite in src/integrations/aseprite/asepriteApp.ts must fall to the next win32Candidates entry and report its source')

  census = locateAseprite({ platform: 'linux', skipPathProbe: true, steamCandidates: [] })
  check('nothing found ⇒ empty census, never a throw', census.aseprite === undefined && census.pinError === undefined, '', 'locateAseprite in src/integrations/aseprite/asepriteApp.ts must return an empty census when no rung finds a binary')

  process.env.MERCURY_ASEPRITE_NO_DISCOVERY = '1'
  const r = resolveAseprite()
  check(
    'unavailable verdict names the roads probed',
    r.state === 'unavailable' &&
      r.note.includes('PATH') &&
      r.note.includes('Steam') &&
      r.note.includes('MERCURY_ASEPRITE_BIN'),
    r.state === 'unavailable' ? r.note : r.state,
    'resolveAseprite in src/integrations/aseprite/asepriteApp.ts must return state unavailable with a note naming PATH, Steam and MERCURY_ASEPRITE_BIN',
  )
  check(
    'unavailable verdict carries the install remedy (never-installs sentence)',
    r.state === 'unavailable' && r.remedies.includes(ASEPRITE_INSTALL_REMEDY) && ASEPRITE_INSTALL_REMEDY.includes('never installs'),
    '',
    'resolveAseprite in src/integrations/aseprite/asepriteApp.ts must put ASEPRITE_INSTALL_REMEDY in remedies, and that text must say Mercury never installs',
  )
  process.env.MERCURY_ASEPRITE_BIN = pinTarget
  const ok = resolveAseprite()
  check('resolved verdict carries the location (pin wins above the seam)', ok.state === 'ok' && ok.location.source === 'pin', '', 'resolveAseprite in src/integrations/aseprite/asepriteApp.ts must honour MERCURY_ASEPRITE_BIN even with MERCURY_ASEPRITE_NO_DISCOVERY set')
  delete process.env.MERCURY_ASEPRITE_NO_DISCOVERY
}

section('§4 · the version probe (shim fake)')
{
  restore()
  const release = fakeCommand(scratch, 'release-aseprite', 'Aseprite 1.3.7-arm64\n', scratch)
  let v = await probeAsepriteVersion(release)
  check('parses the release shape "Aseprite 1.3.7-arm64"', v.version === '1.3.7-arm64' && v.reason === undefined, v.reason, 'probeAsepriteVersion in src/integrations/aseprite/asepriteApp.ts must parse the output Aseprite 1.3.7-arm64 into version 1.3.7-arm64')
  _resetAsepriteVersionProbeForTesting()
  const dev = fakeCommand(scratch, 'dev-aseprite', 'Aseprite 1.x-dev\n', scratch)
  v = await probeAsepriteVersion(dev)
  check('parses the source-build shape "Aseprite 1.x-dev"', v.version === '1.x-dev' && v.reason === undefined, v.reason, 'probeAsepriteVersion in src/integrations/aseprite/asepriteApp.ts must parse the output Aseprite 1.x-dev into version 1.x-dev')
  _resetAsepriteVersionProbeForTesting()
  const foreign = fakeCommand(scratch, 'foreign-aseprite', 'something else\n', scratch)
  v = await probeAsepriteVersion(foreign)
  check('foreign output ⇒ reason, never a throw', v.version === undefined && (v.reason ?? '').includes('unparseable'), v.reason, 'probeAsepriteVersion in src/integrations/aseprite/asepriteApp.ts must return a reason containing unparseable, not throw, on foreign output')
  _resetAsepriteVersionProbeForTesting()
  const flip = fakeCommand(scratch, 'flip-aseprite', 'Aseprite 9.9.9\n', scratch)
  v = await probeAsepriteVersion(flip)
  if (process.platform === 'win32') {
    writeFileSync(path.join(scratch, 'flip-aseprite.out'), 'Aseprite 0.0.0\n')
  } else {
    writeFileSync(flip, '#!/bin/sh\necho "Aseprite 0.0.0"\nexit 0\n')
  }
  const again = await probeAsepriteVersion(flip)
  check('30s cache serves the second read', v.version === '9.9.9' && again.version === '9.9.9', '', 'probeAsepriteVersion in src/integrations/aseprite/asepriteApp.ts must cache the probe per binary for 30 seconds')
}

section('§5 · catalog-gate truth table')
{
  restore()
  const spriteTree = path.join(scratch, 'gate-sprites')
  mkdirSync(spriteTree, { recursive: true })
  writeFileSync(path.join(spriteTree, 'hero.aseprite'), '')
  const bareTree = path.join(scratch, 'gate-bare')
  mkdirSync(bareTree, { recursive: true })
  process.env.MERCURY_ASEPRITE_NO_DISCOVERY = '1'

  process.env.MERCURY_ASEPRITE = '1'
  _resetAsepriteContextCacheForTesting()
  runWithCwdOverride(spriteTree, () => {
    check('armed + sprite context (no app) ⇒ ON', asepriteToolCatalogEnabled() === true, '', 'asepriteToolCatalogEnabled in src/integrations/aseprite/gates.ts must be true when armed and the working folder holds a sprite file')
  })

  _resetAsepriteContextCacheForTesting()
  runWithCwdOverride(bareTree, () => {
    check('armed + neither ⇒ OFF (no ghost tool)', asepriteToolCatalogEnabled() === false, '', 'asepriteToolCatalogEnabled in src/integrations/aseprite/gates.ts must be false when armed but there is no sprite file and no located app')
  })

  process.env.MERCURY_ASEPRITE_BIN = shim('gate-aseprite', '#!/bin/sh\nexit 0\n')
  _resetAsepriteContextCacheForTesting()
  runWithCwdOverride(bareTree, () => {
    check('armed + located only ⇒ ON (create-from-nothing reachable)', asepriteToolCatalogEnabled() === true, '', 'asepriteToolCatalogEnabled in src/integrations/aseprite/gates.ts must be true when armed and a binary is located, even with no sprite file')
  })

  delete process.env.MERCURY_ASEPRITE
  _resetAsepriteContextCacheForTesting()
  runWithCwdOverride(spriteTree, () => {
    check('disarmed + both ⇒ OFF', asepriteToolCatalogEnabled() === false, '', 'asepriteToolCatalogEnabled in src/integrations/aseprite/gates.ts must be false whenever MERCURY_ASEPRITE is unset')
  })
}

section('§6 · the spawn owner (-b law, bounds, caps)')
if (process.platform === 'win32') {
  console.log('not read on Windows: spawn owner shims use POSIX #!/bin/sh')
} else {
  restore()
  const argvLog = path.join(scratch, 'argv.log')
  const recorder = shim(
    'recorder-aseprite',
    `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(argvLog)}\necho ok\nexit 0\n`,
  )
  const r1 = await runAseprite(recorder, ['--version'], { timeoutMs: 5_000 })
  const recorded = readFileSync(argvLog, 'utf8').trim().split('\n')
  check('-b is ALWAYS the first argument (the never-a-GUI law)', recorded[0] === '-b' && recorded[1] === '--version', recorded.join(' '), 'runAseprite in src/integrations/aseprite/asepriteApp.ts must put -b before the caller arguments on every spawn')
  check('healthy run carries stdout + code 0', r1.code === 0 && r1.stdout.trim() === 'ok' && r1.error === undefined, '', 'runAseprite in src/integrations/aseprite/asepriteApp.ts must return the child stdout and exit code 0 for a clean run')

  const sleeper = shim('sleeper-aseprite', '#!/bin/sh\nexec sleep 30\n')
  const t0 = Date.now()
  const r2 = await runAseprite(sleeper, [], { timeoutMs: 1_000 })
  const elapsed = Date.now() - t0
  check('runaway child killed at the bound, reason carried', r2.code !== 0 && r2.error !== undefined && elapsed < 15_000, `elapsed=${elapsed}ms error=${r2.error}`, 'runAseprite in src/integrations/aseprite/asepriteApp.ts must kill the child at timeoutMs and return the reason in error')

  const shouter = shim(
    'shouter-aseprite',
    '#!/bin/sh\nawk \'BEGIN { for (i = 0; i < 80000; i++) printf "xxxxxxxxxxxxxxxx\\n" }\'\nexit 0\n',
  )
  const r3 = await runAseprite(shouter, [], { timeoutMs: 10_000 })
  check('output cap counts what it swallowed', r3.truncated === true && r3.stdout.includes('truncated'), r3.stdout.slice(-80), 'runAseprite in src/integrations/aseprite/asepriteApp.ts must cap captured output, set truncated and say in stdout that it truncated')
}

restore()
rmSync(scratch, { recursive: true, force: true })

console.log('\n============================================================')
if (failures > 0) {
  console.log(`❌ ${failures} check(s) failed`)
  process.exit(1)
}
console.log('✅ ALL CHECKS PASS')
