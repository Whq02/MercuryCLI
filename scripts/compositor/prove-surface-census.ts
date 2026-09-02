#!/usr/bin/env bun
// ============================================================================
//  scripts/compositor/prove-surface-census.ts — the
//  GENERATED surface census, from live routes.
//
//  Not a hand list and not a second routing system: the rows are DERIVED
//  from the estate's real route sources —
//    · slash routes: every command unit under src/commands/** (name + type
//      extracted from the definition source; local-jsx = a modal-slot view,
//      local = a transcript print, prompt = a model turn), joined to the
//      interaction-kernel signals its view files actually carry (the same
//      regex vocabulary as scripts/interaction/prove-interaction-coverage.ts
//      — that prover owns CLASSIFICATION; this census records the join);
//    · boot surfaces: the pre-REPL launchers (dialogLaunchers.tsx exports +
//      the interactive-helpers dialog family + ResumeConversation + the
//      REPL), each with its HOLD DISCIPLINE — the law that every boot
//      surface either CLAIMS the held screen (<AlternateScreen>) or
//      RELEASES the hold before painting inline;
//    · estate invariants recorded ONCE (they are laws, not per-row facts):
//      background ownership (the S1 canvas model), motion (the 80⊂160⊂320
//      lattice), identity (interaction law 5b), size (computeChromeMode).
//
//  Bare run: regenerate in memory, DIFF against the committed census (drift
//  ⇒ RED with the exact delta) + enforce the boot-discipline law.
//  --write: regenerate the committed file.
// ============================================================================
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')
const OUT = path.join(ROOT, 'scripts/compositor/fixtures/surface-census.md')
const WRITE = process.argv.includes('--write')

let fail = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) fail = 1
}

// ── the kernel-signal vocabulary (mirrors prove-interaction-coverage) ───────
const SIGNALS: Array<[string, RegExp]> = [
  ['panes', /<NavigablePanes/],
  ['irow', /<InteractiveRow/],
  ['ilist', /useInteractiveList\(/],
  ['flat', /useFlatList\(/],
  ['disclosure', /<InteractiveDisclosure/],
]

function signalsOf(src: string): string[] {
  return SIGNALS.filter(([, re]) => re.test(src)).map(([n]) => n)
}

// ── slash routes: every command unit under src/commands/** ─────────────────
type Route = { name: string; type: string; unit: string; signals: string[] }

function unitFiles(unit: string): string[] {
  const p = path.join(ROOT, unit)
  if (statSync(p).isFile()) return [unit]
  const out: string[] = []
  // readdir order is FILESYSTEM order — sorted so the census (and its
  // files[0] definition fallback) is byte-stable across machines/CI.
  const walk = (d: string): void => {
    for (const n of readdirSync(d).sort()) {
      const fp = path.join(d, n)
      if (statSync(fp).isDirectory()) walk(fp)
      else if (/\.(ts|tsx)$/.test(n) && !/\.test\./.test(n)) out.push(path.relative(ROOT, fp))
    }
  }
  walk(p)
  return out
}

/** 1-hop relative imports inside src/ — enough to reach a unit's view files
 *  that live beside src/components (deeper joins belong to the interaction
 *  prover, which is estate-closed by construction). */
function oneHopImports(file: string): string[] {
  const src = readFileSync(path.join(ROOT, file), 'utf8')
  const out: string[] = []
  for (const m of src.matchAll(/from '((?:\.\.?\/)[^']+)'/g)) {
    const raw = m[1]!.replace(/\.js$/, '')
    const base = path.normalize(path.join(path.dirname(file), raw))
    for (const cand of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
      if (cand.startsWith('src/') && existsSync(path.join(ROOT, cand))) {
        out.push(cand)
        break
      }
    }
  }
  return out
}

function collectRoutes(): Route[] {
  const routes: Route[] = []
  const dir = path.join(ROOT, 'src/commands')
  for (const entry of readdirSync(dir).sort()) {
    const unit = `src/commands/${entry}`
    const files = unitFiles(unit)
    const defFile = files.find(f => /(?:^|\/)index\.tsx?$/.test(f)) ?? files[0]
    if (!defFile) continue
    const defSrc = readFileSync(path.join(ROOT, defFile), 'utf8')
    const name = defSrc.match(/\bname:\s*'([^']+)'/)?.[1]
    const type = defSrc.match(/\btype:\s*'([^']+)'/)?.[1]
    if (!name || !type) continue // helper module, not a route definition
    const sigSet = new Set<string>()
    const seen = new Set<string>()
    for (const f of [...files, ...files.flatMap(oneHopImports)]) {
      if (seen.has(f)) continue
      seen.add(f)
      for (const s of signalsOf(readFileSync(path.join(ROOT, f), 'utf8'))) sigSet.add(s)
    }
    routes.push({ name, type, unit, signals: [...sigSet].sort() })
  }
  // Codepoint compare, not localeCompare — ICU collation is locale/build
  // dependent and the census must be byte-stable everywhere.
  return routes.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

// ── boot surfaces + the S2 hold-discipline law (source-anchored) ────────────
type BootRow = { surface: string; source: string; discipline: string; ok: boolean }

function collectBoot(): BootRow[] {
  const rows: BootRow[] = []
  const read = (f: string): string => readFileSync(path.join(ROOT, f), 'utf8')

  const helpers = read('src/interactiveHelpers.tsx')
  const hostBody = helpers.slice(helpers.indexOf('export function SetupScreenHost'))
  rows.push({
    surface: 'setup dialogs (showDialog family — onboarding · trust · policy · api-key · teleport · invalid-settings)',
    source: 'src/interactiveHelpers.tsx',
    discipline:
      'claims the held screen (SetupScreenHost stations under hold/fullscreen policy; bare inline only when the operator chose inline)',
    ok:
      /launcherAltHoldPending\(\)/.test(hostBody.slice(0, 1200)) &&
      /<AlternateScreen/.test(hostBody.slice(0, 1200)) &&
      /<SetupScreenHost>/.test(helpers),
  })
  const exitBody = helpers.slice(helpers.indexOf('export async function exitWithMessage'))
  rows.push({
    surface: 'exit/error messages (exitWithMessage/exitWithError)',
    source: 'src/interactiveHelpers.tsx',
    discipline: 'releases the hold before inline render',
    ok: /releaseLauncherAltHoldNow\(\)/.test(exitBody.slice(0, 900)),
  })

  const resume = read('src/screens/ResumeConversation.tsx')
  rows.push({
    surface: 'Resume Session picker (bare --resume: loading · picker · resuming · REPL swap)',
    source: 'src/screens/ResumeConversation.tsx',
    discipline: 'claims the held screen (<AlternateScreen> host; REPL swap rides the nested path)',
    ok: /launcherAltHoldPending\(\)/.test(resume) && /<AlternateScreen/.test(resume),
  })

  const alt = read('src/ink/components/AlternateScreen.tsx')
  rows.push({
    surface: 'REPL cockpit (direct boot / --continue / --resume <id>)',
    source: 'src/screens/REPL.tsx → src/ink/components/AlternateScreen.tsx',
    discipline: 'claims the held screen (outermost mount consumes + arms the takeover erase)',
    ok: /consumeLauncherAltHold\(\)/.test(alt) && /armAltScreenTakeover\(\)/.test(alt),
  })

  const cli = read('src/entrypoints/cli.tsx')
  rows.push({
    surface: 'non-takeover argv paths (-p · --help · subcommands · piped stdout)',
    source: 'src/entrypoints/cli.tsx',
    discipline: 'releases the hold before any output',
    ok: /releaseLauncherAltHoldNow/.test(cli),
  })

  return rows
}

// ── generation ──────────────────────────────────────────────────────────────
function generate(): string {
  const routes = collectRoutes()
  const boot = collectBoot()
  const jsx = routes.filter(r => r.type === 'local-jsx')
  const local = routes.filter(r => r.type === 'local')
  const prompt = routes.filter(r => r.type === 'prompt')
  const other = routes.filter(r => !['local-jsx', 'local', 'prompt'].includes(r.type))

  const lines: string[] = []
  lines.push('# compositor surface census — GENERATED (scripts/compositor/prove-surface-census.ts)')
  lines.push('')
  lines.push('> Regenerate: `bun run scripts/compositor/prove-surface-census.ts --write`.')
  lines.push('> The bare prover run DIFFS this file against the live tree — drift is RED.')
  lines.push('> Rows derive from live route sources; this is a census, never a router.')
  lines.push('')
  lines.push('## Estate invariants (laws, recorded once — the per-row columns they replace)')
  lines.push('')
  lines.push('- **Background owner** — the S1 canvas model (`docs/TERMINAL-RUNTIME.md`')
  lines.push('  the compositor): the epoch erase owns physical blankness in every claimed')
  lines.push('  viewport; the OSC 11 ground rides ONE lifecycle owner (`oasisBg.ts`);')
  lines.push('  repaired/vacated rectangles resolve to the effective ground')
  lines.push('  (`prove-fill-law`).')
  lines.push('- **Focus/selection identity** — kernel-owned (`useInteractiveList` /')
  lines.push('  `NavigablePanes` / `useStableSelection`; helmFocus is sig-anchored);')
  lines.push('  position-derived hover/hit ids are gate-RED (interaction law 5b).')
  lines.push('- **Motion owner** — the ONE 80⊂160⊂320 clock lattice')
  lines.push('  (`utils/cockpit/liveGlyphs.ts`); no surface-local timers.')
  lines.push('- **Terminal-size behavior** — `computeChromeMode(columns, rows)` sheds')
  lines.push('  cockpit→deck→inline; rails gate on `railPlan` (center ≥78).')
  lines.push('')
  lines.push('## Boot surfaces — the S2 hold discipline (every row mechanically anchored)')
  lines.push('')
  lines.push('| surface | source | hold discipline |')
  lines.push('|---|---|---|')
  for (const b of boot) lines.push(`| ${b.surface} | \`${b.source}\` | ${b.discipline} |`)
  lines.push('')
  lines.push(`## Slash routes — modal-slot views (local-jsx: ${jsx.length})`)
  lines.push('')
  lines.push('Host: the FullscreenLayout modal slot (opaque claim; SURFACE-CLAIM')
  lines.push('INVARIANT forces height = terminalRows at peek 0). Kernel signals name')
  lines.push('the interaction primitives the view actually mounts (1-hop join).')
  lines.push('')
  lines.push('| route | kernel signals | unit |')
  lines.push('|---|---|---|')
  for (const r of jsx) lines.push(`| /${r.name} | ${r.signals.join(' ') || '—'} | \`${r.unit}\` |`)
  lines.push('')
  lines.push(`## Slash routes — transcript prints (local: ${local.length})`)
  lines.push('')
  lines.push(local.map(r => `\`/${r.name}\``).join(' · '))
  lines.push('')
  lines.push(`## Slash routes — model turns (prompt: ${prompt.length})`)
  lines.push('')
  lines.push(prompt.map(r => `\`/${r.name}\``).join(' · '))
  if (other.length > 0) {
    lines.push('')
    lines.push(`## Other route types (${other.length})`)
    lines.push('')
    lines.push(other.map(r => `\`/${r.name}\` (${r.type})`).join(' · '))
  }
  lines.push('')
  return lines.join('\n')
}

const generated = generate()
const boot = collectBoot()

console.log('the generated surface census')

// LAW 1: every boot surface honors the hold discipline (source-anchored).
for (const b of boot) {
  t(`boot discipline: ${b.surface.split(' (')[0]}`, b.ok, b.source)
}

// LAW 2: the committed census matches the live tree (drift gate).
if (WRITE) {
  writeFileSync(OUT, generated)
  console.log(`\nwrote ${path.relative(ROOT, OUT)}`)
} else {
  const committed = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''
  if (committed !== generated) {
    const a = committed.split('\n')
    const b2 = generated.split('\n')
    let firstDiff = 0
    while (firstDiff < Math.min(a.length, b2.length) && a[firstDiff] === b2[firstDiff]) firstDiff++
    t(
      'census matches the live tree (regenerate with --write)',
      false,
      `first divergence at line ${firstDiff + 1}: committed=${JSON.stringify(a[firstDiff] ?? '<EOF>')} live=${JSON.stringify(b2[firstDiff] ?? '<EOF>')}`,
    )
  } else {
    t('census matches the live tree', true)
  }
}

process.exit(fail)
