/* ============================================================================
   prove-capability-wiring.ts — a severed-loop detector for the LIVE capabilities
   the graduation audit found WITHOUT a dedicated logic/render proof.

   A capability is "wired" only if its implementation symbol has a real RUNTIME
   CONSUMER in src/ (not just a definition, and not only a scripts/ proof). The
   classic failure this guards against is exactly the BROKEN row the audit found:
   promoteScribeCandidate() existed + was proven, but had ZERO src/ callers, so
   its loop was severed. This proof asserts each listed symbol is referenced by
   ≥2 distinct src/ files (its definition + at least one consumer) and that each
   listed slash command is registered in src/commands.ts. Source-truth, headless,
   no mocks — it reads the real tree the same way `rg` does.

   This is the proof backing the "Proof: scripts/capabilities/run-all.sh" rows in
   docs/CAPABILITY-GRADUATION-MATRIX.md. Add a capability here when the matrix
   cites this suite as its proof.
   ============================================================================ */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const SRC = resolve(REPO, 'src')

/** Every .ts/.tsx file under src/ (self-contained walk — no PATH/rg dependency,
 *  so a misdetected-binary file is read like any other). */
function allSrcFiles(dir: string, out: string[] = []): string[] {
  for (const ent of readdirSync(dir)) {
    const p = join(dir, ent)
    const st = statSync(p)
    if (st.isDirectory()) allSrcFiles(p, out)
    else if (/\.(ts|tsx|js|jsx)$/.test(ent)) out.push(p)
  }
  return out
}
const SRC_FILES = allSrcFiles(SRC)

const importStmt = /import\b[\s\S]*?from\s*['"][^'"]+['"]/g

/** Strip a symbol down to its real CODE occurrences in a file: drop comments
 *  (where a stale mention hides — that was the BROKEN row's disguise), blank the
 *  module PATH of every import (so `from './FooManager'` isn't a use of `Foo`),
 *  and erase type-only imports + inline `type X` specifiers (erased at build, no
 *  runtime consumer). What remains is value imports, `require('…').Sym` accesses,
 *  calls `Sym(`, and JSX `<Sym>` — i.e. genuine runtime use. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1') // line comments (keep `://` in URLs)
    .replace(importStmt, m => m.replace(/from\s*['"][^'"]+['"]/, "from ''")) // blank import paths
    .replace(/import\s+type\b[\s\S]*?from\s*''/g, ' ') // drop type-only imports
    .replace(/\btype\s+[A-Za-z0-9_]+/g, ' ') // drop inline `type X` specifiers
}

function definesSymbol(text: string, symbol: string): boolean {
  return new RegExp(`(export\\s+)?(async\\s+)?(function|const|let|var|class)\\s+${symbol}\\b`).test(text)
}

/** src/ files that are REAL runtime consumers of `symbol`: it appears in their
 *  code (not a comment / import-path / type) and they are not the file that
 *  defines it. ≥1 ⇒ the loop is closed. Catches value imports, require-access,
 *  calls, and JSX alike — a comment mention or a path coincidence does not. */
function realConsumersOf(symbol: string): string[] {
  const sym = new RegExp(`\\b${symbol}\\b`)
  const hits: string[] = []
  for (const f of SRC_FILES) {
    try {
      const text = readFileSync(f, 'utf8')
      if (definesSymbol(text, symbol)) continue // the producer, not a consumer
      if (sym.test(codeOnly(text))) hits.push(f)
    } catch {
      /* unreadable — skip */
    }
  }
  return hits
}

// Capability → the implementation symbol that must have a real CONSUMER (importer).
// (Team roster lock is intentionally absent — it has a dedicated proof,
//  scripts/substrate/prove-team-roster-lock.ts, which the matrix cites directly.)
const WIRING: Array<{ cap: string; symbol: string }> = [
  { cap: 'MercuryFrame statusbar', symbol: 'MercuryFrame' },
  { cap: 'FullscreenLayout / no-flicker', symbol: 'FullscreenLayout' },
  { cap: '/cockpit (CockpitView)', symbol: 'CockpitView' },
  { cap: 'Warm background paint', symbol: 'applyWarmBackground' },
  { cap: 'TeamBrief tool', symbol: 'TeamBriefTool' },
  { cap: 'SendMessage governance', symbol: 'canDirect' },
  { cap: 'Honesty-gated handoff', symbol: 'recordHandoff' }, // public entry; runs validateHandoff internally
  // 'Remote session transport' (RemoteSessionManager) row REMOVED:
  // src/remote/ was DELETED in the machinery prune (its --remote TUI
  // producer sat behind a constant-false upstream gate).
  { cap: 'Skill discovery (getSkillToolCommands)', symbol: 'getSkillToolCommands' },
  { cap: 'Scribe candidate ratify (the fixed BROKEN loop)', symbol: 'promoteScribeCandidate' },
  { cap: 'List scribe candidates', symbol: 'listScribeCandidates' },
  { cap: 'render_tui MCP render-verify tool', symbol: 'renderTui' },
]

// Slash commands that must be registered in the command registry.
const COMMANDS = ['cockpit', 'help', 'verify', 'workflows', 'scribe-promote']

let fail = 0
const commandsTs = readFileSync(resolve(REPO, 'src/commands.ts'), 'utf8')

console.log('— capability wiring (severed-loop detector) —')
for (const { cap, symbol } of WIRING) {
  const consumers = realConsumersOf(symbol)
  if (consumers.length >= 1) {
    console.log(`  ✓ ${cap}: ${symbol} used by ${consumers.length} real consumer(s) (loop closed)`)
  } else {
    console.error(`  ✗ ${cap}: ${symbol} has NO real src consumer — SEVERED (comment / import-path / type-only is not a wire)`)
    fail = 1
  }
}

console.log('— command registration —')
for (const name of COMMANDS) {
  // Registered only via a real import/require of the command module dir/file —
  // NOT a bare substring (which would match the name inside a comment/string).
  const reByDir = new RegExp(`(import|require)\\b[^\\n]*commands/${name}/index`)
  const reByFile = new RegExp(`(import|require)\\b[^\\n]*commands/${name}(\\.js|')`)
  if (reByDir.test(commandsTs) || reByFile.test(commandsTs)) {
    console.log(`  ✓ /${name} registered in src/commands.ts`)
  } else {
    console.error(`  ✗ /${name} NOT registered in src/commands.ts`)
    fail = 1
  }
}

// Sanity: the command source files actually exist on disk.
const commandFiles = [
  'src/commands/cockpit/index.ts',
  'src/commands/help/index.ts',
  'src/commands/verify.ts',
  'src/commands/workflows/index.ts',
  'src/commands/scribe-promote/index.ts',
]
for (const f of commandFiles) {
  if (existsSync(resolve(REPO, f))) console.log(`  ✓ ${f} exists`)
  else { console.error(`  ✗ ${f} MISSING`); fail = 1 }
}

if (fail) {
  console.error('\n✗ capability wiring proof FAILED')
  process.exit(1)
}
console.log('\n✓ all listed capabilities are wired (real consumers + registered commands)')
