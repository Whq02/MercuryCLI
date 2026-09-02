#!/usr/bin/env bun
// prove-fragile-quarantine — the fragile-grammar crash fence (field card
// FC-010, ruled QUARANTINE shape). The vendored tree-sitter-swift wasm can
// fatally OOM the V8 wasm compiler AFTER a successful parse (turboshaft Zone
// OOM; live-captured on this box: hasError=false printed, then Fatal process
// out of memory, exit 133; the card's Windows box saw exit 3) — uncatchable
// in-process, so the host dies with its work done. The facility now probes a
// grammar marked fragile ONCE per process in a DISPOSABLE child; a dead
// child quarantines that one grammar with an honest note and every other
// grammar loads in-host exactly as before. The vendor-bump-vs-worker fork
// was RULED and the bump taken: the swift wasm now rides the
// pinned upstream 0.7.3 release asset (vendor/grammars.lock.json sourceUrl),
// which passes the audition — the fence stays as the permanent audition
// door, so any future regressed blob quarantines itself instead of killing
// the host.
//
//   §1 the quarantine arm: a fragile grammar whose probe child dies answers
//      unavailable with the reason — the host survives.
//   §2 the pass arm: a fragile grammar whose probe survives loads in-host.
//   §3 probe once: the verdict is memoised per process.
//   §4 the swift registry entry is marked fragile; non-fragile rows never
//      probe (call-shaped: the fence keys off the registry flag).
//   §5 the cure: the vendored swift blob survives load+parse under NODE —
//      the product runtime whose V8 optimizing wasm compiler the old blob
//      killed (this prover runs under bun/JSC, where even the killer blob
//      passed: the bun-green≠node-green class) — with a control arm proving
//      the node child CAN die.
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.NODE_ENV = 'test'
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

const ROOT = join(import.meta.dir, '..', '..')
const ENGINE_SRC = join(ROOT, 'node_modules', '@vscode', 'tree-sitter-wasm', 'wasm')

// A composed engine dir the override pin accepts: engine runtime + one real
// grammar + one garbage "grammar" whose probe child must die.
const DIR = realpathSync(mkdtempSync(join(tmpdir(), 'fragile-fence-')))
copyFileSync(join(ENGINE_SRC, 'tree-sitter.js'), join(DIR, 'tree-sitter.js'))
copyFileSync(join(ENGINE_SRC, 'tree-sitter.wasm'), join(DIR, 'tree-sitter.wasm'))
// json rides the grammar-pack cache (fetch-grammars populates it); the
// engine runtime rides the vscode pack.
copyFileSync(join(ROOT, 'vendor', 'grammars', 'extracted', 'tree-sitter-json.wasm'), join(DIR, 'tree-sitter-json.wasm'))
writeFileSync(join(DIR, 'not-a-grammar.wasm'), 'these bytes are no wasm at all')
process.env.MERCURY_TREESITTER_VENDOR_DIR = DIR

const facility = await import('../../src/services/structure/grammarFacility.ts')
const { loadGrammarEngine, _resetFragileProbeForTesting } = facility
const { GRAMMAR_REGISTRY } = await import('../../src/services/structure/grammarRegistry.ts')

let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
  if (!cond) failures++
}
const section = (t: string): void => console.log('\n' + '─'.repeat(76) + '\n' + t)

const engine = await loadGrammarEngine()
if (engine.state !== 'ok') {
  console.error(`  [FAIL] engine unavailable: ${engine.note}`)
  process.exit(1)
}

const isUnavailable = (v: unknown): v is { state: 'unavailable'; note: string } =>
  typeof v === 'object' && v !== null && (v as { state?: string }).state === 'unavailable'

section('§1 THE QUARANTINE ARM')
{
  _resetFragileProbeForTesting()
  const verdict = await engine.loadLanguage({
    name: 'probe-dies',
    wasm: 'not-a-grammar.wasm',
    extensions: ['.probe'],
    fragile: { reason: 'synthetic fixture — the probe child must die' },
  } as never)
  check('a dead probe child quarantines the grammar', isUnavailable(verdict), JSON.stringify(verdict).slice(0, 120))
  check(
    'the note names quarantine + the reason + the child death',
    isUnavailable(verdict) && /quarantined/.test(verdict.note) && /synthetic fixture/.test(verdict.note),
    isUnavailable(verdict) ? verdict.note.slice(0, 160) : '',
  )
  check('the HOST survived the probe (this line printed)', true)
}

section('§2 THE PASS ARM')
{
  _resetFragileProbeForTesting()
  const loaded = await engine.loadLanguage({
    name: 'probe-passes',
    wasm: 'tree-sitter-json.wasm',
    extensions: ['.probejson'],
    fragile: { reason: 'synthetic fixture — the probe child survives' },
  } as never)
  check('a surviving probe lets the grammar load in-host', !isUnavailable(loaded), JSON.stringify(loaded).slice(0, 80))
}

section('§3 PROBE ONCE')
{
  _resetFragileProbeForTesting()
  const t1 = Date.now()
  await engine.loadLanguage({ name: 'memo-probe', wasm: 'not-a-grammar.wasm', extensions: ['.m'], fragile: { reason: 'memo fixture' } } as never)
  const firstMs = Date.now() - t1
  const t2 = Date.now()
  await engine.loadLanguage({ name: 'memo-probe', wasm: 'not-a-grammar.wasm', extensions: ['.m'], fragile: { reason: 'memo fixture' } } as never)
  const secondMs = Date.now() - t2
  check('the second ask answers from the memo (no second child)', secondMs < Math.max(50, firstMs / 4), `first=${firstMs}ms second=${secondMs}ms`)
}

section('§4 THE REGISTRY MARKING')
{
  const swift = GRAMMAR_REGISTRY.find(g => g.name === 'swift')
  check('swift is marked fragile with the engine-OOM reason', /OOM/.test(swift?.fragile?.reason ?? ''), swift?.fragile?.reason)
  const fragileCount = GRAMMAR_REGISTRY.filter(g => g.fragile).length
  check('exactly the one known-fragile grammar is marked (no blanket probing)', fragileCount === 1, String(fragileCount))
  // Non-fragile rows never probe: json (unmarked) loads with zero child cost.
  const t = Date.now()
  const json = await engine.loadLanguage(GRAMMAR_REGISTRY.find(g => g.name === 'json') as never)
  check('an unmarked grammar loads without the probe', !isUnavailable(json) && Date.now() - t < 5000)
}

section('§5 THE CURE: THE VENDORED SWIFT BLOB UNDER THE PRODUCT RUNTIME')
{
  // This prover runs under bun (JSC), where even the V8-killer 0.4-era blob
  // parsed clean — so the swift cure is only provable by spawning NODE, the
  // runtime the shipped product runs and the one the old blob deterministically
  // killed (turboshaft Zone OOM, exit 133 macOS / exit 3 Windows, AFTER a
  // successful parse). The child mirrors the facility's audition: load the
  // engine, load the ONE grammar, parse, exit 0.
  const nodeBin = Bun.which('node')
  check('node binary available (the product runtime)', nodeBin !== null)
  if (nodeBin) {
    const childSource = [
      "const path = require('node:path');",
      'const dir = process.argv[1];',
      'const wasm = process.argv[2];',
      "const raw = require(path.join(dir, 'tree-sitter.js'));",
      'const mod = raw && raw.Parser ? raw : (raw && raw.default) || raw;',
      '(async () => {',
      '  await mod.Parser.init({ locateFile: f => path.join(dir, f) });',
      '  const parser = new mod.Parser();',
      '  parser.setLanguage(await mod.Language.load(wasm));',
      "  const tree = parser.parse('func greet() { print(1) }');",
      '  if (!tree || !tree.rootNode || tree.rootNode.hasError) process.exit(8);',
      '  process.exit(0);',
      '})().catch(() => process.exit(9));',
    ].join('\n')
    const swiftWasm = join(ROOT, 'vendor', 'grammars', 'extracted', 'tree-sitter-swift.wasm')
    const cure = spawnSync(nodeBin, ['-e', childSource, DIR, swiftWasm], {
      env: process.env,
      timeout: 60_000,
      stdio: 'ignore',
      windowsHide: true,
    })
    check(
      'the vendored swift wasm survives load+parse under node (the cure holds)',
      cure.status === 0 && cure.signal === null && cure.error === undefined,
      `exit ${cure.status ?? 'null'}${cure.signal ? `, signal ${cure.signal}` : ''}${cure.error ? `, ${String(cure.error)}` : ''}`,
    )
    // Control: the same node child DIES on garbage bytes — the arm can fail.
    const control = spawnSync(nodeBin, ['-e', childSource, DIR, join(DIR, 'not-a-grammar.wasm')], {
      env: process.env,
      timeout: 60_000,
      stdio: 'ignore',
      windowsHide: true,
    })
    check('the node audition child CAN die (control on garbage bytes)', control.status !== 0)
  }
}

rmSync(DIR, { recursive: true, force: true })
if (failures > 0) {
  console.error(`\nprove-fragile-quarantine: ${failures} FAILURE(S)`)
  process.exit(1)
}
console.log('\nprove-fragile-quarantine: all green')
