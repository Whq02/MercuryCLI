#!/usr/bin/env bun
// ============================================================================
//  scripts/ui/prove-content-search.ts
//  PROOF for the warm-ink CONTENT search (ctrl+x g) — MercuryContentSearch, the
//  content half of the quick-open suite. Pixels render-verified deterministically
//  (render-content-search.tsx, UI_RENDER=1, mock loader); this locks WIRING +
//  SAFETY + that it SHIPS, on the always-on gate.
//
//  Run: ~/.bun/bin/bun run scripts/ui/prove-content-search.ts
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
console.log(' Hermes content search (ctrl+x g)')
console.log('============================================================')

section('1. keybinding: action + FLAG-GATED ctrl+x g binding')
// The action list's ONE authority is the action graph: schema.ts
// re-exports it, so the id is asserted where it is AUTHORED.
const graph = read('src', 'keybindings', 'actionGraph.ts')
check("KEYBINDING_ACTIONS includes 'app:contentSearch'", /'app:contentSearch'/.test(graph))
const binds = read('src', 'keybindings', 'defaultBindings.ts')
check('ctrl+x g binds app:contentSearch', /'ctrl\+x g':\s*'app:contentSearch'/.test(binds))
check('the ctrl+x g binding is present unconditionally (a plain entry, no gated spread)', /^\s+'ctrl\+x g': 'app:contentSearch',$/m.test(binds))

section('2. PromptInput wiring, stamp-gated')
const pi = read('src', 'components', 'PromptInput', 'PromptInput.tsx')
check('imports MercuryContentSearch', /import \{ MercuryContentSearch \} from '\.\.\/MercuryContentSearch\.js'/.test(pi))
check('has showContentSearch state', /const \[showContentSearch, setShowContentSearch\] = useState\(false\)/.test(pi))
check("useKeybinding('app:contentSearch', …) is wired", /useKeybinding\('app:contentSearch',[\s\S]{0,80}setShowContentSearch\(true\)/.test(pi))
check('render branch keys on showContentSearch (unconditional)', /if \(showContentSearch\)/.test(pi))
check('content-search is in the modal-overlay suppression guard', /showFileOpen \|\|\s*showContentSearch/.test(pi))

section('3. SAFETY invariants (insert @file#L, no auto-run, abort, never overflows)')
const cs = read('src', 'components', 'MercuryContentSearch.tsx')
check('component file exists', existsSync(join(root, 'src', 'components', 'MercuryContentSearch.tsx')))
check('↵ inserts `@file#Lline ` (line-anchored mention)', /onPick\(`@\$\{it\.file\}#L\$\{it\.line\} `\)/.test(cs))
// MINI-TEMPER item 2 re-anchor: the query is a real TextInput; its onSubmit
// routes ↵ to onPick (insert `@file#L `) — never the composer submit.
check('NEVER calls the composer submit (submitInput)', !/submitInput/.test(cs))
check('↵ routes through onPick insertion only', /onSubmit=\{\(\) => \{[\s\S]{0,160}onPick\(`@\$\{it\.file\}#L\$\{it\.line\} `\)/.test(cs))
check('the PromptInput onPick path inserts at cursor (no data loss)', /if \(showContentSearch\)[\s\S]{0,600}insertTextAtCursor/.test(pi))
check('aborts the in-flight grep on a new query (AbortController)', /abortRef\.current\?\.abort\(\)/.test(cs) && /new AbortController\(\)/.test(cs))
check('a gen-guard drops stale result sets', /genRef\.current/.test(cs) && /gen === genRef\.current/.test(cs))
check('a 2-char floor keeps grep off noise', /MIN_QUERY = 2/.test(cs) && /length < MIN_QUERY/.test(cs))
// MINI-TEMPER item-4 sibling sweep: the ONE viewport contract.
check('visible rows are clamped to terminal height', /reserve: cockpitActive \? cockpitBottomSlotReserve\(termRows\) : HEIGHT_RESERVE/.test(cs))
check('the heavy ripgrep index is LAZY (dynamic import), not a static top import', /await Promise\.all\(\[\s*import\('\.\.\/utils\/ripgrep\.js'\)/.test(cs) && !/^import \{ ripGrepStream/m.test(cs))

section('4. it SHIPS in dist')
const dist = join(root, 'dist', 'mercury.mjs')
if (!existsSync(dist)) {
  check('dist/mercury.mjs present (run bun run build.ts first)', false)
} else {
  const grep = (s: string) =>
    execSync(`grep -c ${JSON.stringify(s)} ${JSON.stringify(dist)} || true`, { encoding: 'utf-8' }).trim() !== '0'
  check('dist carries the grep placeholder', grep('grep the working tree for'))
  check("dist carries the 'app:contentSearch' action", grep('app:contentSearch'))
}

console.log('\n' + '='.repeat(60))
if (failures === 0) {
  console.log(' ✅ content search — wiring + safety + abort + lazy-index + ships, all proven')
  process.exit(0)
} else {
  console.log(` ❌ content search — ${failures} check(s) failed`)
  process.exit(1)
}
