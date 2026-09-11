import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { voiceCheckoutRoot, voicePackPlatform, voicePackTreeDigest, voiceSourceTreeDigest } from '../voice/voicePack.js'

export const DESKTOP_PACK_SEGMENTS = ['vendor', 'desktop'] as const
export const DESKTOP_PACK_PATH = 'vendor/desktop'
export const DESKTOP_ADDON_FILE = 'mercury_desktop.node'
export const DESKTOP_PACK_MANIFEST_FILE = '.vendor-manifest.json'
export const DESKTOP_PACK_NAME = 'mercury-desktop'
export const DESKTOP_NATIVE_PATH = 'native/desktop'
export const DESKTOP_BUILD_COMMAND = 'bun run scripts/vendor/build-desktop.ts'
export const DESKTOP_PACK_ABSENT_PREFIX = 'no desktop driver pack for '

export function desktopPackDirFor(root: string, platform: string = voicePackPlatform()): string {
  return path.join(root, ...DESKTOP_PACK_SEGMENTS, platform)
}

export function desktopSourceTreeDigest(nativeDir: string): string {
  return voiceSourceTreeDigest(nativeDir)
}

export function desktopPackTreeDigest(dir: string): { fileCount: number; treeDigest: string } {
  return voicePackTreeDigest(dir)
}

export interface DesktopPackCrate {
  name: string
  version: string
  license: string
}

export interface DesktopPackManifest {
  name: typeof DESKTOP_PACK_NAME
  version: string
  platform: string
  addon: string
  addonSha256: string
  sourceTreeDigest: string
  cargo: string
  crates: DesktopPackCrate[]
  fileCount: number
  treeDigest: string
}

const HEX64 = /^[0-9a-f]{64}$/

export function readDesktopPackManifest(dir: string): DesktopPackManifest | null {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path.join(dir, DESKTOP_PACK_MANIFEST_FILE), 'utf8'))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const m = raw as Record<string, unknown>
  if (
    m.name !== DESKTOP_PACK_NAME ||
    typeof m.version !== 'string' ||
    typeof m.platform !== 'string' ||
    typeof m.addon !== 'string' ||
    typeof m.addonSha256 !== 'string' ||
    !HEX64.test(m.addonSha256) ||
    typeof m.sourceTreeDigest !== 'string' ||
    !HEX64.test(m.sourceTreeDigest) ||
    typeof m.treeDigest !== 'string' ||
    !HEX64.test(m.treeDigest) ||
    typeof m.fileCount !== 'number' ||
    !Array.isArray(m.crates)
  ) {
    return null
  }
  const crates: DesktopPackCrate[] = []
  for (const c of m.crates as unknown[]) {
    if (typeof c !== 'object' || c === null) return null
    const { name, version, license } = c as Record<string, unknown>
    if (typeof name !== 'string' || typeof version !== 'string' || typeof license !== 'string') return null
    crates.push({ name, version, license })
  }
  return {
    name: DESKTOP_PACK_NAME,
    version: m.version,
    platform: m.platform,
    addon: m.addon,
    addonSha256: m.addonSha256,
    sourceTreeDigest: m.sourceTreeDigest,
    cargo: typeof m.cargo === 'string' ? m.cargo : '',
    crates,
    fileCount: m.fileCount,
    treeDigest: m.treeDigest,
  }
}

export type DesktopPackCheck =
  | { state: 'ok'; addonPath: string; manifest: DesktopPackManifest }
  | { state: 'absent'; note: string }
  | { state: 'mismatch'; note: string }

export function checkDesktopPackDir(dir: string, opts: { digest?: boolean; platform?: string } = {}): DesktopPackCheck {
  const manifest = readDesktopPackManifest(dir)
  if (manifest === null) {
    return { state: 'absent', note: existsSync(dir) ? `${dir} carries no readable ${DESKTOP_PACK_MANIFEST_FILE}` : `${dir} is absent` }
  }
  const platform = opts.platform ?? voicePackPlatform()
  if (manifest.platform !== platform) {
    return { state: 'mismatch', note: `the pack at ${dir} was built for ${manifest.platform}, this host is ${platform}` }
  }
  const addonPath = path.join(dir, manifest.addon)
  if (!existsSync(addonPath)) return { state: 'mismatch', note: `the manifest at ${dir} names ${manifest.addon} but the file is absent` }
  if (opts.digest) {
    const actual = createHash('sha256').update(readFileSync(addonPath)).digest('hex')
    if (actual !== manifest.addonSha256) {
      return { state: 'mismatch', note: `${manifest.addon} does not match the manifest digest (expected ${manifest.addonSha256.slice(0, 12)}…, got ${actual.slice(0, 12)}…)` }
    }
  }
  return { state: 'ok', addonPath, manifest }
}

export type DesktopPackResolution =
  | { state: 'ok'; dir: string; addonPath: string; manifest: DesktopPackManifest; source: 'override' | 'vendored' | 'workspace' }
  | { state: 'unavailable'; note: string }

export function desktopPackAbsentNote(checkoutRoot: string | null = voiceCheckoutRoot()): string {
  return checkoutRoot !== null
    ? `absent on this checkout — bun run setup builds it with cargo (${DESKTOP_BUILD_COMMAND} alone rebuilds it), then bun run build.ts`
    : 'absent — this build shipped without it; a release archive carries the driver when its packaging host could build it, so mercury update to a release that does, or build from source'
}

export function resolveDesktopPackDir(): DesktopPackResolution {
  const override = flagEnv('MERCURY_DESKTOP_PACK_DIR')
  if (override !== undefined && override.trim() !== '') {
    const check = checkDesktopPackDir(override)
    if (check.state === 'ok') return { state: 'ok', dir: override, addonPath: check.addonPath, manifest: check.manifest, source: 'override' }
    return { state: 'unavailable', note: `MERCURY_DESKTOP_PACK_DIR set but ${check.note} — the pin names itself, no silent fallback` }
  }
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const platform = voicePackPlatform()
  const vendored = desktopPackDirFor(moduleDir, platform)
  const vendoredCheck = checkDesktopPackDir(vendored)
  if (vendoredCheck.state === 'ok') {
    return { state: 'ok', dir: vendored, addonPath: vendoredCheck.addonPath, manifest: vendoredCheck.manifest, source: 'vendored' }
  }
  let dir = moduleDir
  for (let i = 0; i < 6; i++) {
    const candidate = desktopPackDirFor(dir, platform)
    const check = checkDesktopPackDir(candidate)
    if (check.state === 'ok') return { state: 'ok', dir: candidate, addonPath: check.addonPath, manifest: check.manifest, source: 'workspace' }
    if (check.state === 'mismatch') return { state: 'unavailable', note: check.note }
    if (existsSync(path.join(dir, 'package.json')) || existsSync(path.join(dir, '.git'))) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  if (vendoredCheck.state === 'mismatch') return { state: 'unavailable', note: vendoredCheck.note }
  return {
    state: 'unavailable',
    note: `${DESKTOP_PACK_ABSENT_PREFIX}${platform}: neither ${DESKTOP_PACK_PATH}/${platform} beside the bundle nor the checkout's own`,
  }
}

export interface DesktopAddonPermissions {
  session: string
  screenCapture: string
  input: string
  reason?: string | null
}

export interface DesktopAddonDisplay {
  index: number
  id: string
  originX: number
  originY: number
  width: number
  height: number
  scale: number
  primary: boolean
}

export interface DesktopAddonDisplays {
  displays: DesktopAddonDisplay[]
  reason?: string | null
}

export interface DesktopAddonCapture {
  png: Uint8Array
  width: number
  height: number
  scale: number
  display: number
  displayId: string
  originX: number
  originY: number
  capturedAt: number
}

export interface DesktopAddonBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface DesktopAddonApplication {
  identity?: string | null
  name?: string | null
  pid?: number | null
  title?: string | null
  bounds?: DesktopAddonBounds | null
  reason?: string | null
}

export interface DesktopAddonCursor {
  x?: number | null
  y?: number | null
  display?: number | null
  reason?: string | null
}

export interface DesktopAddonHeld {
  buttons: string[]
  keys: string[]
}

export interface DesktopAddon {
  packVersion(): string
  permissions(): DesktopAddonPermissions
  requestPermissions(): DesktopAddonPermissions
  displays(): DesktopAddonDisplays
  capture(display: number): Promise<DesktopAddonCapture>
  frontmostApplication(): DesktopAddonApplication
  ownTerminalApplication(): DesktopAddonApplication
  cursor(): DesktopAddonCursor
  mouseMove(x: number, y: number): void
  mouseDown(button: string): void
  mouseUp(button: string): void
  click(x: number, y: number, button: string, count: number): void
  drag(fromX: number, fromY: number, toX: number, toY: number, button: string): Promise<void>
  scroll(x: number, y: number, deltaX: number, deltaY: number): void
  keyTap(key: string, modifiers: string[]): void
  keyDown(key: string): void
  keyUp(key: string): void
  typeText(text: string, gapMs?: number | null): Promise<void>
  held(): DesktopAddonHeld
  releaseAll(): DesktopAddonHeld
  cancel(): void
}

export const DESKTOP_ADDON_EXPORTS = [
  'packVersion',
  'permissions',
  'requestPermissions',
  'displays',
  'capture',
  'frontmostApplication',
  'ownTerminalApplication',
  'cursor',
  'mouseMove',
  'mouseDown',
  'mouseUp',
  'click',
  'drag',
  'scroll',
  'keyTap',
  'keyDown',
  'keyUp',
  'typeText',
  'held',
  'releaseAll',
  'cancel',
] as const

export type DesktopAddonLoad =
  | { state: 'ok'; addon: DesktopAddon; dir: string; manifest: DesktopPackManifest; source: 'override' | 'vendored' | 'workspace' }
  | { state: 'unavailable'; note: string }

let loaded: DesktopAddonLoad | null = null

export function loadDesktopAddon(): DesktopAddonLoad {
  if (loaded !== null) return loaded
  const resolution = resolveDesktopPackDir()
  if (resolution.state === 'unavailable') return resolution
  try {
    const req = createRequire(resolution.addonPath)
    const target: string = resolution.addonPath
    const raw = req(target) as Partial<DesktopAddon>
    for (const fn of DESKTOP_ADDON_EXPORTS) {
      if (typeof raw[fn] !== 'function') {
        loaded = { state: 'unavailable', note: `the desktop addon at ${resolution.addonPath} exports no ${fn}() — rebuild it: ${DESKTOP_BUILD_COMMAND}` }
        return loaded
      }
    }
    loaded = { state: 'ok', addon: raw as DesktopAddon, dir: resolution.dir, manifest: resolution.manifest, source: resolution.source }
  } catch (error) {
    loaded = {
      state: 'unavailable',
      note: `the desktop addon at ${resolution.addonPath} failed to load: ${error instanceof Error ? error.message : String(error)} — rebuild it: ${DESKTOP_BUILD_COMMAND}`,
    }
  }
  return loaded
}

export function resetDesktopAddonForTest(): void {
  loaded = null
}
