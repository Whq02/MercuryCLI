#!/usr/bin/env bun
// ============================================================================
//  scripts/model-transition/repro-ctm-r02-entry-loyalty.ts — R02/R03
//  expect-red driver (Rider 2: the entry window is Anthropic-loyal — an
//  operator with only OpenAI credentials cannot enter through the front
//  door, although the OpenAI credential owner is live-qualified in-tree).
//
//  Mechanism under test: first-run entry is owned by MercuryOnboarding/
//  MercurySetupFrame/MercuryLogin routing auth through the Anthropic
//  oauthFlow only. The OpenAI credential store (openaiAccounts.ts,
//  live-qualified) exists but is discovered only behind the MERCURY_ENGINES
//  standing consent — never offered at entry. Rider 2's ratified design:
//  ONE first-run auth moment offering Anthropic login · OpenAI login ·
//  key/env routes over the EXISTING owner flows.
//
//    §A DEFECT: the entry components carry zero OpenAI routing
//    §B the OpenAI credential owner EXISTS (wiring gap, not capability gap)
//    §C the ENGINES consent gate exists and is the ONLY discovery route
//
//  Exit 0 = defect REPRODUCED (the recorded red for R02's before-state).
//  Exit 1 = not reproduced. Not part of the green gate (repro-*, not prove-*).
// ============================================================================
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..', '..')

const { FLAG_REGISTRY } = await import('../../src/substrate/flagRegistry.ts')

let failed = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failed++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ' — ' + detail : ''}`)
}

// §A — the entry window: zero OpenAI offer/routing in the entry components.
for (const file of [
  'src/components/MercuryOnboarding.tsx',
  'src/components/MercurySetupFrame.tsx',
  'src/components/MercuryLogin.tsx',
]) {
  const src = readFileSync(join(ROOT, file), 'utf8')
  check(`§A REPRODUCED: ${file} has zero OpenAI routing`, !/openai/i.test(src))
}

// §B — the OpenAI credential owner is real and owned in-tree: the entry
// loyalty is a WIRING gap, not a capability gap.
check(
  '§B the OpenAI credential owner exists (openaiAccounts.ts)',
  existsSync(join(ROOT, 'src/services/providers/openai/openaiAccounts.ts')),
)

// §C — discovery is gated SOLELY behind the MERCURY_ENGINES standing consent
// (opt-in): the only route to OpenAI credentials today — never the entry
// window. (Rider 2 keeps the double-consent; entry may ARM it, decided at
// the flag owner.)
const engines = FLAG_REGISTRY.find(s => s.env === 'MERCURY_ENGINES')
check(
  '§C the ENGINES standing-consent gate exists and is opt-in',
  engines !== undefined && engines.kind === 'opt-in',
  engines ? `kind=${engines.kind}` : 'row missing',
)

console.log(
  failed === 0
    ? '\n REPRODUCED — R02 red recorded (Anthropic-loyal entry window)'
    : '\n NOT REPRODUCED',
)
process.exit(failed === 0 ? 0 : 1)
