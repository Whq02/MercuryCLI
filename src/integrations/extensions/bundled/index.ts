import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { flagEnv } from '../../../platform/substrate/flagRegistry.js'
import { getBundledDir } from '../paths.js'
import { MERCURY_VERSION } from '../../../platform/product/product.js'
import { bundledMetadata, bundledPayloads } from './content.generated.js'
import { passedOver } from '../../../platform/errors/passedOver.js'
import { vendorPlatformTag } from '../../../platform/host-os/programs.js'

type BundledExtensionDefinition = {
  name: string
  root: string
  defaultOn: boolean
  isAvailable?: () => boolean
  metadata?: (typeof bundledMetadata)[string]
  materialize?: () => string
}

type BundledPayload = string | { base64: string; executable: boolean }
const payloadBytes = (value: BundledPayload): Buffer => typeof value === 'string' ? Buffer.from(value) : Buffer.from(value.base64, 'base64')

function materialize(name: string, files: Record<string, BundledPayload>): string {
  const root = payloadRoot(name)
  const verify = (): void => {
    for (const [path, value] of Object.entries(files)) if (!readFileSync(join(root, path)).equals(payloadBytes(value))) throw new Error(`Bundled extension file changed: ${name}/${path}`)
  }
  if (existsSync(root)) { verify(); return root }
  const stage = `${root}.stage-${randomUUID()}`
  try {
    for (const [path, text] of Object.entries(files)) {
      const target = join(stage, path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, payloadBytes(text), { flag: 'wx', mode: typeof text !== 'string' && text.executable ? 0o755 : 0o644 })
    }
    try { renameSync(stage, root) } catch (error) { if (!existsSync(root)) throw error }
    verify()
    return root
  } finally { rmSync(stage, { recursive: true, force: true }) }
}

function payloadRoot(name: string): string {
  return join(getBundledDir(), name, `${MERCURY_VERSION}-${bundledMetadata[name]!.digest}`)
}

function shipped(): BundledExtensionDefinition[] {
  return Object.entries(bundledPayloads).map(([name, files]) => ({ name, root: payloadRoot(name), defaultOn: name !== 'mercury-media', metadata: bundledMetadata[name], materialize: () => materialize(name, files) }))
}

function craftPlatform(): string {
  const pinned = flagEnv('MERCURY_CRAFT_PLATFORM')?.trim()
  if (pinned) return pinned
  return vendorPlatformTag()
}

export function bundledReleaseMissingFor(root: string, name: string): string | null {
  const lock = join(root, 'server', `${name}.lock.json`)
  if (!existsSync(lock)) return null
  let platforms: Record<string, unknown> | undefined
  try {
    platforms = (JSON.parse(readFileSync(lock, 'utf8')) as { platforms?: Record<string, unknown> }).platforms
  } catch (error) {
    passedOver(error)
    return null
  }
  const platform = craftPlatform()
  return platforms?.[platform] !== undefined ? null : platform
}

export function bundledRoster(): BundledExtensionDefinition[] {
  const roster = shipped()
  const fixture = flagEnv('MERCURY_EXTENSIONS_BUNDLED_FIXTURE')
  if (fixture && fixture.trim() !== '' && existsSync(fixture)) {
    for (const entry of readdirSync(fixture).sort()) {
      const root = join(fixture, entry)
      try {
        if (!statSync(root).isDirectory()) continue
      } catch (error) {
        passedOver(error)
        continue
      }
      if (!existsSync(join(root, 'mercury-extension.json'))) continue
      let defaultOn = true
      let available = true
      const defaults = join(root, '.bundled-defaults.json')
      if (existsSync(defaults)) {
        try {
          const parsed = JSON.parse(readFileSync(defaults, 'utf8')) as { defaultOn?: boolean; available?: boolean }
          if (parsed.defaultOn === false) defaultOn = false
          if (parsed.available === false) available = false
        } catch (error) {
          passedOver(error)
        }
      }
      roster.push({ name: entry, root, defaultOn, isAvailable: () => available })
    }
  }
  return roster.filter(def => def.isAvailable === undefined || def.isAvailable())
}
