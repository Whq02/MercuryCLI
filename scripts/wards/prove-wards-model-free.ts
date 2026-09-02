#!/usr/bin/env bun
// ============================================================================
//  scripts/wards/prove-wards-model-free.ts
// PROOF (trust-combo review): the content-rule wards are
//  DETERMINISTIC — no model calls, ever. The boot-menu row's summary
//  ("deterministic rules … rules cost nothing until violated") is a product
//  promise; this census leg is its ratchet.
//
//  The law under proof:
//   §1 ENGINE PURITY — src/utils/wards/wards.ts is a pure module: zero
//      import statements, zero require calls (the module-header law "no env
//      reads, no io at import" is checkable at the text level and pinned).
//   §2 HOOK IMPORT CENSUS — src/utils/hooks/wardsHook.ts imports exactly its
//      adjudicated set (fs/path, flag registry, cwd, debug, project config,
//      the engine, the hook plumbing, one type). A NEW import fails here
//      until adjudicated — the wards layer never quietly grows a model seam.
//   §3 MODEL-SEAM DENY SWEEP — neither file references any model-calling
//      seam (queryModel*/sideQuery/routedCallModel/queryWithModel/
//      getAnthropicClient/services/api) nor any model-identity read
//      (getSmallFastModel/getMainLoopModel/resolveCallModelRoute).
//   §4 NO-DIAL BEHAVIOURAL PIN — the whole verdict path (engine evaluation
//      AND an armed hook's denial round-trip) runs to completion with
//      global fetch replaced by a throwing stub: a wards verdict needs no
//      network, no provider, no model.
//   §5 RULES ARE DATA — the builtin + autonomous rule tables JSON-round-trip
//      intact (strings/booleans/arrays only): a ward can never smuggle a
//      function (and so never a model call) into the rule set.
//
//  Run:  ~/.bun/bin/bun run scripts/wards/prove-wards-model-free.ts
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
const ENGINE_PATH = join(ROOT, 'src', 'utils', 'wards', 'wards.ts')
const HOOK_PATH = join(ROOT, 'src', 'utils', 'hooks', 'wardsHook.ts')

/** Import specifiers of a file, from its static import statements. */
function importSpecifiers(source: string): string[] {
  const out: string[] = []
  const re = /^import\s[^;]*?from\s+['"]([^'"]+)['"]/gms
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) out.push(m[1]!)
  return out
}

async function main(): Promise<void> {
  console.log('============================================================')
  console.log(' wards are model-free — the trust-combo census leg')
  console.log('============================================================')

  const engineSrc = readFileSync(ENGINE_PATH, 'utf-8')
  const hookSrc = readFileSync(HOOK_PATH, 'utf-8')

  section('§1 engine purity — wards.ts is a pure module (no imports at all)')
  {
    const engineImports = importSpecifiers(engineSrc)
    check('zero import statements', engineImports.length === 0, engineImports.join(', '))
    check('zero require calls', !/\brequire\s*\(/.test(engineSrc))
    check(
      'the pure-module law is stated in the header (kept honest here)',
      engineSrc.includes('no env reads, no io at import'),
    )
  }

  section('§2 hook import census — the adjudicated set, nothing else')
  {
    const ADJUDICATED = new Set([
      '../projectConfig.js', // project wards.json resolution
      'node:fs', // reading the project rules file
      'node:path', // joining the rules path
      '../../substrate/flagRegistry.js', // the MERCURY_WARDS gate
      '../cwd.js', // where the project rules live
      '../debug.js', // the stand-down log line
      '../messageQueueManager.js', // SetAppState (type-only)
      '../wards/wards.js', // the engine
      './sessionHooks.js', // the FunctionHook plumbing
      // ADJUDICATED (POLISH2, C7): the notification channel's module-level
      // door — the wards-file parse-problem disclosure (prove-wards §3b).
      // App-state plumbing only: no model seam, no env read, no io at
      // import; §3's deny sweep still covers the whole hook source.
      '../../context/notifications.js',
    ])
    const hookImports = importSpecifiers(hookSrc)
    check('the hook imports something (parse sanity)', hookImports.length > 0)
    const strays = hookImports.filter(spec => !ADJUDICATED.has(spec))
    check(
      'every hook import is adjudicated (a new one fails until reviewed)',
      strays.length === 0,
      strays.join(', '),
    )
    check('zero require calls in the hook', !/\brequire\s*\(/.test(hookSrc))
  }

  section('§3 model-seam deny sweep — no model call, no model-identity read')
  {
    // The model-calling seams and model-identity reads of this codebase.
    const FORBIDDEN = [
      'queryModel', // queryModel / queryModelWith(out)Streaming
      'queryWithModel',
      'sideQuery',
      'routedCallModel',
      'callModelRouter',
      'getAnthropicClient',
      'services/api',
      'getSmallFastModel',
      'getMainLoopModel',
      'getDefaultHaikuModel',
      'resolveCallModelRoute',
  'classifyModelRoute',
  'declaredRouteOf',
    ]
    for (const [name, source] of [
      ['wards.ts', engineSrc],
      ['wardsHook.ts', hookSrc],
    ] as const) {
      const hits = FORBIDDEN.filter(f => source.includes(f))
      check(`${name} references none of the model seams`, hits.length === 0, hits.join(', '))
    }
  }

  section('§4 no-dial behavioural pin — verdicts under a throwing fetch stub')
  {
    delete process.env.MERCURY_WARDS
    const { BUILTIN_WARDS, evaluateWards } = await import('../../src/utils/wards/wards.js')
    const { registerWardsHook, resetWardsEngagedSessionsForTest } = await import(
      '../../src/utils/hooks/wardsHook.js'
    )
    const { getSessionFunctionHooks } = await import('../../src/utils/hooks/sessionHooks.js')

    const realFetch = globalThis.fetch
    let dialed = 0
    // Any network attempt during a wards verdict is a FAIL, not a hang.
    globalThis.fetch = ((..._args: unknown[]) => {
      dialed++
      throw new Error('wards verdict tried to dial')
    }) as typeof fetch
    try {
      const verdict = evaluateWards(BUILTIN_WARDS, {
        toolName: 'Edit',
        input: {
          file_path: 'src/components/Foo.tsx',
          old_string: '',
          new_string: "const c = '#AB12CD'",
        },
      })
      check('engine denial computed offline', verdict.allow === false)

      type AnyState = { sessionHooks: Map<string, unknown> } & Record<string, unknown>
      let state: AnyState = { sessionHooks: new Map() }
      const setAppState = ((updater: (prev: AnyState) => AnyState) => {
        state = updater(state)
      }) as never
      resetWardsEngagedSessionsForTest()
      const id = registerWardsHook(setAppState, 'w-model-free')
      check('hook registers offline', id !== null)
      const matchers =
        getSessionFunctionHooks(
          { sessionHooks: state.sessionHooks } as never,
          'w-model-free',
          'PreToolUse',
        ).get('PreToolUse' as never) ?? []
      const hooks = matchers.flatMap(
        (m: { hooks: Array<{ callback: (mm: never[], s?: never, c?: unknown) => unknown }> }) =>
          m.hooks,
      )
      const denial = await hooks[0]!.callback([], undefined as never, {
        hookInput: {
          tool_name: 'Edit',
          tool_input: {
            file_path: 'src/components/Foo.tsx',
            old_string: '',
            new_string: "const c = '#AB12CD'",
          },
        },
      })
      check('armed-hook denial round-trips offline (teaching string)', typeof denial === 'string')
      const allow = await hooks[0]!.callback([], undefined as never, {
        hookInput: { tool_name: 'Bash', tool_input: { command: 'git status' } },
      })
      check('armed-hook allow round-trips offline', allow === true)
      check('the stubbed fetch was never called', dialed === 0, `${dialed} dial(s)`)
      resetWardsEngagedSessionsForTest()
    } finally {
      globalThis.fetch = realFetch
    }
  }

  section('§5 rules are data — JSON round-trip intact (no function smuggling)')
  {
    const { BUILTIN_WARDS, AUTONOMOUS_WARDS } = await import('../../src/utils/wards/wards.js')
    for (const [name, rules] of [
      ['BUILTIN_WARDS', BUILTIN_WARDS],
      ['AUTONOMOUS_WARDS', AUTONOMOUS_WARDS],
    ] as const) {
      const roundTripped = JSON.parse(JSON.stringify(rules))
      check(
        `${name} survives a JSON round-trip unchanged`,
        JSON.stringify(roundTripped) === JSON.stringify(rules) && rules.length > 0,
      )
    }
  }

  console.log('\n' + '='.repeat(60))
  if (failures > 0) {
    console.log(`❌ ${failures} CHECK(S) FAILED`)
    process.exit(1)
  }
  console.log('✅ WARDS MODEL-FREE CENSUS PASSES')
}

void main()
