#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { nodeBinPath } from '../lib/nodeBin.ts'

const ROOT = join(import.meta.dir, '..', '..')
process.chdir(ROOT)
const DIST = join(ROOT, 'dist')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

if (!existsSync(join(DIST, 'mercury.mjs')) || !existsSync(join(DIST, 'manifest.json'))) {
  console.error('✗ dist/mercury.mjs or dist/manifest.json missing — run `bun run build.ts` first')
  process.exit(1)
}

const { IMAGE_PACK_PATH, imagePackPlatform, imagePackPackages } = await import('../../src/platform/images/imageProcessor.ts')
const platform = imagePackPlatform()
const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8')) as {
  degraded?: string[]
  imageProcessing?: { vendored?: boolean; path?: string; platform?: string; packages?: string[]; sharp?: string; libvips?: string | null; remedy?: string }
}

section('(1) manifest truth')
const row = manifest.imageProcessing
check('the manifest carries an imageProcessing row', row !== undefined && typeof row.vendored === 'boolean', 'build.ts must write imageProcessing.vendored into dist/manifest.json; rebuild with bun run build.ts')
const packDir = join(DIST, IMAGE_PACK_PATH, platform)
const packPresent = imagePackPackages(platform).every(name => existsSync(join(packDir, 'node_modules', ...name.split('/'), 'package.json')))
if (row?.vendored === true) {
  check('vendored ⇒ the pack holds every prebuilt package for this platform', packPresent, `${packDir} — the manifest says vendored but a prebuilt package is missing there; fix the image pack step in build.ts (packages listed by imagePackPackages in src/platform/images/imagePackArm.ts) and rebuild`)
  check('the row names the runtime\'s own platform key and path', row.platform === platform && row.path === `${IMAGE_PACK_PATH}/${platform}`, `${row.platform} ${row.path} — the imageProcessing row written by build.ts must use imagePackPlatform() and IMAGE_PACK_PATH from src/platform/images/imagePackArm.ts`)
  check('the row names sharp\'s version', typeof row.sharp === 'string' && /^\d+\.\d+\.\d+/.test(row.sharp), `${String(row.sharp)} — build.ts must write the sharp version of the vendored pack (imagePackMeta.sharp) into the imageProcessing row`)
  check('the row lists the packages', Array.isArray(row.packages) && row.packages.join(',') === imagePackPackages(platform).join(','), `manifest packages: ${JSON.stringify(row.packages)} — build.ts must list the packages that imagePackPackages returns in src/platform/images/imagePackArm.ts`)
  check('image-processing is not among the degradations', !(manifest.degraded ?? []).includes('image-processing'), 'build.ts lists image-processing in degraded only when the pack is not vendored; drop it from degraded when imageProcessing.vendored is true')
} else {
  check('absent ⇒ no pack on disk', !packPresent, `${packDir} holds the packages although the manifest says not vendored; build.ts must set imageProcessing.vendored true when the pack is copied`)
  check('absent ⇒ image-processing is among the degradations', (manifest.degraded ?? []).includes('image-processing'), 'build.ts must list image-processing in the manifest degraded array when the pack is not vendored')
  check('absent ⇒ the remedy names bun install and the JavaScript road', typeof row?.remedy === 'string' && /bun install/.test(row.remedy) && /JavaScript/.test(row.remedy), `remedy: ${String(row?.remedy)} — the imageProcessing remedy text in build.ts must name bun install and the JavaScript road`)
}

function healthRow(node: string, bundle: string, home: string): { status?: string; evidence?: string; detail?: string } | null {
  const env: Record<string, string> = {
    HOME: home,
    MERCURY_CONFIG_DIR: join(home, '.mercury'),
    MERCURY_CREDENTIAL_STORE: 'file',
    PATH: dirname(node),
    TERM: 'dumb',
  }
  const run = spawnSync(node, [bundle, 'health', '--json'], { encoding: 'utf8', env, cwd: home, timeout: 180_000, maxBuffer: 64 * 1024 * 1024 })
  const text = run.stdout ?? ''
  const start = text.indexOf('{')
  if (start < 0) {
    console.log(`    health produced no JSON (exit ${run.status}): ${(run.stderr ?? '').slice(-300)}`)
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start))
  } catch (e) {
    console.log(`    health JSON unparseable: ${String(e)}`)
    return null
  }
  const stack: unknown[] = [parsed]
  while (stack.length > 0) {
    const node = stack.pop()
    if (Array.isArray(node)) {
      stack.push(...node)
    } else if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>
      if (record.id === 'iface-image-processor') return record as { status?: string; evidence?: string; detail?: string }
      stack.push(...Object.values(record))
    }
  }
  return null
}

const node = nodeBinPath()
{
  const iso = mkdtempSync(join(tmpdir(), 'mercury-image-pack-iso-'))
  const payload = join(iso, 'mercury')
  cpSync(join(DIST, 'mercury.mjs'), join(payload, 'mercury.mjs'))
  for (const f of ['splash.mjs', 'splash-core.mjs', 'manifest.json']) {
    if (existsSync(join(DIST, f))) cpSync(join(DIST, f), join(payload, f))
  }
  const home = join(iso, 'home')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(iso, 'home2'), { recursive: true })

  section('(2) the isolated artifact without the pack takes the JavaScript road')
  const without = healthRow(node, join(payload, 'mercury.mjs'), home)
  check('/health carries the Image processor row', without !== null, 'row missing — the iface-image-processor entry in src/platform/health/sections/interface.ts did not appear in health --json; see the health output printed above')
  check('the row names the JavaScript image road, as warn (an image that road cannot size is left out of the request)', without?.status === 'warn' && /JavaScript image road/.test(without.evidence ?? ''), `${without?.status}: ${without?.evidence} — describeImageProcessor in src/platform/images/imageProcessor.ts must report a warn line naming the JavaScript image road when the pack is absent`)
  check('…and says what the road still shrinks, what happens to an image it cannot size, and where the pack would sit', /PNG and BMP/.test(without?.detail ?? '') && /left out of the request/.test(without?.detail ?? '') && (without?.detail ?? '').includes(IMAGE_PACK_PATH), `${without?.detail ?? ''} — the detail built by describeImageProcessor in src/platform/images/imageProcessor.ts must carry all three statements`)

  if (row?.vendored === true && packPresent) {
    section('(3) the isolated artifact with the pack beside it takes the native road')
    cpSync(join(DIST, IMAGE_PACK_PATH), join(payload, IMAGE_PACK_PATH), { recursive: true })
    check('the pack copied beside the bundle', statSync(join(payload, IMAGE_PACK_PATH, platform, 'node_modules', '@img')).isDirectory())
    const withPack = healthRow(node, join(payload, 'mercury.mjs'), join(iso, 'home2'))
    check('the row names the native processor from the vendored pack, ok', withPack?.status === 'ok' && /native image processor — sharp \d/.test(withPack.evidence ?? '') && /vendored pack/.test(withPack.evidence ?? ''), `${withPack?.status}: ${withPack?.evidence} — describeImageProcessor in src/platform/images/imageProcessor.ts must report ok with the native sharp line when the vendored pack sits beside the bundle`)
  } else {
    console.log('  (3) skipped — no vendored pack in this dist (the manifest says so honestly)')
  }
  rmSync(iso, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n✅ the image processor is always there' : `\n❌ ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
