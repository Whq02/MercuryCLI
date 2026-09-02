// prove-effective-catalogue — the §5 drift prover (gate member).
//
// ONE effective surface catalogue at the command-registry seam, with every
// projection derived from it. Laws:
//
//   1. REGISTRY loads and the catalogue derives (in-process, source mode).
//   2. devOnly ↔ gate pairing: every devOnly command is DISABLED unless the
//      ONE development boundary (MERCURY_DEV_SURFACES=1) arms it — and armed,
//      it enables. A devOnly route can never sit in normal discovery.
//   3. Alias integrity: no alias collides with another command's name or
//      alias; canonicalRoute always resolves to a registered command.
//   4. Category curation: every NORMAL built-in surface maps to a curated
//      /help domain (never the 'everything else' bucket) — the browse
//      projections stay organized by construction.
//   5. THE ZERO-SPECIMEN LAW: no normally discoverable route's view sources
//      carry specimen markers — `<CommandCenter specimen`, a SpecimenGallery
//      mount, `illustrative` fixed-data banners, or `would …` dead-end action
//      notes. (Dev-only routes are exempt — that is what the boundary is for.)
//   6. The curated hand-state duplicates are ABSENT (commandsSnapshot ·
//      designCoverageSnapshot · rosterSnapshot) and the projection seams
//      filter hidden commands (HelpV2 · PaletteView · typeahead).
//   7. /manager derives from the catalogue (no hand surface arrays).
//   8. ONE ENABLED OWNER PER NAME PER SESSION MODE (the duplicate-
//      registration census): a name may appear twice in the registry ONLY
//      as a blessed interactive/non-interactive pair — exactly two entries,
//      exactly one enabled in each posture, the enabled member swapping
//      with the posture, the non-interactive member hidden outside -p.
//      The blessed-pair list is closed: a new duplicate name (complementary
//      or not) is red until it is added here deliberately.
//   9. Every `command:<name>` action in the default keybindings resolves to
//      a registered command name or alias (the input atlas can never
//      advertise a chord that runs a command the registry does not know).
//
// The BUILT-artifact twin of these checks is prove-beta-journey-matrix.ts
// (reads REGISTRY truth from dist via MERCURY_SURFACE_DUMP).

// Fork-sim BEFORE any import that folds off MACRO.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const repo = path.resolve(import.meta.dir, '../..')

// Hermetic home + source-run pins.
const scratchHome = mkdtempSync(path.join(tmpdir(), 'mercury-verity-cat-'))
process.env.MERCURY_CONFIG_DIR = scratchHome
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_DEV_SURFACES
// The registry build reaches login()'s auth probe; the hermetic home has no
// keychain/oauth, so a placeholder key keeps the SHAPE derivation running.
// (Registry shape only — nothing here renders account-gated chrome, the
// class the fake-key caveat in render-tui warns about.)
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

// ── 1. the registry + catalogue load in-process ────────────────────────────
const { builtinCommands } = await import('../../src/commands.js')
const { effectiveCatalogue, normalSurfaces } = await import(
  '../../src/commands/effectiveCatalogue.js'
)
const registry = builtinCommands()
const catalogue = effectiveCatalogue()
check('registry loads (>100 built-ins)', registry.length > 100, String(registry.length))
check('catalogue rows = registry rows', catalogue.length === registry.length)

// ── 2. devOnly ↔ gate pairing ──────────────────────────────────────────────
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

// ── 3. alias integrity + canonicalRoute resolution ─────────────────────────
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
  // The two consolidations hold.
  const multiplayer = catalogue.find(s => s.name === 'multiplayer')
  const memory = catalogue.find(s => s.name === 'memory')
  check("'rooms' reaches the live board as a /multiplayer alias", multiplayer?.aliases.includes('rooms') === true)
  check("'chronicle' reaches the Memory Centre as a /memory alias", memory?.aliases.includes('chronicle') === true)
}

// ── 4. category curation for normal surfaces ───────────────────────────────
{
  const uncurated = normalSurfaces().filter(s => s.category === 'other')
  check(
    'every normal surface maps to a curated /help domain (no “everything else”)',
    uncurated.length === 0,
    uncurated.map(s => s.name).join(', '),
  )
  // The gated-off rows too: a normal-VISIBILITY command whose gate is off in
  // this posture (a team seat, a mode gate) still needs its curated domain —
  // the session that enables it must find it organized, never in the bucket.
  const uncuratedGated = effectiveCatalogue().filter(
    s => s.visibility === 'normal' && s.category === 'other',
  )
  check(
    'gated-off normal rows are curated too (the enabling session finds them organized)',
    uncuratedGated.length === 0,
    uncuratedGated.map(s => s.name).join(', '),
  )
}

// ── 5. THE ZERO-SPECIMEN LAW over normal routes' view sources ──────────────
{
  // The census walk: a command unit's files + 1-hop relative imports.
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

  // Locate each normal command's source unit by scanning src/commands/* for
  // its `name:` declaration (units are the registry's own layout).
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
    if (!unit) continue // dynamic/alias-only names have no own unit
    const seen = new Set<string>()
    const files = unitFiles(unit)
    for (const f of [...files, ...files.flatMap(oneHop)]) {
      if (seen.has(f)) continue
      seen.add(f)
      // Strip comments before scanning — tombstone/history comments naming a
      // deleted specimen must never trip the law (only LIVE strings/JSX can).
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

// ── 6. hand-state duplicates gone + projection seams filter hidden ─────────
{
  for (const dead of [
    'src/utils/cockpit/commandsSnapshot.ts',
    'src/utils/cockpit/designCoverageSnapshot.ts',
    'src/utils/cockpit/rosterSnapshot.ts',
  ]) {
    check(`${dead} is deleted`, !existsSync(path.join(repo, dead)))
  }
  const helpV2 = readFileSync(path.join(repo, 'src/components/HelpV2/HelpV2.tsx'), 'utf8')
  // Spelling-agnostic: the filter's parameter name is not the contract.
  check('HelpV2 filters isHidden', /\.filter\(\s*(\w+)\s*=>\s*!\1\.isHidden\)/.test(helpV2))
  const palette = readFileSync(path.join(repo, 'src/components/mercury-ui/PaletteView.tsx'), 'utf8')
  check('PaletteView filters isHidden', /!cmd\.isHidden/.test(palette))
  const typeahead = readFileSync(path.join(repo, 'src/utils/suggestions/commandSuggestions.ts'), 'utf8')
  check('typeahead filters isHidden', /!cmd\.isHidden/.test(typeahead))
}

// ── 7. /manager derives from the catalogue ─────────────────────────────────
{
  const mgr = readFileSync(path.join(repo, 'src/components/mercury-ui/ManagerView.tsx'), 'utf8')
  check('/manager projects groupedNormalSurfaces()', /groupedNormalSurfaces\(\)/.test(mgr))
  check('/manager has no hand-written surface array', !/buildSections|Component:\s/.test(mgr))
}

// ── 8. one enabled owner per name per session mode (duplicate census) ──────
{
  const { isCommandEnabled } = await import('../../src/types/command.js')
  const { getIsInteractive, setIsInteractive } = await import('../../src/bootstrap/state.js')

  // The closed blessed-pair list: the ONLY names allowed two registrations,
  // each an interactive/non-interactive pair. Growing this list is a
  // deliberate act, reviewed with the pair's two gates in hand.
  // ('invite' left the list with the multiplayer removal: its live
  // interactive half retired into the one commands/retired.ts door, so the
  // name registers exactly once now — run 2 measured the shrunk set.)
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
      // The hidden asymmetry: in an interactive session the -p member hides
      // from listings; the interactive member relies on being disabled.
      setIsInteractive(true)
      check(
        `/${name}: the non-interactive member is hidden outside -p`,
        enabledHeadless[0] !== undefined && enabledHeadless[0].isHidden === true,
      )
    }

    // Every other name: exactly one registration (no same-mode shadowing
    // anywhere in the built-in registry, ever).
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

// ── 9. atlas command bindings resolve to registered commands ───────────────
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
