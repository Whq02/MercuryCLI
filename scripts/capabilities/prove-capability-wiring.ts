import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtinCommands } from '../../src/commands/catalogue/commands.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const SRC = resolve(REPO, 'src')

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

function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(importStmt, m => m.replace(/from\s*['"][^'"]+['"]/, "from ''"))
    .replace(/import\s+type\b[\s\S]*?from\s*''/g, ' ')
    .replace(/\btype\s+[A-Za-z0-9_]+/g, ' ')
}

function definesSymbol(text: string, symbol: string): boolean {
  return new RegExp(`(export\\s+)?(async\\s+)?(function|const|let|var|class)\\s+${symbol}\\b`).test(text)
}

function realConsumersOf(symbol: string): string[] {
  const sym = new RegExp(`\\b${symbol}\\b`)
  const hits: string[] = []
  for (const f of SRC_FILES) {
    try {
      const text = readFileSync(f, 'utf8')
      if (definesSymbol(text, symbol)) continue
      if (sym.test(codeOnly(text))) hits.push(f)
    } catch {
    }
  }
  return hits
}

const WIRING: Array<{ cap: string; symbol: string }> = [
  { cap: 'MercuryFrame statusbar', symbol: 'MercuryFrame' },
  { cap: 'FullscreenLayout / no-flicker', symbol: 'FullscreenLayout' },
  { cap: 'Warm background paint', symbol: 'applyWarmBackground' },
  { cap: 'Skill discovery (getSkillToolCommands)', symbol: 'getSkillToolCommands' },
  { cap: 'render_tui MCP render-verify tool', symbol: 'renderTui' },
]

const COMMANDS = ['help', 'verify']

let fail = 0
const registeredCommands = new Set(builtinCommands().map(cmd => cmd.name))

console.log('— capability wiring (severed-loop detector) —')
for (const { cap, symbol } of WIRING) {
  const consumers = realConsumersOf(symbol)
  if (consumers.length >= 1) {
    console.log(`  ✓ ${cap}: ${symbol} used by ${consumers.length} real consumer(s) (loop closed)`)
  } else {
    console.error(`  ✗ ${cap}: ${symbol} has NO real src consumer — SEVERED (comment / import-path / type-only is not a wire). Fix: import and call ${symbol} from the src code that should use it, or drop it from WIRING in this file if it was removed on purpose`)
    fail = 1
  }
}

console.log('— command registration —')
for (const name of COMMANDS) {
  if (registeredCommands.has(name)) {
    console.log(`  ✓ /${name} registered in builtinCommands()`)
  } else {
    console.error(`  ✗ /${name} NOT registered in builtinCommands(). Fix: add the /${name} command to the list built by builtinCommands in src/commands/catalogue/commands.ts`)
    fail = 1
  }
}

const commandFiles = [
  'src/commands/help/index.ts',
  'src/commands/verify/index.ts',
]
for (const f of commandFiles) {
  if (existsSync(resolve(REPO, f))) console.log(`  ✓ ${f} exists`)
  else { console.error(`  ✗ ${f} MISSING. Fix: restore ${f}, or update commandFiles in this file if the command moved`); fail = 1 }
}

if (fail) {
  console.error('\n✗ capability wiring proof FAILED')
  process.exit(1)
}
console.log('\n✓ all listed capabilities are wired (real consumers + registered commands)')
