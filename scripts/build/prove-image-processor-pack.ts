#!/usr/bin/env bun
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

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

const { IMAGE_PACK_PATH, imagePackPlatform, imagePackPackages } = await import('../../src/tools/FileReadTool/imageProcessor.ts')
const platform = imagePackPlatform()
const manifest = JSON.parse(readFileSync(join(DIST, 'manifest.json'), 'utf8')) as {
  degraded?: string[]
  imageProcessing?: { vendored?: boolean; path?: string; platform?: string; packages?: string[]; sharp?: string; libvips?: string | null; remedy?: string }
}

section('(1) manifest truth')
const row = manifest.imageProcessing
check('the manifest carries an imageProcessing row', row !== undefined && typeof row.vendored === 'boolean')
const packDir = join(DIST, IMAGE_PACK_PATH, platform)
const packPresent = imagePackPackages(platform).every(name => existsSync(join(packDir, 'node_modules', ...name.split('/'), 'package.json')))
if (row?.vendored === true) {
  check('vendored ⇒ the pack holds every prebuilt package for this platform', packPresent, packDir)
  check('the row names the runtime\'s own platform key and path', row.platform === platform && row.path === `${IMAGE_PACK_PATH}/${platform}`, `${row.platform} ${row.path}`)
  check('the row names sharp\'s version', typeof row.sharp === 'string' && /^\d+\.\d+\.\d+/.test(row.sharp), String(row.sharp))
  check('the row lists the packages', Array.isArray(row.packages) && row.packages.join(',') === imagePackPackages(platform).join(','))
  check('image-processing is not among the degradations', !(manifest.degraded ?? []).includes('image-processing'))
} else {
  check('absent ⇒ no pack on disk', !packPresent)
  check('absent ⇒ image-processing is among the degradations', (manifest.degraded ?? []).includes('image-processing'))
  check('absent ⇒ the remedy names bun install and the JavaScript road', typeof row?.remedy === 'string' && /bun install/.test(row.remedy) && /JavaScript/.test(row.remedy))
}

function stockNode(): string | null {
  const pinned = process.env.MERCURY_NODE
  if (pinned && existsSync(pinned)) return pinned
  const found = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['node'], { encoding: 'utf8' })
  const first = (found.stdout ?? '').split(/\r?\n/).map(l => l.trim()).find(Boolean)
  return first && existsSync(first) ? first : null
}

function doctorRow(node: string, bundle: string, home: string): { status?: string; evidence?: string; detail?: string } | null {
  const env: Record<string, string> = {
    HOME: home,
    MERCURY_CONFIG_DIR: join(home, '.mercury'),
    MERCURY_CREDENTIAL_STORE: 'file',
    PATH: dirname(node),
    TERM: 'dumb',
  }
  const run = spawnSync(node, [bundle, 'doctor', '--json'], { encoding: 'utf8', env, cwd: home, timeout: 180_000, maxBuffer: 64 * 1024 * 1024 })
  const text = run.stdout ?? ''
  const start = text.indexOf('{')
  if (start < 0) {
    console.log(`    doctor produced no JSON (exit ${run.status}): ${(run.stderr ?? '').slice(-300)}`)
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start))
  } catch (e) {
    console.log(`    doctor JSON unparseable: ${String(e)}`)
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

const node = stockNode()
if (node === null) {
  check('a stock node is available for the isolated artifact', false, 'no node on PATH and no MERCURY_NODE')
} else {
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
  const without = doctorRow(node, join(payload, 'mercury.mjs'), home)
  check('the doctor carries the Image processor row', without !== null, 'row missing')
  check('the row names the JavaScript image road, as info (never a fault)', without?.status === 'info' && /JavaScript image road/.test(without.evidence ?? ''), `${without?.status}: ${without?.evidence}`)
  check('…and says what the road still shrinks and where the pack would sit', /PNG and BMP/.test(without?.detail ?? '') && (without?.detail ?? '').includes(IMAGE_PACK_PATH), without?.detail ?? '')

  if (row?.vendored === true && packPresent) {
    section('(3) the isolated artifact with the pack beside it takes the native road')
    cpSync(join(DIST, IMAGE_PACK_PATH), join(payload, IMAGE_PACK_PATH), { recursive: true })
    check('the pack copied beside the bundle', statSync(join(payload, IMAGE_PACK_PATH, platform, 'node_modules', '@img')).isDirectory())
    const withPack = doctorRow(node, join(payload, 'mercury.mjs'), join(iso, 'home2'))
    check('the row names the native processor from the vendored pack, ok', withPack?.status === 'ok' && /native image processor — sharp \d/.test(withPack.evidence ?? '') && /vendored pack/.test(withPack.evidence ?? ''), `${withPack?.status}: ${withPack?.evidence}`)
  } else {
    console.log('  (3) skipped — no vendored pack in this dist (the manifest says so honestly)')
  }
  rmSync(iso, { recursive: true, force: true })
}

console.log(failures === 0 ? '\n✅ the image processor is always there' : `\n❌ ${failures} failure(s)`)
process.exit(failures === 0 ? 0 : 1)
