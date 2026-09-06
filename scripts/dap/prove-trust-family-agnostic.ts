#!/usr/bin/env bun

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

const SWEPT_FILES = [
  'src/tools/DebugTool/DebugTool.ts',
  'src/tools/DebugTool/UI.tsx',
  'src/services/dap/dapClient.ts',
  'src/services/lsp/clangdLane.ts',
  'src/services/lsp/mercuryLsp.ts',
  'src/services/lsp/builtinServers.ts',
] as const

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
  'MERCURY_MODEL',
  'claude-',
  'anthropic',
  'gpt-',
  'glm-',
  'kimi-',
] as const

const FAMILY_PLANTS: ReadonlyArray<[label: string, model: string | undefined]> = [
  ['no model env (defaults)', undefined],
  ['openai family (gpt-5.6-luna)', 'gpt-5.6-luna'],
  ['zai family (glm-5.3)', 'glm-5.3'],
  ['moonshot family (kimi-k3)', 'kimi-k3'],
]

function withModelEnv<T>(model: string | undefined, fn: () => T): T {
  const saved = process.env.MERCURY_MODEL
  if (model === undefined) delete process.env.MERCURY_MODEL
  else process.env.MERCURY_MODEL = model
  try {
    return fn()
  } finally {
    if (saved === undefined) delete process.env.MERCURY_MODEL
    else process.env.MERCURY_MODEL = saved
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
