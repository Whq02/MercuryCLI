#!/usr/bin/env bun
// ============================================================================
//  scripts/dap/prove-dap.ts
//  PROOF: the DAP debugger (MERCURY_DAP — IDE-hands phase 2): client protocol
//  engine, session registry, the Debug tool surface, and catalog wiring —
//  all against the deterministic mock adapter (mock-dap-adapter.mjs), zero
//  network, zero real debuggers, gate-safe.
//
//  Contract proven here:
//   1. GATE — fork+unset ⇒ catalog-enabled; =0 ⇒ disabled; bare-stamp ⇒
//      disabled. resolveAdapter: builtin python/lldb present, env-table
//      override wins, unknown ⇒ null (named keys in the error).
//   2. CLIENT E2E — the full debugging loop against the mock: launch with
//      breakpoints → stopped(breakpoint, thread 1) → threads → stackTrace →
//      scopes → variables (x=41) → evaluate (x+1 = 42) → continue →
//      terminated → dispose reaps. Dead-session requests reject.
//   3. TOOL — name/permission/readonly matrix (launch asks, inspects don't),
//      validateInput failures, status with no session is friendly, and the
//      SAME loop through the tool's call() surface end-to-end.
//   4. WIRING — tools.ts registers via isDapToolCatalogEnabled; the registry
//      carries MERCURY_DAP + MERCURY_DAP_ADAPTERS rows.
//
//  Run:  ~/.bun/bin/bun run scripts/dap/prove-dap.ts
// ============================================================================

// The MACRO stamp MUST precede any src import that reads it.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

async function main(): Promise<void> {
  const MOCK = join(import.meta.dir, 'mock-dap-adapter.mjs')
  process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({
    mock: { command: process.execPath, args: [MOCK] },
  })
  delete process.env.MERCURY_DAP

  const {
    isDapToolCatalogEnabled,
    mercuryDapEnabled,
    resolveAdapter,
    knownAdapterKeys,
    createDapSession,
    getDapSession,
    removeDapSession,
  } = await import('../../src/services/dap/dapClient.js')
  const { makeOwnerKey } = await import('../../src/services/run/ownerKey.js')
  const OWNER = makeOwnerKey({ workspace: '/tmp/w', sessionId: 'dap-proof', lane: 'main' })
  const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.js')

  console.log('============================================================')
  console.log(' DAP debugger (MERCURY_DAP) — proof')
  console.log('============================================================')

  section('1. gate + adapter resolution')
  {
    check('unset ⇒ enabled', mercuryDapEnabled() === true && isDapToolCatalogEnabled() === true)
    process.env.MERCURY_DAP = '0'
    check('=0 ⇒ catalog disabled', isDapToolCatalogEnabled() === false)
    delete process.env.MERCURY_DAP
    const macroKey = 'MACRO'
    const saved = (globalThis as Record<string, unknown>)[macroKey]
    ;(globalThis as Record<string, unknown>)[macroKey] = { VERSION: '0.0.0-src' }
    // the surface is stamp-independent.
    check('bare stamp ⇒ catalog STILL enabled (stamp-independence)', isDapToolCatalogEnabled() === true)
    ;(globalThis as Record<string, unknown>)[macroKey] = saved
    // The python row rides the debugpy resolver — the command
    // is the health-probed interpreter (machine-dependent), the args are the
    // vendored adapter DIRECTORY or the installed-module invocation; an
    // unavailable machine still resolves a spec (with the preflight refusal).
    const pySpec = resolveAdapter('python')
    check(
      'builtin python adapter resolves (vendored-dir or module invocation)',
      pySpec !== null &&
        typeof pySpec.command === 'string' &&
        (pySpec.args.join(' ').includes('debugpy.adapter') || (pySpec.args[0] ?? '').endsWith('/debugpy/adapter')),
      pySpec ? `${pySpec.command} ${pySpec.args.join(' ')}` : 'null',
    )
    // The command is 'lldb-dap' bare (unresolved box) or the shared
    // resolver's absolute path (PATH or darwin xcrun) — pin the shape, not
    // one box's resolution.
    check('builtin lldb adapter resolves', /lldb-dap(\.exe)?$/.test(resolveAdapter('lldb')?.command ?? ''))
    check('env-table adapter resolves (mock)', resolveAdapter('mock')?.command === process.execPath)
    check('unknown adapter ⇒ null', resolveAdapter('nope') === null)
    check('known keys include builtins + env', ['lldb', 'mock', 'python'].every(k => knownAdapterKeys().includes(k)))
  }

  section('2. client E2E vs the mock adapter')
  {
    const session = await createDapSession({
      owner: OWNER,
      id: 'proof',
      adapterKey: 'mock',
      program: '/tmp/demo.py',
      cwd: process.cwd(),
      breakpoints: new Map([['/tmp/demo.py', [3]]]),
    })
    check('session registered', getDapSession(OWNER, 'proof') === session)
    const stopped = await session.waitForStop(5_000)
    check('stopped on breakpoint, thread 1', stopped?.reason === 'breakpoint' && stopped.threadId === 1)
    const threads = await session.request('threads')
    check(
      'threads: MainThread',
      Array.isArray(threads.threads) && (threads.threads as Array<{ name?: string }>)[0]?.name === 'MainThread',
    )
    const stack = await session.request('stackTrace', { threadId: 1 })
    const frames = stack.stackFrames as Array<{ name?: string; line?: number }>
    check('stack: main at demo.py:3', frames[0]?.name === 'main' && frames[0]?.line === 3)
    const scopes = await session.request('scopes', { frameId: 1000 })
    const ref = (scopes.scopes as Array<{ variablesReference?: number }>)[0]?.variablesReference
    check('scopes: Locals ref 100', ref === 100)
    const vars = await session.request('variables', { variablesReference: 100 })
    const x = (vars.variables as Array<{ name?: string; value?: string }>)[0]
    check('variables: x = 41', x?.name === 'x' && x?.value === '41')
    const evald = await session.request('evaluate', { expression: 'x+1', frameId: 1000 })
    check('evaluate: x+1 = 42', evald.result === '42')
    session.lastStopped = null
    await session.request('continue', { threadId: 1 })
    const deadline = Date.now() + 5_000
    while (!session.terminated && Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 20))
    }
    check('continue ⇒ debuggee terminated', session.terminated === true)
    check('output ring captured program output', session.output.some(l => l.includes('mock: started')))
    await removeDapSession(OWNER, 'proof')
    check('dispose reaps the registry entry', getDapSession(OWNER, 'proof') === undefined)
    let rejected = false
    try {
      await session.request('threads')
    } catch {
      rejected = true
    }
    check('dead-session request rejects', rejected)
    let unknownErr = ''
    try {
      await createDapSession({ owner: OWNER, id: 'x', adapterKey: 'nope', program: 'p', cwd: process.cwd() })
    } catch (e) {
      unknownErr = (e as Error).message
    }
    check('unknown adapter names the known keys', unknownErr.includes('mock') && unknownErr.includes('python'))
  }

  section('3. the Debug tool surface')
  {
    check('tool name is Debug', DebugTool.name === 'Debug')
    check('inspect ops are read-only', DebugTool.isReadOnly({ op: 'stack' } as never) === true)
    check('launch is NOT read-only', DebugTool.isReadOnly({ op: 'launch' } as never) === false)
    const perm = await DebugTool.checkPermissions(
      { op: 'launch', program: '/tmp/demo.py' } as never,
      {} as never,
    )
    check('launch ⇒ permission ask', perm.behavior === 'ask')
    const permStack = await DebugTool.checkPermissions({ op: 'stack' } as never, {} as never)
    check('stack ⇒ allow (rides the session)', permStack.behavior === 'allow')
    const bad = await DebugTool.validateInput?.({ op: 'launch' } as never, {} as never)
    check('validateInput: launch without program fails', bad?.result === false)
    const noSession = (await DebugTool.call({ op: 'status' } as never, {} as never)) as {
      data: { result: string }
    }
    check('status with no sessions is friendly', noSession.data.result.includes('no debug sessions'))

    // The SAME loop through the tool surface, end to end.
    const launch = (await DebugTool.call(
      { op: 'launch', adapter: 'mock', program: '/tmp/demo.py', file: '/tmp/demo.py', lines: [3] } as never,
      {} as never,
    )) as { data: { result: string } }
    check('tool launch reports the first stop + stack', /stopped — reason breakpoint/.test(launch.data.result) && /#0 main/.test(launch.data.result), launch.data.result.split('\n')[0])
    const evalOut = (await DebugTool.call(
      { op: 'evaluate', expression: 'x+1', frameId: 1000 } as never,
      {} as never,
    )) as { data: { result: string } }
    check('tool evaluate: x+1 = 42', evalOut.data.result.includes('42'))
    const status = (await DebugTool.call({ op: 'status' } as never, {} as never)) as {
      data: { result: string }
    }
    check('tool status shows the stopped session + breakpoints', status.data.result.includes("session 'main'") && status.data.result.includes('breakpoints:'))
    const disc = (await DebugTool.call({ op: 'disconnect' } as never, {} as never)) as {
      data: { result: string }
    }
    check('tool disconnect reaps', disc.data.result.includes('disconnected'))
  }

  section('4. wiring — catalog + registry')
  {
    const { readFileSync } = await import('node:fs')
    const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')
    check('tools.ts gates the Debug tool on isDapToolCatalogEnabled', src('tools.ts').includes('isDapToolCatalogEnabled() ? [DebugTool] : []'))
    const registry = src('substrate', 'flagRegistry.ts')
    check('registry carries MERCURY_DAP', registry.includes("env: 'MERCURY_DAP'"))
    check('registry carries MERCURY_DAP_ADAPTERS', registry.includes("env: 'MERCURY_DAP_ADAPTERS'"))
  }

  console.log('\n' + '='.repeat(60))
  if (failures > 0) {
    console.log(`❌ ${failures} CHECK(S) FAILED`)
    process.exit(1)
  }
  console.log('✅ ALL DAP PROOFS PASS')
  process.exit(0)
}

void main()
