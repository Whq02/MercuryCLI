#!/usr/bin/env bun
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..', '..')
const SCRATCH = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-pack-')))
process.env.MERCURY_CONFIG_DIR = join(SCRATCH, 'home')
process.env.MERCURY_CREDENTIAL_STORE = 'file'
process.env.MERCURY_DAEMON_DIR = join(SCRATCH, 'daemon')
process.env.NODE_ENV = 'test'
process.env.BROWSER = '/usr/bin/true'
const LIVE = (process.env.MERCURY_SUITE_DESKTOP_LIVE ?? '').trim()
for (const key of ['MERCURY_DESKTOP_PACK_DIR', 'MERCURY_DESKTOP_DRIVER', 'MERCURY_COMPUTER_USE', 'MERCURY_HOME']) delete process.env[key]
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }
process.chdir(ROOT)

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ' — ' + detail.slice(0, 400) : ''}`)
  if (!cond) failures++
}
const warn = (line: string): void => console.log(`  [WARN] ${line}`)
const finish = (note: string): never => {
  rmSync(SCRATCH, { recursive: true, force: true })
  console.log(failures > 0 ? `\nprove-desktop-pack: RED (${failures})` : `\nprove-desktop-pack: green${note ? ` (${note})` : ''}`)
  process.exit(failures > 0 ? 1 : 0)
}

const pack = await import('../../src/services/desktop/pack.js')
const native = await import('../../src/services/desktop/nativeDriver.js')
const driverContract = await import('../../src/services/desktop/driver.js')
const { voicePackPlatform } = await import('../../src/services/voice/voicePack.js')

const PLATFORM = voicePackPlatform()
const PACK_DIR = pack.desktopPackDirFor(ROOT, PLATFORM)
const NATIVE_DIR = join(ROOT, ...pack.DESKTOP_NATIVE_PATH.split('/'))
const BUN = process.execPath
const SESSION_KINDS = ['desktop', 'no-display', 'wayland', 'locked', 'service', 'unknown']
const GRANTS = ['granted', 'denied', 'not-required', 'unknown']

const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8', env: process.env })
const hasCargo = !cargo.error && cargo.status === 0
console.log(`cargo: ${hasCargo ? cargo.stdout.trim() : 'absent'} · platform ${PLATFORM} · live: ${LIVE || 'off'}`)

async function doctorRow(): Promise<{ evidence: string; status: string; section: string } | null> {
  const report = await import('../../src/utils/healthReport.js')
  const cert = await report.runHealthReport({ depth: 'fast' })
  for (const section of cert.sections) {
    const row = section.checks.find(c => c.id === 'iface-computer-use')
    if (row) return { evidence: String(row.evidence), status: String(row.status), section: section.title }
  }
  return null
}

console.log('\n[1] the vendor build')
const setupChain = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts.setup
check('the build is chained into `bun run setup`', setupChain.includes('bun run scripts/vendor/build-desktop.ts'))
const build = spawnSync(BUN, ['run', 'scripts/vendor/build-desktop.ts'], { cwd: ROOT, encoding: 'utf8', env: process.env, timeout: 540_000, maxBuffer: 64 * 1024 * 1024 })
const buildOut = `${build.stdout ?? ''}\n${build.stderr ?? ''}`

if (!hasCargo) {
  check('no cargo ⇒ the build skips LOUDLY: exit 0 and the remedy named', build.status === 0 && /SKIPPED/.test(buildOut) && /rustup/.test(buildOut), buildOut.slice(-400))
  const resolution = pack.resolveDesktopPackDir()
  check('no pack ⇒ the pack owner answers unavailable, naming the platform', resolution.state === 'unavailable' && resolution.note.includes(PLATFORM), JSON.stringify(resolution))
  const row = await doctorRow()
  check('…and the doctor row says the pack is absent', row !== null && row.evidence.startsWith('pack: absent') && row.status === 'info', JSON.stringify(row))
  finish('no cargo — the loud skip')
}

if (build.status !== 0) {
  check('cargo builds the addon on this host', false, buildOut.slice(-800))
  finish('')
}
check('the vendor build ends green (a valid pack is installed or already valid)', /DONE|already valid/.test(buildOut), buildOut.slice(-300))

console.log('\n[2] the pack on disk')
const checkRun = spawnSync(BUN, ['run', 'scripts/vendor/build-desktop.ts', '--check'], { cwd: ROOT, encoding: 'utf8', env: process.env, timeout: 120_000 })
check('--check certifies the pack without cargo (exit 0, OK)', checkRun.status === 0 && /--check: OK/.test(checkRun.stdout ?? ''), `${checkRun.status}: ${(checkRun.stdout ?? '') + (checkRun.stderr ?? '')}`.slice(0, 300))
const manifest = pack.readDesktopPackManifest(PACK_DIR)
check('the manifest is whole: name · version · platform · addon · crates', manifest !== null && manifest.name === pack.DESKTOP_PACK_NAME && manifest.platform === PLATFORM && manifest.addon === pack.DESKTOP_ADDON_FILE && manifest.crates.length > 0, JSON.stringify(manifest))
const onDisk = pack.checkDesktopPackDir(PACK_DIR, { digest: true })
check('the addon bytes match the manifest digest', onDisk.state === 'ok', onDisk.state === 'ok' ? '' : onDisk.note)
check('the manifest records the Rust sources the addon was built from', manifest !== null && manifest.sourceTreeDigest === pack.desktopSourceTreeDigest(NATIVE_DIR))
const licenses = existsSync(join(PACK_DIR, 'licenses')) ? readdirSync(join(PACK_DIR, 'licenses')) : []
const platformCrate = process.platform === 'linux' ? 'x11rb-' : process.platform === 'win32' ? 'windows-' : 'objc2-'
check(`the licence records ride beside the addon: png, napi and ${platformCrate} among them`, licenses.some(l => l.startsWith('png-')) && licenses.some(l => l.startsWith('napi-')) && licenses.some(l => l.startsWith(platformCrate)), licenses.join(','))
const notices = existsSync(join(PACK_DIR, 'NOTICES.json')) ? (JSON.parse(readFileSync(join(PACK_DIR, 'NOTICES.json'), 'utf8')) as { crates?: Array<{ name: string; license: string }> }) : null
check('NOTICES.json inventories every crate with its licence', notices !== null && (notices.crates ?? []).length === (manifest?.crates.length ?? -1) && (notices.crates ?? []).some(c => c.name === 'png' && /MIT|Apache/.test(c.license)), JSON.stringify(notices?.crates?.slice(0, 3)))
check('a pack of another platform reads as a mismatch, never ok', pack.checkDesktopPackDir(PACK_DIR, { platform: 'fixture-os-fixture-arch' }).state === 'mismatch')

console.log('\n[2b] the source pins')
const sourceFiles = readdirSync(join(NATIVE_DIR, 'src')).filter(f => f.endsWith('.rs'))
const sources = new Map(sourceFiles.map(f => [f, readFileSync(join(NATIVE_DIR, 'src', f), 'utf8')]))
const allSource = [...sources.values()].join('\n')
check('the addon never writes to the terminal (no println!, eprintln! or dbg!)', !/\b(println|eprintln|dbg)!/.test(allSource))
const lib = sources.get('lib.rs') ?? ''
check('the held-input state and its release exist', /static HELD/.test(lib) && /pub fn release_all\(/.test(lib))
check('capture is an AsyncTask export; the frontmost read is not', /pub fn capture\([^)]*\)\s*->\s*Result<AsyncTask</.test(lib) && /pub fn frontmost_application\(\)\s*->\s*ApplicationAnswer/.test(lib))
check('the export list carries twenty-one names', pack.DESKTOP_ADDON_EXPORTS.length === 21, String(pack.DESKTOP_ADDON_EXPORTS.length))
const snake = (name: string): string => name.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`)
const missingExports = pack.DESKTOP_ADDON_EXPORTS.filter(name => !new RegExp(`#\\[napi[^\\n]*\\]\\s*\\n\\s*pub fn ${snake(name)}\\(`).test(lib))
check('every listed export is a #[napi] function in the source', missingExports.length === 0, missingExports.join(','))

console.log('\n[3] the addon loads and answers')
const load = pack.loadDesktopAddon()
check('the pack owner resolves the checkout pack and loads the addon', load.state === 'ok' && load.source === 'workspace', load.state === 'ok' ? load.dir : load.note)
let liveReason = LIVE === '' ? 'MERCURY_SUITE_DESKTOP_LIVE is unset' : LIVE !== '1' && LIVE !== 'acts' ? `MERCURY_SUITE_DESKTOP_LIVE is ${LIVE}, not 1 or acts` : ''
if (load.state === 'ok') {
  check('packVersion() is the manifest version', load.addon.packVersion() === load.manifest.version, `${load.addon.packVersion()} vs ${load.manifest.version}`)
  const permissions = load.addon.permissions()
  check('permissions() answers a session in the closed set and two grants in theirs', SESSION_KINDS.includes(permissions.session) && GRANTS.includes(permissions.screenCapture) && GRANTS.includes(permissions.input), JSON.stringify(permissions))
  console.log(`  · permissions: ${JSON.stringify(permissions)}`)
  const displays = load.addon.displays()
  check('displays() answers a list (empty with a reason on a headless host)', Array.isArray(displays.displays) && (displays.displays.length > 0 || typeof displays.reason === 'string'), JSON.stringify(displays))
  console.log(`  · displays: ${displays.displays.length}${displays.reason ? ` (${displays.reason})` : ''}`)
  const held = load.addon.held()
  check('held() answers two empty arrays', Array.isArray(held.buttons) && held.buttons.length === 0 && Array.isArray(held.keys) && held.keys.length === 0, JSON.stringify(held))
  const resolved = native.resolveNativeDesktopDriver()
  check('the native driver resolves over the addon and describes itself as native', resolved.state === 'ok' && resolved.driver.describe().kind === 'native' && resolved.driver.describe().source === 'workspace', resolved.state === 'ok' ? '' : resolved.note)
  const facts = await native.describeDesktopDriver()
  check('the doctor facts begin with the pack version and platform', facts.line.startsWith(`pack: ${load.manifest.version} ${PLATFORM}`), facts.line)
  console.log(`  · doctor: ${facts.line}`)
  const row = await doctorRow()
  check('the doctor row sits in the INTERFACE section with the same line', row !== null && row.section === 'INTERFACE' && row.evidence === facts.line, JSON.stringify(row))
  if (liveReason === '' && (permissions.session !== 'desktop' || !['granted', 'not-required'].includes(permissions.screenCapture) || !['granted', 'not-required'].includes(permissions.input))) {
    liveReason = `session ${permissions.session}, screen ${permissions.screenCapture}, input ${permissions.input}${permissions.reason ? ` — ${permissions.reason}` : ''}`
  }

  console.log('\n[4] live')
  if (liveReason !== '' || resolved.state !== 'ok') {
    warn(`live legs skipped: ${liveReason || 'the driver did not resolve'}`)
  } else {
    const driver = resolved.driver
    const signal = new AbortController().signal
    const list = await driver.displays()
    check('displays() answers through the driver with a fingerprint', list.ok && list.value.displays.length > 0 && /^[0-9a-f]{16}$/.test(list.value.fingerprint), list.ok ? '' : list.error.note)
    const first = list.ok ? list.value.displays[0]! : null
    check('the primary display sits first at the origin', first !== null && first.primary && first.originX === 0 && first.originY === 0, JSON.stringify(first))
    const before = Date.now()
    const shot = await driver.capture(0, signal)
    check('capture(0) answers a PNG', shot.ok && shot.value.png.length > 8 && shot.value.png[0] === 0x89 && shot.value.png.toString('latin1', 1, 4) === 'PNG', shot.ok ? '' : shot.error.note)
    if (shot.ok && first !== null) {
      check('the capture width is the display width in points times the scale', shot.value.width === Math.round(first.width * shot.value.scale) && shot.value.height === Math.round(first.height * shot.value.scale), `${shot.value.width}×${shot.value.height} @ ${shot.value.scale} of ${first.width}×${first.height}`)
      check('the scale is at least one', shot.value.scale >= 1)
      check('capturedAt is the driver\'s stamp at the answer', shot.value.capturedAt >= before && shot.value.capturedAt <= Date.now() + 1)
      console.log(`  · capture: ${shot.value.width}×${shot.value.height} px, ${shot.value.png.length} bytes, scale ${shot.value.scale}`)
    }
    const cursor = await driver.cursor()
    const inside = cursor.ok && list.ok && list.value.displays.some(d => cursor.value.x >= d.originX && cursor.value.x <= d.originX + d.width && cursor.value.y >= d.originY && cursor.value.y <= d.originY + d.height)
    check('cursor() answers a point inside some display', inside, cursor.ok ? JSON.stringify(cursor.value) : cursor.error.note)
    if (cursor.ok) {
      const moved = await driver.mouseMove({ x: cursor.value.x + 1, y: cursor.value.y }, signal)
      const after = await driver.cursor()
      check('a one-point move reads back within one point', moved.ok && after.ok && Math.abs(after.value.x - (cursor.value.x + 1)) <= 1 && Math.abs(after.value.y - cursor.value.y) <= 1, moved.ok ? (after.ok ? JSON.stringify(after.value) : after.error.note) : moved.error.note)
      await driver.mouseMove({ x: cursor.value.x, y: cursor.value.y }, signal)
    }
    if (LIVE === 'acts') {
      const down = await driver.mouseDown('left', signal)
      const heldAfterDown = await driver.held()
      check('mouseDown records the held button', down.ok && heldAfterDown.ok && JSON.stringify(heldAfterDown.value.buttons) === JSON.stringify(['left']), JSON.stringify(heldAfterDown))
      const released = await driver.releaseAll()
      const heldAfterRelease = await driver.held()
      check('releaseAll answers what it released and empties the set', released.ok && JSON.stringify(released.value) === JSON.stringify({ buttons: ['left'], keys: [] }) && heldAfterRelease.ok && heldAfterRelease.value.buttons.length === 0 && heldAfterRelease.value.keys.length === 0, JSON.stringify(released))
      const clicked = await driver.click({ x: 10, y: 10 }, 'left', 1, signal)
      check('click answers a receipt at the point', clicked.ok && clicked.value.act === 'click' && clicked.value.at?.x === 10, clicked.ok ? '' : clicked.error.note)
      const tapped = await driver.keyTap('a', [], signal)
      check('keyTap answers a receipt', tapped.ok && tapped.value.act === 'keyTap', tapped.ok ? '' : tapped.error.note)
      const typed = await driver.typeText('twenty characters..', {}, signal)
      check('typeText answers a receipt', typed.ok && typed.value.act === 'type', typed.ok ? '' : typed.error.note)
      const scrolled = await driver.scroll({ x: 10, y: 10 }, 0, 3, signal)
      check('scroll answers a receipt', scrolled.ok && scrolled.value.act === 'scroll', scrolled.ok ? '' : scrolled.error.note)
      const front = await driver.frontmostApplication()
      check('frontmostApplication answers an application, or the display refusal where no window manager runs', front.ok ? front.value.identity.length > 0 : front.error.kind === 'display', front.ok ? JSON.stringify(front.value) : JSON.stringify(front.error))
      console.log(`  · frontmost: ${front.ok ? `${front.value.name} (${front.value.identity})` : front.error.note}`)
    }
  }

  console.log('\n[5] the addon loads on the vendored Node and a PATH Node alike (Node-API is ABI-stable)')
  const loader = [
    'const a = require(process.argv[1])',
    `const fns = ${JSON.stringify(pack.DESKTOP_ADDON_EXPORTS)}`,
    "const missing = fns.filter(f => typeof a[f] !== 'function')",
    "if (missing.length > 0) { console.log('MISSING ' + missing.join(',')); process.exit(3) }",
    "console.log('LOADED ' + process.version + ' pack ' + a.packVersion() + ' displays=' + a.displays().displays.length)",
  ].join('; ')
  const addonPath = join(load.dir, load.manifest.addon)
  const onPath = (name: string): string | null => {
    const suffixes = process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
    for (const dir of (process.env.PATH ?? '').split(delimiter).filter(d => d !== '')) {
      for (const suffix of suffixes) {
        const candidate = join(dir, name + suffix)
        try {
          if (statSync(candidate).isFile()) return candidate
        } catch {
          continue
        }
      }
    }
    return null
  }
  const vendoredNode = (): string | null => {
    const key = `${process.platform}-${process.arch}`
    for (const rel of [join('bin', 'node'), 'node.exe', 'node']) {
      const candidate = join(ROOT, 'vendor', 'node', 'extracted', key, rel)
      if (existsSync(candidate)) return candidate
    }
    return null
  }
  const hosts: Array<[string, string | null]> = [
    ['a PATH node', onPath('node')],
    ['the vendored node', vendoredNode()],
  ]
  for (const [label, exe] of hosts) {
    if (exe === null) {
      warn(`${label} is absent on this host — that load leg is skipped`)
      continue
    }
    const res = spawnSync(exe, ['-e', loader, addonPath], { encoding: 'utf8', env: process.env, timeout: 30_000 })
    const line = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim().split('\n').slice(-1)[0] ?? ''
    check(`${label} loads the addon and answers its whole surface`, res.status === 0 && /^LOADED v\d+/.test(line), `${exe}: ${String(res.status)} ${line}`)
    console.log(`  · ${label}: ${line}`)
  }
  check('the isDesktopKey table and the addon agree on a named key and refuse a nonsense one', driverContract.isDesktopKey('enter') && !driverContract.isDesktopKey('hyperspace'))
}

finish(liveReason === '' ? 'live' : `live legs skipped: ${liveReason}`)
