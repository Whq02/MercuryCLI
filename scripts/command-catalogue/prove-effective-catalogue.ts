
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const repo = path.resolve(import.meta.dir, '../..')

const scratchHome = mkdtempSync(path.join(tmpdir(), 'mercury-verity-cat-'))
process.env.MERCURY_CONFIG_DIR = scratchHome
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_DEV_SURFACES
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
check('registry loads (>100 built-ins)', registry.length > 100, String(registry.length))
check('catalogue rows = registry rows', catalogue.length === registry.length)

{
  const devRows = catalogue.filter(s => s.visibility === 'dev')
  check('at least one dev fixture route exists (/showcase)', devRows.some(s => s.name === 'showcase'))
  const enabledUnarmed = devRows.filter(s => s.enabled)
  check(
    'unarmed: every devOnly route is DISABLED (absent from the roster)',
    enabledUnarmed.length === 0,
    enabledUnarmed.map(s => s.name).join(', '),
  )
  process.env.MERCURY_DEV_SURFACES = '1'
  const armed = effectiveCatalogue().filter(s => s.visibility === 'dev')
  check(
    'armed (MERCURY_DEV_SURFACES=1): the dev routes enable (live gate re-read)',
    armed.length > 0 && armed.every(s => s.enabled),
    armed.map(s => `${s.name}:${s.enabled}`).join(', '),
  )
  delete process.env.MERCURY_DEV_SURFACES
  const normal = normalSurfaces()
  check('normalSurfaces() never contains a dev route', normal.every(s => s.visibility === 'normal'))
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
  const multiplayer = catalogue.find(s => s.name === 'multiplayer')
  const memory = catalogue.find(s => s.name === 'memory')
  check("'rooms' reaches the live board as a /multiplayer alias", multiplayer?.aliases.includes('rooms') === true)
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
  function unitFiles(unit: string): string[] {
    const p = path.join(repo, unit)
    if (!existsSync(p)) return []
    if (statSync(p).isFile()) return [unit]
    const out: string[] = []
    const walk = (d: string): void => {
      for (const n of readdirSync(d).sort()) {
        const fp = path.join(d, n)
        if (statSync(fp).isDirectory()) walk(fp)
        else if (/\.(ts|tsx)$/.test(n) && !/\.test\./.test(n)) out.push(path.relative(repo, fp))
      }
    }
    walk(p)
    return out
  }
  function oneHop(file: string): string[] {
    const src = readFileSync(path.join(repo, file), 'utf8')
    const out: string[] = []
    for (const m of src.matchAll(/from '((?:\.\.?\/)[^']+)'/g)) {
      const raw = m[1]!.replace(/\.js$/, '')
      const base = path.normalize(path.join(path.dirname(file), raw))
      for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
        if (cand.startsWith('src/') && existsSync(path.join(repo, cand))) {
          out.push(cand)
          break
        }
      }
    }
    return out
  }

  const unitByName = new Map<string, string>()
  for (const entry of readdirSync(path.join(repo, 'src/commands')).sort()) {
    const unit = `src/commands/${entry}`
    const files = unitFiles(unit)
    const def = files.find(f => /(?:^|\/)index\.tsx?$/.test(f)) ?? files[0]
    if (!def) continue
    const src = readFileSync(path.join(repo, def), 'utf8')
    const name = src.match(/\bname:\s*'([^']+)'/)?.[1]
    if (name && !unitByName.has(name)) unitByName.set(name, unit)
  }

  const MARKERS: Array<[string, RegExp]> = [
    ['specimen CommandCenter', /<CommandCenter\s+specimen/],
    ['SpecimenGallery mount', /<SpecimenGallery/],
    ['illustrative fixed-data banner', /illustrative/i],
    ['dead-end “would …” action note', /return\s+[`'"](?:gated · |unavailable · )?would /],
    ['not-a-live-tally banner', /NOT a live/],
  ]

  const offenders: string[] = []
  for (const s of catalogue.filter(r => r.visibility === 'normal')) {
    const unit = unitByName.get(s.name)
    if (!unit) continue
    const seen = new Set<string>()
    const files = unitFiles(unit)
    for (const f of [...files, ...files.flatMap(oneHop)]) {
      if (seen.has(f)) continue
      seen.add(f)
      const src = readFileSync(path.join(repo, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
      for (const [label, re] of MARKERS) {
        if (re.test(src)) offenders.push(`/${s.name} → ${f}: ${label}`)
      }
    }
  }
  check('ZERO specimen markers in any normal route’s view sources', offenders.length === 0,
    offenders.slice(0, 8).join(' | '))
}

{
  for (const dead of [
    'src/utils/cockpit/commandsSnapshot.ts',
    'src/utils/cockpit/designCoverageSnapshot.ts',
    'src/utils/cockpit/rosterSnapshot.ts',
  ]) {
    check(`${dead} is deleted`, !existsSync(path.join(repo, dead)))
  }
  const helpV2 = readFileSync(path.join(repo, 'src/components/HelpV2/HelpV2.tsx'), 'utf8')
  check('HelpV2 filters isHidden', /\.filter\(\s*(\w+)\s*=>\s*!\1\.isHidden\)/.test(helpV2))
  const palette = readFileSync(path.join(repo, 'src/components/mercury-ui/PaletteView.tsx'), 'utf8')
  check('PaletteView filters isHidden', /!cmd\.isHidden/.test(palette))
  const typeahead = readFileSync(path.join(repo, 'src/utils/suggestions/commandSuggestions.ts'), 'utf8')
  check('typeahead filters isHidden', /!cmd\.isHidden/.test(typeahead))
}

{
  const mgr = readFileSync(path.join(repo, 'src/components/mercury-ui/ManagerView.tsx'), 'utf8')
  check('/manager projects groupedNormalSurfaces()', /groupedNormalSurfaces\(\)/.test(mgr))
  check('/manager has no hand-written surface array', !/buildSections|Component:\s/.test(mgr))
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
        `/${name}: the non-interactive member is hidden outside -p`,
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
