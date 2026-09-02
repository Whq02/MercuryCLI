#!/usr/bin/env bun
// ============================================================================
//  scripts/ink-runtime/prove-sdk-surface.ts — the public
//  SDK surface laws.
//
//    • NO EMPTY STUBS — every module under src/entrypoints/sdk/ exports at
//      least one real binding; a bare `export {}` (the retired toolTypes
//      shape) or an `= any` type alias fails;
//    • the public type entry (agentSdkTypes.ts) resolves — every re-export
//      target exists;
//    • the usage vocabulary stays REAL — NonNullableUsage is the BetaUsage
//      concretization, not `any` (the B8 finding: the `any` stub silently
//      degraded every usage type in the product).
//
//  Run: ~/.bun/bin/bun run scripts/ink-runtime/prove-sdk-surface.ts
// ============================================================================
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')
const SDK = join(ROOT, 'src', 'entrypoints', 'sdk')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}

console.log('bedrock sdk surface — no misleading stubs')

for (const name of readdirSync(SDK).sort()) {
  const src = readFileSync(join(SDK, name), 'utf8')
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const hasRealExport =
    /export\s+(type|interface|const|function|class|enum|declare)\s+\w/.test(stripped) ||
    /export\s+\{\s*\w/.test(stripped) ||
    /export\s+\*\s+from/.test(stripped)
  check(`${name}: exports real bindings`, hasRealExport, 'empty exported module')
  check(
    `${name}: no \`= any\` type alias`,
    !/export\s+type\s+\w+\s*=\s*any\b/.test(stripped),
    'a misleading any-stub',
  )
}

// The public entry's re-export targets must resolve.
{
  const entry = readFileSync(join(ROOT, 'src', 'entrypoints', 'agentSdkTypes.ts'), 'utf8')
  const specs = [...entry.matchAll(/from\s+['"](\.[^'"]+)['"]/g)].map(m => m[1]!)
  for (const spec of specs) {
    const base = join(ROOT, 'src', 'entrypoints', spec.replace(/\.js$/, ''))
    const exists = ['.ts', '.tsx', '.d.ts'].some(ext => {
      try {
        readFileSync(base + ext)
        return true
      } catch {
        return false
      }
    })
    check(`agentSdkTypes target resolves: ${spec}`, exists)
  }
}

// the promoted type surface carries ZERO throwing runtime
// exports. The old shell exported 15 functions whose bodies threw `not
// implemented` — a promoted call path nothing distributes or invokes. The
// executable Agent SDK contract is the stream-json print/headless transport
// (src/cli/print.ts + src/QueryEngine.ts), proven by its own suites; the type
// entry must never re-grow a dead runtime API.
{
  const files = [
    join(ROOT, 'src', 'entrypoints', 'agentSdkTypes.ts'),
    ...readdirSync(SDK).map(n => join(SDK, n)),
  ]
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    // An exported function/class whose body contains a bare
    // `throw new Error('… not implemented …')` (the stub idiom).
    const fnBodies = [...src.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+(\w+)[\s\S]{0,400}?\{([\s\S]{0,300}?)\}/g)]
    const throwing = fnBodies.filter(m => /throw new Error\((?:'|")[^'"]*not implemented/i.test(m[2]!))
    check(
      `${f.slice(ROOT.length + 1)}: zero throwing runtime exports`,
      throwing.length === 0,
      throwing.map(m => m[1]).join(', '),
    )
    // Belt-and-suspenders on the stub idiom itself (catches any body shape
    // the structural regex can't reach — e.g. very long generic signatures).
    check(
      `${f.slice(ROOT.length + 1)}: no 'not implemented' stub throws`,
      !/throw new Error\((?:'|")[^'"]*not implemented/i.test(src),
    )
  }
}

// The usage vocabulary is Mercury-OWNED: a full structural
// declaration — never an `any` stub (the B8 class) and never a provider
// package import leaking through the public surface.
{
  const src = readFileSync(join(SDK, 'coreTypes.ts'), 'utf8')
  check(
    'NonNullableUsage is a structural Mercury declaration (no provider import, no any-stub)',
    !src.includes('@anthropic-ai/') &&
      !/NonNullableUsage\s*=\s*any/.test(src) &&
      src.includes('input_tokens: number') &&
      src.includes('cache_creation_input_tokens: number') &&
      src.includes('output_tokens_details'),
  )
}

if (failures > 0) {
  console.log(`\nbedrock sdk surface: RED (${failures} failure${failures === 1 ? '' : 's'})`)
  process.exit(1)
}
console.log('\nbedrock sdk surface: green')
