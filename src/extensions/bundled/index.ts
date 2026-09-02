import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type BundledExtensionDefinition = {
  name: string
  root: string
  defaultOn: boolean
  isAvailable?: () => boolean
}

const SHIPPED: BundledExtensionDefinition[] = []

export function bundledRoster(): BundledExtensionDefinition[] {
  const roster = [...SHIPPED]
  const fixture = process.env.MERCURY_EXTENSIONS_BUNDLED_FIXTURE
  if (fixture && fixture.trim() !== '' && existsSync(fixture)) {
    for (const entry of readdirSync(fixture).sort()) {
      const root = join(fixture, entry)
      try {
        if (!statSync(root).isDirectory()) continue
      } catch {
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
        } catch {
        }
      }
      roster.push({ name: entry, root, defaultOn, isAvailable: () => available })
    }
  }
  return roster.filter(def => def.isAvailable === undefined || def.isAvailable())
}
