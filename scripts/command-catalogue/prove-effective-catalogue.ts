
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'


const scratchHome = mkdtempSync(path.join(tmpdir(), 'mercury-verity-cat-'))
process.env.MERCURY_CONFIG_DIR = scratchHome
process.env.NODE_ENV = 'test'
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'sk-ant-verity-shape-probe'

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('prove-effective-catalogue — the ONE surface catalogue + the zero-specimen law')

const { builtinCommands } = await import('../../src/commands.js')
const { effectiveCatalogue, normalSurfaces } = await import(
  '../../src/commands/effectiveCatalogue.js'
)
const registry = builtinCommands()
const catalogue = effectiveCatalogue()
check('registry loads (the excised roster, >70 built-ins)', registry.length > 70, String(registry.length))
check('catalogue rows = registry rows', catalogue.length === registry.length)

{
  check('every route is a normal or a hidden route (no development-only class stands behind a flag)', catalogue.every(s => s.visibility === 'normal' || s.visibility === 'hidden'), catalogue.filter(s => s.visibility !== 'normal' && s.visibility !== 'hidden').map(s => s.name).join(', '))
  const normal = normalSurfaces()
  check('normalSurfaces() holds enabled normal routes only', normal.every(s => s.visibility === 'normal' && s.enabled))
}

{
  const names = new Map<string, string>()
  let collision: string | null = null
  for (const s of catalogue) {
    for (const n of [s.name, ...s.aliases]) {
      const prior = names.get(n)
      if (prior && prior !== s.name) collision = `${n} (${prior} vs ${s.name})`
      names.set(n, s.name)
    }
  }
  check('no alias/name collisions across the registry', collision === null, collision ?? '')
  const badCanonical = catalogue.filter(
    s => s.canonicalRoute !== s.name && !catalogue.some(t => t.name === s.canonicalRoute),
  )
  check('every canonicalRoute resolves to a registered command', badCanonical.length === 0,
    badCanonical.map(s => `${s.name}→${s.canonicalRoute}`).join(', '))
  const memory = catalogue.find(s => s.name === 'memory')
  check("'chronicle' reaches the Memory Centre as a /memory alias", memory?.aliases.includes('chronicle') === true)
}

{
  const uncurated = normalSurfaces().filter(s => s.category === 'other')
  check(
    'every normal surface maps to a curated /help domain (no “everything else”)',
    uncurated.length === 0,
    uncurated.map(s => s.name).join(', '),
  )
  const uncuratedGated = effectiveCatalogue().filter(
    s => s.visibility === 'normal' && s.category === 'other',
  )
  check(
    'gated-off normal rows are curated too (the enabling session finds them organized)',
    uncuratedGated.length === 0,
    uncuratedGated.map(s => s.name).join(', '),
  )
}


{
  const { isCommandEnabled } = await import('../../src/types/command.js')
  const { getIsInteractive, setIsInteractive } = await import('../../src/bootstrap/state.js')

  const BLESSED_PAIRS = ['context', 'mission'] as const

  const byName = new Map<string, typeof registry[number][]>()
  for (const cmd of registry) {
    const list = byName.get(cmd.name) ?? []
    list.push(cmd)
    byName.set(cmd.name, list)
  }

  const duplicateNames = [...byName.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([name]) => name)
    .sort()
  check(
    'the duplicate-name set equals the blessed pairs exactly',
    duplicateNames.join(',') === [...BLESSED_PAIRS].sort().join(','),
    `found: ${duplicateNames.join(', ') || '(none)'}`,
  )

  const initialInteractive = getIsInteractive()
  try {
    for (const name of BLESSED_PAIRS) {
      const pair = byName.get(name) ?? []
      check(`/${name}: exactly two registrations`, pair.length === 2, String(pair.length))
      if (pair.length !== 2) continue

      setIsInteractive(true)
      const enabledInteractive = pair.filter(cmd => isCommandEnabled(cmd))
      setIsInteractive(false)
      const enabledHeadless = pair.filter(cmd => isCommandEnabled(cmd))

      check(
        `/${name}: exactly one enabled member per posture`,
        enabledInteractive.length === 1 && enabledHeadless.length === 1,
        `interactive=${enabledInteractive.length} nonInteractive=${enabledHeadless.length}`,
      )
      check(
        `/${name}: the enabled member SWAPS with the posture (exact complement)`,
        enabledInteractive[0] !== undefined && enabledInteractive[0] !== enabledHeadless[0],
      )
      setIsInteractive(true)
      check(
        `/${name}: the non-interactive member is hidden outside run`,
        enabledHeadless[0] !== undefined && enabledHeadless[0].isHidden === true,
      )
    }

    const singles = [...byName.entries()].filter(
      ([name]) => !(BLESSED_PAIRS as readonly string[]).includes(name),
    )
    const overRegistered = singles.filter(([, list]) => list.length !== 1)
    check(
      'every non-pair name is registered exactly once',
      overRegistered.length === 0,
      overRegistered.map(([name, list]) => `${name}×${list.length}`).join(', '),
    )
  } finally {
    setIsInteractive(initialInteractive)
  }
}

{
  const { DEFAULT_BINDINGS } = await import('../../src/keybindings/defaultBindings.js')
  const known = new Set<string>()
  for (const cmd of registry) {
    known.add(cmd.name)
    for (const alias of cmd.aliases ?? []) known.add(alias)
  }
  const commandActions: string[] = []
  for (const block of DEFAULT_BINDINGS) {
    for (const action of Object.values(block.bindings)) {
      if (typeof action === 'string' && action.startsWith('command:')) {
        commandActions.push(action.slice('command:'.length))
      }
    }
  }
  check('the default bindings carry command actions to resolve', commandActions.length > 0,
    String(commandActions.length))
  const orphans = commandActions.filter(name => !known.has(name))
  check(
    'every command:<name> default binding resolves to a registered name/alias',
    orphans.length === 0,
    orphans.join(', '),
  )
}

rmSync(scratchHome, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\nprove-effective-catalogue: RED (${failures})`)
  process.exit(1)
}
console.log('\nprove-effective-catalogue: green')
process.exit(0)
