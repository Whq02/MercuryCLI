#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }


let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${cond ? (detail ? ` — ${detail}` : '') : ` — ${detail ? `${detail}; ` : ''}to fix: the ward verdict must stay a pure local computation in evaluateWards and the rule lists in src/permissions/wards/wards.ts, and registerWardsGuard in src/permissions/guards/wardsGuard.ts must judge without a network call or a function inside a rule`}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}


async function main(): Promise<void> {
  console.log('============================================================')
  console.log(' wards are model-free — the trust-combo census leg')
  console.log('============================================================')



  section('§4 no-dial behavioural pin — verdicts under a throwing fetch stub')
  {
    delete process.env.MERCURY_WARDS
    const { BUILTIN_WARDS, evaluateWards } = await import('../../src/permissions/wards/wards.js')
    const { registerWardsGuard, resetWardsEngagedSessionsForTest } = await import(
      '../../src/permissions/guards/wardsGuard.js'
    )
    const { judgeToolCall } = await import('../../src/permissions/guards/guards.js')

    const realFetch = globalThis.fetch
    let dialed = 0
    globalThis.fetch = ((..._args: unknown[]) => {
      dialed++
      throw new Error('wards verdict tried to dial')
    }) as typeof fetch
    try {
      const verdict = evaluateWards(BUILTIN_WARDS, {
        toolName: 'Edit',
        isMercurySource: () => true,
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
      const id = registerWardsGuard(setAppState, 'w-model-free')
      check('hook registers offline', id !== null)
      const denial = await judgeToolCall('w-model-free', {
        tool: 'Edit',
        input: {
          file_path: 'src/components/Foo.tsx',
          old_string: '',
          new_string: "const c = '#AB12CD'",
        },
        callId: 'model-free-edit',
        messages: [],
      })
      check('armed-hook denial round-trips offline (teaching string)', denial.refused && typeof denial.reason === 'string')
      const allow = await judgeToolCall('w-model-free', { tool: 'Bash', input: { command: 'git status' }, callId: 'model-free-bash', messages: [] })
      check('armed-hook allow round-trips offline', allow.refused === false)
      const spelled = await judgeToolCall('w-model-free', { tool: 'Bash', input: { command: 'env -u X "sudo" true' }, callId: 'model-free-spelled', messages: [], toolRef: { name: 'Bash', shellCommandOf: (value: Record<string, unknown>) => (typeof value.command === 'string' ? value.command : undefined) } as never })
      check('a refusal the parsed judge alone reads round-trips offline', spelled.refused && spelled.reason.includes("Ward 'no-sudo'"), spelled.refused ? spelled.reason.slice(0, 120) : 'allowed')
      check('the stubbed fetch was never called', dialed === 0, `${dialed} dial(s)`)
      resetWardsEngagedSessionsForTest()
    } finally {
      globalThis.fetch = realFetch
    }
  }

  section('§5 rules are data — JSON round-trip intact (no function smuggling)')
  {
    const { BUILTIN_WARDS, AUTONOMOUS_WARDS, REFUSAL_WARDS } = await import('../../src/permissions/wards/wards.js')
    for (const [name, rules] of [
      ['BUILTIN_WARDS', BUILTIN_WARDS],
      ['AUTONOMOUS_WARDS', AUTONOMOUS_WARDS],
      ['REFUSAL_WARDS', REFUSAL_WARDS],
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
