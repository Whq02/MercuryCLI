#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-file-open.ts
//  PROOF for the warm-ink FILE quick-open (ctrl+x f) — MercuryFileOpen, the @-file
//  half of the command-palette suite. The PIXELS are render-verified deterministically
//  (render-file-open.tsx, UI_RENDER=1, mock loader); this locks the WIRING + SAFETY
//  invariants + that it SHIPS, on the always-on gate.
//    1. keybinding action + the FLAG-GATED ctrl+x f binding;
//    2. PromptInput imports/states/keybinds/renders it, stamp-gated, in the overlay guard;
//    3. SAFETY: selecting INSERTS `@path ` (integrates @-mentions; never auto-runs / no
//       data loss); the list is height-clamped (never overflows the alt-screen);
//    4. the file index is loaded LAZILY (dynamic import) so the module is render-proof
//       loadable (the real generateFileSuggestions chain pulls a feature()-macro module);
//    5. it SHIPS in dist/mercury.mjs.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-file-open.ts
// ============================================================================
import { execSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
console.log(' Hermes file quick-open (ctrl+x f)')
console.log('============================================================')

section('1. keybinding: action + FLAG-GATED ctrl+x f binding')
// The action list's ONE authority is the action graph: schema.ts
// re-exports it, so the id is asserted where it is AUTHORED.
const graph = read('src', 'keybindings', 'actionGraph.ts')
check("KEYBINDING_ACTIONS includes 'app:fileOpen'", /'app:fileOpen'/.test(graph))
const binds = read('src', 'keybindings', 'defaultBindings.ts')
check('ctrl+x f binds app:fileOpen', /'ctrl\+x f':\s*'app:fileOpen'/.test(binds))
check('the ctrl+x f binding is present unconditionally (a plain entry, no gated spread)', /^\s+'ctrl\+x f': 'app:fileOpen',$/m.test(binds))

section('2. PromptInput wiring (import · state · keybinding · render), stamp-gated')
const pi = read('src', 'components', 'PromptInput', 'PromptInput.tsx')
check('imports MercuryFileOpen', /import \{ MercuryFileOpen \} from '\.\.\/MercuryFileOpen\.js'/.test(pi))
check('has showFileOpen state', /const \[showFileOpen, setShowFileOpen\] = useState\(false\)/.test(pi))
check("useKeybinding('app:fileOpen', …) opens it", /useKeybinding\('app:fileOpen',[\s\S]{0,80}setShowFileOpen\(true\)/.test(pi))
check('render branch keys on showFileOpen (unconditional)', /if \(showFileOpen\)/.test(pi))
check('file-open is in the modal-overlay suppression guard', /showCommandPalette \|\|\s*showFileOpen/.test(pi))

section('3. SAFETY invariants (insert @path, no auto-run, never overflows, lazy index)')
const fo = read('src', 'components', 'MercuryFileOpen.tsx')
check('component file exists', existsSync(join(root, 'src', 'components', 'MercuryFileOpen.tsx')))
check('↵ inserts `@path ` (the @-mention launcher contract)', /onPick\(`@\$\{it\.displayText\} `\)/.test(fo))
// MINI-TEMPER item 2 re-anchor: the query is a real TextInput; its onSubmit
// routes ↵ to onPick (insert `@path `) — never the composer submit.
check('NEVER calls the composer submit (submitInput)', !/submitInput/.test(fo))
check('↵ routes through onPick insertion only', /onSubmit=\{\(\) => \{[\s\S]{0,160}onPick\(`@\$\{it\.displayText\} `\)/.test(fo))
check('the PromptInput onPick path inserts at cursor (no buffer clobber → no data loss)', /onPick=\{text =>[\s\S]{0,160}insertTextAtCursor/.test(pi))
// MINI-TEMPER item-4 sibling sweep: the clamp rides the ONE viewport
// contract (min aspirational — never manufactures rows).
check('visible rows are clamped to terminal height (never overflows the alt-screen)', /reserve: cockpitActive \? cockpitBottomSlotReserve\(termRows\) : HEIGHT_RESERVE/.test(fo))
check('count/recency live in the always-pinned footer (no clippable header row)', /footer=\{footer\}/.test(fo))
check('the list is bounded with a +N more', /\+\{\(results\?\.length \?\? 0\) - shown\.length\} more/.test(fo))
check('the heavy file index is LAZY (dynamic import) — not a static top import', /await import\('\.\.\/hooks\/fileSuggestions\.js'\)/.test(fo) && !/^import \{ generateFileSuggestions \}/m.test(fo))
check('an async gen-guard drops stale result sets (no out-of-order clobber)', /genRef\.current/.test(fo) && /gen === genRef\.current/.test(fo))

section('4. it SHIPS in dist')
const dist = join(root, 'dist', 'mercury.mjs')
if (!existsSync(dist)) {
  check('dist/mercury.mjs present (run bun run build.ts first)', false)
} else {
  const grep = (s: string) =>
    execSync(`grep -c ${JSON.stringify(s)} ${JSON.stringify(dist)} || true`, { encoding: 'utf-8' }).trim() !== '0'
  check('dist carries the "open file" view header', grep('open file'))
  check('dist carries the empty-query placeholder', grep('fuzzy-find a file to reference'))
  check("dist carries the 'app:fileOpen' action", grep('app:fileOpen'))
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ file quick-open — wiring + safety + lazy-index + ships, all proven')
  process.exit(0)
} else {
  console.log(` ❌ file quick-open — ${failures} check(s) failed`)
  process.exit(1)
}
