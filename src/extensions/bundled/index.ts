// ============================================================================
//  src/extensions/bundled/index.ts — the bundled roster.
//
//  A bundled extension is a folder Mercury ships inside its own build, with
//  the same `mercury-extension.json` any maker writes; only where it lives
//  and who approved it differ (installing Mercury is the approval). The
//  default switch and the availability predicate ride HERE, beside the
//  folder, never in the manifest.
//
//  The shipped roster is EMPTY. The mechanism is proven with a fixture that
//  exists only in the proof suite: the test-only input
//  MERCURY_EXTENSIONS_BUNDLED_FIXTURE names a folder of extension folders,
//  each becoming `<name>@mercury` exactly as a shipped one would. A shipped
//  bundled extension is added to SHIPPED below with its folder embedded by
//  the build and extracted under <config home>/extensions/bundled/<name>/
//  <mercury version>/ on first use.
// ============================================================================
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export type BundledExtensionDefinition = {
  name: string
  /** The folder holding mercury-extension.json. */
  root: string
  /** The switch a fresh home starts with. */
  defaultOn: boolean
  /** When it answers false the extension is omitted from the roster entirely — no row, no ghost. */
  isAvailable?: () => boolean
}

/** Mercury ships no bundled extension in this round (the operator's ruling). */
const SHIPPED: BundledExtensionDefinition[] = []

/** The bundled roster: the shipped list plus the proof suite's fixture folder when named. */
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
      // The fixture folder's own defaults file names the switch and the
      // availability answer, so the provers can drive both.
      let defaultOn = true
      let available = true
      const defaults = join(root, '.bundled-defaults.json')
      if (existsSync(defaults)) {
        try {
          const parsed = JSON.parse(readFileSync(defaults, 'utf8')) as { defaultOn?: boolean; available?: boolean }
          if (parsed.defaultOn === false) defaultOn = false
          if (parsed.available === false) available = false
        } catch {
          // an unreadable defaults file means the defaults
        }
      }
      roster.push({ name: entry, root, defaultOn, isAvailable: () => available })
    }
  }
  return roster.filter(def => def.isAvailable === undefined || def.isAvailable())
}
