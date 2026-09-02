

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  { cap: '/cockpit (CockpitView)', symbol: 'CockpitView' },
  { cap: 'Warm background paint', symbol: 'applyWarmBackground' },
  { cap: 'TeamBrief tool', symbol: 'TeamBriefTool' },
  { cap: 'SendMessage governance', symbol: 'canDirect' },
  { cap: 'Honesty-gated handoff', symbol: 'recordHandoff' },
  { cap: 'Skill discovery (getSkillToolCommands)', symbol: 'getSkillToolCommands' },
  { cap: 'render_tui MCP render-verify tool', symbol: 'renderTui' },
]

const COMMANDS = ['cockpit', 'help', 'verify', 'workflows']

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
  const reByDir = new RegExp(`(import|require)\\b[^\\n]*commands/${name}/index`)
  const reByFile = new RegExp(`(import|require)\\b[^\\n]*commands/${name}(\\.js|')`)
  if (reByDir.test(commandsTs) || reByFile.test(commandsTs)) {
    console.log(`  ✓ /${name} registered in src/commands.ts`)
  } else {
    console.error(`  ✗ /${name} NOT registered in src/commands.ts`)
    fail = 1
  }
}

const commandFiles = [
  'src/commands/cockpit/index.ts',
  'src/commands/help/index.ts',
  'src/commands/verify.ts',
  'src/commands/workflows/index.ts',
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
