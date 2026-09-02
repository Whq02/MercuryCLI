#!/usr/bin/env bun
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
const help = read('src', 'components', 'PromptInput', 'PromptInputHelpMenu.tsx')
check('the ? help menu lists the palette chord', /for command palette/.test(help))
check('the help menu is de-_c (plain) so the line is not a hand-patched cache slot', !/const \$ = _c\(/.test(help))
const pal2 = read('src', 'components', 'MercuryCommandPalette.tsx')
check('the palette accepts ACTION rows (run callback, not insert)', /actions\?: PaletteAction\[\]/.test(pal2) && /if \(it\?\.run\) it\.run\(\)/.test(pal2))
check('PromptInput passes the open-file + search-contents hub actions', /actions=\{\[[\s\S]{0,260}setShowFileOpen\(true\)[\s\S]{0,160}setShowContentSearch\(true\)/.test(pi))

section('4. SAFETY invariants (no auto-run, no data loss, never overflows)')
const pal = read('src', 'components', 'MercuryCommandPalette.tsx')
check('component file exists', existsSync(join(root, 'src', 'components', 'MercuryCommandPalette.tsx')))
check('↵ inserts `/name ` (template) — launcher fills the prompt, user confirms', /onRun\(`\/\$\{it\.name\} `\)/.test(pal))
check('the palette NEVER calls the composer submit (submitInput)', !/submitInput/.test(pal))
check('↵ routes through the ONE activate path (editor onSubmit → activateSelected)', /onSubmit=\{\(\) => \{[\s\S]{0,120}activateSelected\(sel\)/.test(pal))
check('the PromptInput onRun path inserts at cursor (no buffer clobber → no data loss)', /onRun=\{text =>[\s\S]{0,160}insertTextAtCursor/.test(pi))
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
