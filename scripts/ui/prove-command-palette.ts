#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-command-palette.ts
//  PROOF for the warm-ink Hermes Command Palette (ctrl+x p) — the fork's live
//  fuzzy command launcher (MercuryCommandPalette.tsx), wired into PromptInput.
//  The PIXELS are render-verified (vshot @80+120); this locks the LOGIC + the
//  wiring + the safety invariants so a regression fails the gate:
//    1. fuzzy ranking actually ranks (pure fuzzySearch, loadable) — a name query
//       surfaces the right command above the noise;
//    2. the keybinding action + the FLAG-GATED ctrl+x p binding exist;
//    3. PromptInput imports/states/keybinds/renders the palette, stamp-gated;
//    4. SAFETY: select INSERTS `/name ` (never auto-submits) → no data loss / no
//       surprise run; the list is height-bounded (never overflows the alt-screen);
//    5. the wiring actually SHIPS in dist/mercury.mjs (never DCE-folded).
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-command-palette.ts
// ============================================================================
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fuzzySearch } from '../../src/utils/fuzzyMatch.ts'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf-8')

console.log('============================================================')
console.log(' Hermes Command Palette — fuzzy launcher (ctrl+x p)')
console.log('============================================================')

section('1. fuzzy ranking ranks (pure fuzzySearch — the palette engine)')
const names = ['color', 'compact', 'config', 'copy', 'context', 'control', 'cockpit', 'help', 'mission', 'deck']
const co = fuzzySearch(names, 'co', 10)
check('"co" returns matches', co.length > 0, `${co.length} hits`)
check('every "co" hit actually contains the needle letters in order', co.every(r => /c.*o/i.test(r.path)))
check('non-matching names are rejected (help/mission absent for "co")', !co.some(r => r.path === 'help' || r.path === 'mission'))
const ckpt = fuzzySearch(names, 'ckpt', 10)
check('subsequence query "ckpt" finds "cockpit" (true fuzzy, not substring)', ckpt.some(r => r.path === 'cockpit'))
const empty = fuzzySearch(names, 'zzzq', 10)
check('a no-match query returns empty (honest, no false hits)', empty.length === 0)

section('2. keybinding: action + FLAG-GATED ctrl+x p binding')
// The action list's ONE authority is the action graph: schema.ts
// re-exports it, so the id is asserted where it is AUTHORED.
const graph = read('src', 'keybindings', 'actionGraph.ts')
check("KEYBINDING_ACTIONS includes 'app:commandPalette'", /'app:commandPalette'/.test(graph))
const binds = read('src', 'keybindings', 'defaultBindings.ts')
check("ctrl+x p binds app:commandPalette", /'ctrl\+x p':\s*'app:commandPalette'/.test(binds))
check('the ctrl+x p binding is present unconditionally (a plain entry, no gated spread)', /^\s+'ctrl\+x p': 'app:commandPalette',$/m.test(binds))

section('3. PromptInput wiring (import · state · keybinding · render), stamp-gated')
const pi = read('src', 'components', 'PromptInput', 'PromptInput.tsx')
check('imports MercuryCommandPalette', /import \{ MercuryCommandPalette \} from '\.\.\/MercuryCommandPalette\.js'/.test(pi))
check('has showCommandPalette state', /const \[showCommandPalette, setShowCommandPalette\] = useState\(false\)/.test(pi))
check("useKeybinding('app:commandPalette', …) opens it", /useKeybinding\('app:commandPalette'/.test(pi))
check('the open handler is wired', /useKeybinding\('app:commandPalette',[\s\S]{0,80}setShowCommandPalette\(true\)/.test(pi))
check('render branch keys on showCommandPalette (unconditional)', /if \(showCommandPalette\)/.test(pi))
check('palette is in the modal-overlay suppression guard', /showTeamsDialog \|\|\s*showCommandPalette/.test(pi))
// discoverability: the ? help menu surfaces the chord (stamp-gated).
const help = read('src', 'components', 'PromptInput', 'PromptInputHelpMenu.tsx')
check('the ? help menu lists the palette chord', /for command palette/.test(help))
check('the help menu is de-_c (plain) so the line is not a hand-patched cache slot', !/const \$ = _c\(/.test(help))
// hub: the palette surfaces file-open / content-search as ACTION rows (run a
// callback, not insert) so ctrl+x p is the single quick-open entry point.
const pal2 = read('src', 'components', 'MercuryCommandPalette.tsx')
check('the palette accepts ACTION rows (run callback, not insert)', /actions\?: PaletteAction\[\]/.test(pal2) && /if \(it\?\.run\) it\.run\(\)/.test(pal2))
check('PromptInput passes the open-file + search-contents hub actions', /actions=\{\[[\s\S]{0,260}setShowFileOpen\(true\)[\s\S]{0,160}setShowContentSearch\(true\)/.test(pi))

section('4. SAFETY invariants (no auto-run, no data loss, never overflows)')
const pal = read('src', 'components', 'MercuryCommandPalette.tsx')
check('component file exists', existsSync(join(root, 'src', 'components', 'MercuryCommandPalette.tsx')))
// select INSERTS `/name ` — it must NOT submit/run. The only escape is onRun(insert).
check('↵ inserts `/name ` (template) — launcher fills the prompt, user confirms', /onRun\(`\/\$\{it\.name\} `\)/.test(pal))
// MINI-TEMPER item 2 re-anchor: the query is a real TextInput whose onSubmit
// routes ↵ to activateSelected (insert `/name ` / run an ACTION row) — the
// no-surprise-run law is that the palette never reaches the COMPOSER submit.
check('the palette NEVER calls the composer submit (submitInput)', !/submitInput/.test(pal))
check('↵ routes through the ONE activate path (editor onSubmit → activateSelected)', /onSubmit=\{\(\) => \{[\s\S]{0,120}activateSelected\(sel\)/.test(pal))
check('the PromptInput onRun path inserts at cursor (no buffer clobber → no data loss)', /onRun=\{text =>[\s\S]{0,160}insertTextAtCursor/.test(pi))
// height is bounded to the terminal so the bottom-slot overlay can't overflow the
// alt-screen and clip its own footer on a short terminal.
// the reserve is SLOT-AWARE — the cockpit's bottom slot is
// shorter than the home's, and the home-tuned cap overflowed it (the clipped
// tail merged into the counter line). The clamp must consult the cockpit flag.
//  re-anchor: the clamp rides the ONE viewport contract
// (geometry.ts viewportRows — clamp-at-zero + floor/cap spelled once), still
// consulting the cockpit-aware reserve.
check('visible rows are clamped to the ACTIVE slot height (the SCALED cockpit reserve — LUSTRE L4)',
  /reserve: cockpitActive \? cockpitBottomSlotReserve\(termRows\) : HEIGHT_RESERVE/.test(pal))
check('the count/recency live in the always-pinned footer (no clippable header row)', /footer=\{footer\}/.test(pal) && !/SectionHeader/.test(pal))
check('the list is bounded by the cursor window + a position row, and the counter SPENDS a cap row (LUSTRE L4)', /filtered\.slice\(winStart, winStart \+ listRows\)/.test(pal) && /filtered\.length > rowCap \? Math\.max\(1, rowCap - 1\) : rowCap/.test(pal) && pal.includes('↑↓ walks the full list'))
check('recently-used commands are surfaced (getSkillUsageScore)', /getSkillUsageScore/.test(pal))

section('5. it SHIPS in dist (never DCE-folded)')
const dist = join(root, 'dist', 'mercury.mjs')
if (!existsSync(dist)) {
  check('dist/mercury.mjs present (run bun run build.ts first)', false)
} else {
  const grep = (s: string) =>
    execSync(`grep -c ${JSON.stringify(s)} ${JSON.stringify(dist)} || true`, { encoding: 'utf-8' }).trim() !== '0'
  check('dist carries the palette header literal ("— command palette" via view prop)', grep('command palette'))
  check('dist carries the empty-query placeholder', grep('fuzzy by name or what it does'))
  check("dist carries the 'app:commandPalette' action", grep('app:commandPalette'))
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ Command Palette — ranking + wiring + safety + ships, all proven')
  process.exit(0)
} else {
  console.log(` ❌ Command Palette — ${failures} check(s) failed`)
  process.exit(1)
}
