
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

const { builtinCommands, findCommand } = await import('../../src/commands/catalogue/commands.js')
const { effectiveCatalogue, normalSurfaces } = await import(
  '../../src/commands/catalogue/effectiveCatalogue.js'
)
const registry = builtinCommands()
const catalogue = effectiveCatalogue()
check('registry loads (the excised roster, >70 built-ins)', registry.length > 70, `${registry.length}; builtinCommands() in src/commands/catalogue/commands.ts returned too few commands, restore the dropped registrations there`)
check('catalogue rows = registry rows', catalogue.length === registry.length, `catalogue ${catalogue.length} vs registry ${registry.length}; effectiveCatalogue() in src/commands/catalogue/effectiveCatalogue.ts must return one row per builtinCommands() entry`)

{
  check('every route is a normal or a hidden route (no development-only class stands behind a flag)', catalogue.every(s => s.visibility === 'normal' || s.visibility === 'hidden'), catalogue.filter(s => s.visibility !== 'normal' && s.visibility !== 'hidden').map(s => s.name).join(', ') + ' (visibilityOf in src/commands/catalogue/effectiveCatalogue.ts may return only normal or hidden)')
  const normal = normalSurfaces()
  check('normalSurfaces() holds enabled normal routes only', normal.every(s => s.visibility === 'normal' && s.enabled), 'normalSurfaces() in src/commands/catalogue/effectiveCatalogue.ts must filter on enabled and visibility normal')
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
  check('no alias/name collisions across the registry', collision === null, `${collision ?? ''} (rename one of the two commands or drop the alias in its definition under src/commands)`)
  const badCanonical = catalogue.filter(
    s => s.canonicalRoute !== s.name && !catalogue.some(t => t.name === s.canonicalRoute),
  )
  check('every canonicalRoute resolves to a registered command', badCanonical.length === 0,
    badCanonical.map(s => `${s.name}→${s.canonicalRoute}`).join(', ') + ' (point the command canonicalRoute at a registered command name)')
  const memory = catalogue.find(s => s.name === 'memory')
  check("'chronicle' reaches the Memory Centre as a /memory alias", memory?.aliases.includes('chronicle') === true, 'add chronicle to the aliases of the memory command in src/commands')
}

{
  const uncurated = normalSurfaces().filter(s => s.category === 'other')
  check(
    'every normal surface maps to a curated /help domain (no “everything else”)',
    uncurated.length === 0,
    uncurated.map(s => s.name).join(', ') + ' (add each name to a domain in COMMAND_DOMAINS, src/screen/help/commandDomains.ts)',
  )
  const uncuratedGated = effectiveCatalogue().filter(
    s => s.visibility === 'normal' && s.category === 'other',
  )
  check(
    'gated-off normal rows are curated too (the enabling session finds them organized)',
    uncuratedGated.length === 0,
    uncuratedGated.map(s => s.name).join(', ') + ' (add each name to a domain in COMMAND_DOMAINS, src/screen/help/commandDomains.ts)',
  )
}


{
  const { isCommandEnabled } = await import('../../src/commands/catalogue/command.js')
  const { getIsInteractive, setIsInteractive } = await import('../../src/boot/process-state/processState.js')

  const BLESSED_PAIRS = ['context', 'goal'] as const

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
    `found: ${duplicateNames.join(', ') || '(none)'}; give each duplicate its own name in src/commands or update BLESSED_PAIRS here`,
  )

  const initialInteractive = getIsInteractive()
  try {
    for (const name of BLESSED_PAIRS) {
      const pair = byName.get(name) ?? []
      check(`/${name}: exactly two registrations`, pair.length === 2, `${pair.length}; builtinCommands() in src/commands/catalogue/commands.ts must register /${name} twice`)
      if (pair.length !== 2) continue

      setIsInteractive(true)
      const enabledInteractive = pair.filter(cmd => isCommandEnabled(cmd))
      setIsInteractive(false)
      const enabledHeadless = pair.filter(cmd => isCommandEnabled(cmd))

      check(
        `/${name}: exactly one enabled member per posture`,
        enabledInteractive.length === 1 && enabledHeadless.length === 1,
        `interactive=${enabledInteractive.length} nonInteractive=${enabledHeadless.length}; check isEnabled of both /${name} registrations (isCommandEnabled in src/commands/catalogue/command.ts)`,
      )
      check(
        `/${name}: the enabled member SWAPS with the posture (exact complement)`,
        enabledInteractive[0] !== undefined && enabledInteractive[0] !== enabledHeadless[0],
        `the two /${name} registrations must enable on opposite postures (check isEnabled in each)`,
      )
      setIsInteractive(true)
      check(
        `/${name}: the non-interactive member is hidden outside run`,
        enabledHeadless[0] !== undefined && enabledHeadless[0].isHidden === true,
        `set isHidden on the non-interactive /${name} registration`,
      )
    }

    const singles = [...byName.entries()].filter(
      ([name]) => !(BLESSED_PAIRS as readonly string[]).includes(name),
    )
    const overRegistered = singles.filter(([, list]) => list.length !== 1)
    check(
      'every non-pair name is registered exactly once',
      overRegistered.length === 0,
      overRegistered.map(([name, list]) => `${name}×${list.length}`).join(', ') + ' (remove the duplicate registration in builtinCommands, src/commands/catalogue/commands.ts)',
    )
    const mutableRegistry = [...registry]
    setIsInteractive(true)
    const interactiveCommands = mutableRegistry.filter(isCommandEnabled)
    const goalInteractive = findCommand('goal', interactiveCommands)
    const missionInteractive = findCommand('mission', interactiveCommands)
    setIsInteractive(false)
    const headlessCommands = mutableRegistry.filter(isCommandEnabled)
    const goalHeadless = findCommand('goal', headlessCommands)
    const missionHeadless = findCommand('mission', headlessCommands)
    const goalEntries = catalogue.filter(s => s.name === 'goal')
    check(
      '/goal resolves to the command in both interactive and headless catalogues with no alias, and /mission resolves to nothing',
      goalInteractive?.name === 'goal' &&
        goalHeadless?.name === 'goal' &&
        goalInteractive !== goalHeadless &&
        missionInteractive === undefined &&
        missionHeadless === undefined &&
        goalEntries.length === 2 &&
        goalEntries.every(s => s.aliases.length === 0) &&
        catalogue.every(s => s.name !== 'mission' && !s.aliases.includes('mission') && !s.aliases.includes('goal')),
      JSON.stringify({
        goalInteractive: goalInteractive?.name,
        goalHeadless: goalHeadless?.name,
        missionInteractive: missionInteractive?.name,
        missionHeadless: missionHeadless?.name,
        goalAliases: goalEntries.map(s => s.aliases),
      }),
    )
  } finally {
    setIsInteractive(initialInteractive)
  }
}

{
  const { DEFAULT_BINDINGS } = await import('../../src/screen/keys/defaultBindings.js')
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
    `${commandActions.length}; DEFAULT_BINDINGS in src/screen/keys/defaultBindings.ts holds no command: actions`)
  const orphans = commandActions.filter(name => !known.has(name))
  check(
    'every command:<name> default binding resolves to a registered name/alias',
    orphans.length === 0,
    orphans.join(', ') + ' (fix the command: action in src/screen/keys/defaultBindings.ts or register the command)',
  )
}

rmSync(scratchHome, { recursive: true, force: true })

if (failures > 0) {
  console.error(`\nprove-effective-catalogue: RED (${failures})`)
  process.exit(1)
}
console.log('\nprove-effective-catalogue: green')
process.exit(0)
