#!/usr/bin/env bun
// ============================================================================
//  scripts/dap/prove-trust-family-agnostic.ts
// PROOF (trust-combo review): the Debug tool and the C/C++
//  (clangd) IDE lane are FAMILY-AGNOSTIC by design — their consent and
//  gating paths carry no assumption about which provider family the session
//  rides. The boot-menu TRUST COMBO rows behave identically across all ten
//  routing-law families; this prover is that designed negative, pinned.
//
//  The law under proof:
//   §1 STRUCTURAL CENSUS — the consent/gating owners (DebugTool.ts + its
//      consent UI, dapClient.ts, clangdLane.ts, mercuryLsp.ts,
//      builtinServers.ts) reference no model-identity read and no
//      model-calling seam. A new family reference fails here until
//      adjudicated.
//   §2 CONSENT VERDICTS ARE FAMILY-BLIND — DebugTool.checkPermissions
//      answers byte-identically whatever family the session's model env
//      plants (unset · gpt · glm · kimi): launch/attach/customRequest ask,
//      inspection rides the permitted session.
//   §3 CONSENT COPY NAMES THE OPERATION, NEVER A FAMILY — the ask messages
//      carry program/adapter facts only.
//   §4 GATES ARE FLAG-PURE — isDapToolCatalogEnabled and
//      mercuryLspCppEnabled answer from their registry flags alone,
//      unchanged under every planted family env, and their kill spellings
//      keep working mid-plant.
//
//  Run:  ~/.bun/bin/bun run scripts/dap/prove-trust-family-agnostic.ts
// ============================================================================

// The MACRO stamp MUST precede any src import that reads it.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const ROOT = join(import.meta.dir, '..', '..')

/** The consent/gating owners of the Debug tool + clangd lane trust rows. */
const SWEPT_FILES = [
  'src/tools/DebugTool/DebugTool.ts', // checkPermissions + catalog surface
  'src/tools/DebugTool/UI.tsx', // the consent render
  'src/services/dap/dapClient.ts', // MERCURY_DAP gate + adapter resolution
  'src/services/lsp/clangdLane.ts', // MERCURY_LSP_CPP gate + clangd resolution
  'src/services/lsp/mercuryLsp.ts', // the IDE-hands master gate
  'src/services/lsp/builtinServers.ts', // lane wiring under the bridge
] as const

/** Model-identity reads and model-calling seams — none belong here. */
const FORBIDDEN = [
  'getMainLoopModel',
  'getSmallFastModel',
  'getDefaultHaikuModel',
  'getDefaultSonnetModel',
  'getDefaultOpusModel',
  'resolveCallModelRoute',
  'classifyModelRoute',
  'declaredRouteOf',
  'providerFrontier',
  'callModelRouter',
  'routedCallModel',
  'queryModel',
  'queryWithModel',
  'sideQuery',
  'getAnthropicClient',
  'ANTHROPIC_MODEL',
  'claude-',
  'anthropic',
  'gpt-',
  'glm-',
  'kimi-',
] as const

/** The family envs planted in the behavioural legs. `undefined` = unset. */
const FAMILY_PLANTS: ReadonlyArray<[label: string, model: string | undefined]> = [
  ['no model env (defaults)', undefined],
  ['openai family (gpt-5.6-luna)', 'gpt-5.6-luna'],
  ['zai family (glm-5.3)', 'glm-5.3'],
  ['moonshot family (kimi-k3)', 'kimi-k3'],
]

function withModelEnv<T>(model: string | undefined, fn: () => T): T {
  const saved = process.env.ANTHROPIC_MODEL
  if (model === undefined) delete process.env.ANTHROPIC_MODEL
  else process.env.ANTHROPIC_MODEL = model
  try {
    return fn()
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_MODEL
    else process.env.ANTHROPIC_MODEL = saved
  }
}

async function main(): Promise<void> {
  console.log('============================================================')
  console.log(' Debug tool + clangd lane — family-agnostic consent/gating')
  console.log('============================================================')

  section('§1 structural census — no family reference in the consent/gating owners')
  {
    for (const rel of SWEPT_FILES) {
      const source = readFileSync(join(ROOT, rel), 'utf-8')
      const lowered = source.toLowerCase()
      const hits = FORBIDDEN.filter(f => lowered.includes(f.toLowerCase()))
      check(`${rel} carries none of the family/model seams`, hits.length === 0, hits.join(', '))
    }
  }

  const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.js')
  const { isDapToolCatalogEnabled } = await import('../../src/services/dap/dapClient.js')
  const { mercuryLspCppEnabled } = await import('../../src/services/lsp/clangdLane.js')

  section('§2 consent verdicts are family-blind — byte-identical across plants')
  {
    const CONSENT_INPUTS: ReadonlyArray<[string, Record<string, unknown>]> = [
      ['launch', { op: 'launch', program: '/tmp/app.py', args: ['--x'] }],
      ['attach', { op: 'attach', pid: 4242 }],
      ['customRequest', { op: 'customRequest', method: 'evaluateSpecial', body: '{}' }],
      ['stack (inspection)', { op: 'stack' }],
      ['variables (inspection)', { op: 'variables', ref: 3 }],
    ]
    for (const [label, input] of CONSENT_INPUTS) {
      const verdicts: string[] = []
      for (const [, model] of FAMILY_PLANTS) {
        const verdict = await withModelEnv(model, () =>
          DebugTool.checkPermissions(input as never, {} as never),
        )
        verdicts.push(JSON.stringify(verdict))
      }
      const allIdentical = verdicts.every(v => v === verdicts[0])
      check(`${label}: one verdict across all four plants`, allIdentical, verdicts.join(' vs '))
    }
    const launch = await DebugTool.checkPermissions(
      { op: 'launch', program: '/tmp/app.py' } as never,
      {} as never,
    )
    const stack = await DebugTool.checkPermissions({ op: 'stack' } as never, {} as never)
    check('launch asks', (launch as { behavior?: string }).behavior === 'ask')
    check('inspection allows', (stack as { behavior?: string }).behavior === 'allow')
  }

  section('§3 consent copy names the operation, never a family')
  {
    const asks = [
      await DebugTool.checkPermissions(
        { op: 'launch', program: '/tmp/app.py', adapter: 'python' } as never,
        {} as never,
      ),
      await DebugTool.checkPermissions({ op: 'attach', pid: 7 } as never, {} as never),
      await DebugTool.checkPermissions(
        { op: 'customRequest', method: 'setX' } as never,
        {} as never,
      ),
    ] as Array<{ message?: string }>
    for (const ask of asks) {
      const msg = ask.message ?? ''
      check(
        `ask copy is family-free: "${msg.slice(0, 48)}…"`,
        msg.length > 0 && !/claude|anthropic|gpt-|glm-|kimi|opus|sonnet|haiku|fable/i.test(msg),
      )
    }
  }

  section('§4 gates are flag-pure — unchanged under every planted family env')
  {
    delete process.env.MERCURY_DAP
    delete process.env.MERCURY_LSP
    delete process.env.MERCURY_LSP_CPP
    for (const [label, model] of FAMILY_PLANTS) {
      const dap = withModelEnv(model, () => isDapToolCatalogEnabled())
      const cpp = withModelEnv(model, () => mercuryLspCppEnabled())
      check(`${label}: Debug catalog gate answers true (default-on)`, dap === true)
      check(`${label}: clangd lane gate answers true (default-on)`, cpp === true)
    }
    // The kills keep working while a family env is planted (no coupling).
    process.env.MERCURY_DAP = '0'
    check(
      'MERCURY_DAP=0 kills under a planted family env',
      withModelEnv('glm-5.3', () => isDapToolCatalogEnabled()) === false,
    )
    delete process.env.MERCURY_DAP
    process.env.MERCURY_LSP_CPP = '0'
    check(
      'MERCURY_LSP_CPP=0 kills under a planted family env',
      withModelEnv('gpt-5.6-luna', () => mercuryLspCppEnabled()) === false,
    )
    delete process.env.MERCURY_LSP_CPP
  }

  console.log('\n' + '='.repeat(60))
  if (failures > 0) {
    console.log(`❌ ${failures} CHECK(S) FAILED`)
    process.exit(1)
  }
  console.log('✅ DEBUG TOOL + CLANGD LANE ARE FAMILY-AGNOSTIC')
}

void main()
