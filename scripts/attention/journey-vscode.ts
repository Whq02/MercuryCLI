#!/usr/bin/env bun
// ============================================================================
//  scripts/attention/journey-vscode.ts — machine-gated
//  extension-host journey.
//
//  THE MACHINE GATE (the row's contract, verbatim): without VS Code this
//  journey SKIPs LOUDLY with exit 3 — run-all.sh's journey lane reads 3 as
//  "machine gate honoured", 0 as "ran and passed", anything else as a real
//  failure. The headless substance of (core-state-only consumption,
//  selections/images → ComposerDocumentV2) is standing-proved by
//  prove-c2-vscode-bridge.ts + the ACP conformance prover and does
//  NOT ride this gate.
//
//  Where VS Code IS present, the journey verifies the install surface the
//  extension actually ships through: the CLI answers, the extension loads
//  as a node module (syntax + export shape), and package.json contributes
//  every surface extension.js registers. It does NOT boot a GUI extension
//  host — that is the hosted lane's job, and this says so in its output.
//
//  Run:  ~/.bun/bin/bun run scripts/attention/journey-vscode.ts
// ============================================================================
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { checker } from '../engine-durability/harness.ts'

const CODE_CANDIDATES = [
  ...(process.env.PATH ?? '').split(delimiter).map(p => join(p, 'code')),
  '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
  join(homedir(), 'Applications/Visual Studio Code.app/Contents/Resources/app/bin/code'),
  '/usr/local/bin/code',
  '/opt/homebrew/bin/code',
]
const codeCli = CODE_CANDIDATES.find(p => {
  try {
    return existsSync(p)
  } catch {
    return false
  }
})

if (codeCli === undefined) {
  console.log('\n  [SKIP — LOUD] this machine has no VS Code:')
  console.log('    · no `code` CLI on PATH and no Visual Studio Code.app at the standard roots')
  console.log('    · RV-28\'s machine gate: exit 3 = the gate is HONOURED, not a failure')
  console.log('    · the headless RV-28 substance rides prove-c2-vscode-bridge.ts + the')
  console.log('      mosaic ACP conformance prover; the extension-host boot is the hosted')
  console.log('      lane\'s job where a VS Code install exists')
  process.exit(3)
}

const t = checker()
t.section(`extension-host journey (VS Code found: ${codeCli})`)

let version = ''
try {
  version = execFileSync(codeCli, ['--version'], { encoding: 'utf8', timeout: 30_000 })
    .split('\n')[0]!
    .trim()
} catch (e) {
  t.check('the code CLI answers --version', false, String(e).slice(0, 120))
}
if (version !== '') t.check(`the code CLI answers --version (${version})`, true)

// The extension must load as a plain node module (it is shipped unbundled).
{
  let loaded: Record<string, unknown> | null = null
  try {
    // extension.js requires 'vscode' at module top — stub the resolution the
    // way the extension host does, via a require shim.
    const Module = await import('node:module')
    const original = (Module.default as unknown as { _load: (...a: unknown[]) => unknown })._load
    ;(Module.default as unknown as { _load: (...a: unknown[]) => unknown })._load = (
      request: unknown,
      ...rest: unknown[]
    ) => {
      if (request === 'vscode') {
        return new Proxy({}, { get: () => new Proxy(function () {}, { get: () => () => ({}), apply: () => ({}) }) })
      }
      return original(request, ...rest)
    }
    try {
      const { createRequire } = Module.default as unknown as {
        createRequire: (p: string) => (id: string) => Record<string, unknown>
      }
      const req = createRequire(join(process.cwd(), 'scripts', 'attention', 'journey-vscode.ts'))
      loaded = req(join(process.cwd(), 'integrations', 'vscode', 'extension.js'))
    } finally {
      ;(Module.default as unknown as { _load: (...a: unknown[]) => unknown })._load = original
    }
  } catch (e) {
    t.check('extension.js loads as a node module', false, String(e).slice(0, 160))
  }
  if (loaded) {
    t.check(
      'extension.js loads and exports activate + deactivate',
      typeof loaded.activate === 'function' && typeof loaded.deactivate === 'function',
    )
  }
}

// Contribution parity: every surface extension.js registers is contributed.
{
  const src = readFileSync('integrations/vscode/extension.js', 'utf8')
  const pkg = JSON.parse(readFileSync('integrations/vscode/package.json', 'utf8')) as {
    contributes?: {
      views?: Record<string, Array<{ id: string }>>
      commands?: Array<{ command: string }>
    }
  }
  const contributedViews = Object.values(pkg.contributes?.views ?? {})
    .flat()
    .map(v => v.id)
  const registeredViews = [...src.matchAll(/registerTreeDataProvider\('([^']+)'/g)].map(m => m[1]!)
  t.check(
    `every registered view is contributed (${registeredViews.join(', ')})`,
    registeredViews.length > 0 && registeredViews.every(v => contributedViews.includes(v)),
    `contributed: ${contributedViews.join(', ')}`,
  )
  const contributedCommands = (pkg.contributes?.commands ?? []).map(c => c.command)
  const registeredCommands = [...src.matchAll(/register\('([^']+)'/g)].map(m => m[1]!)
  t.check(
    `every registered command is contributed (${registeredCommands.length})`,
    registeredCommands.length > 0 && registeredCommands.every(c => contributedCommands.includes(c)),
    `missing: ${registeredCommands.filter(c => !contributedCommands.includes(c)).join(', ')}`,
  )
}

console.log('\n  NOTE: this journey does NOT boot a GUI extension host — that leg is the')
console.log('  hosted lane\'s where an install exists; the ACP wire the extension speaks is')
console.log('  E2E-proved headless by scripts/editor-bridge/prove-acp-server.ts.')

// Exit vocabulary (wave-C review: 3 is RESERVED for the machine-gate SKIP in
// this lane — a REAL check failure must never wear it): 0 = ran and passed,
// 1 = ran and FAILED, 3 = the gate's loud SKIP (top of file only).
const failed = t.failures()
console.log(`\n${failed === 0 ? '✅' : '❌'} journey-vscode — ${failed === 0 ? 'all checks pass' : `${failed} check(s) failed`}`)
process.exit(failed === 0 ? 0 : 1)
