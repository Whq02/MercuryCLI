#!/usr/bin/env bun

;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { join } from 'node:path'

let failures = 0
function check(label: string, cond: boolean, detail = '', fixHint = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}${!cond && fixHint ? ` — change: ${fixHint}` : ''}`)
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
  } = await import('../../src/integrations/debugger/dapClient.js')
  const { makeOwnerKey } = await import('../../src/engine/run-owner/ownerKey.js')
  const OWNER = makeOwnerKey({ workspace: '/tmp/w', sessionId: 'dap-proof', lane: 'main' })
  const { DebugTool } = await import('../../src/tools/debug/DebugTool.js')

  console.log('============================================================')
  console.log(' DAP debugger (MERCURY_DAP) — proof')
  console.log('============================================================')

  section('1. gate + adapter resolution')
  {
    check('unset ⇒ enabled', mercuryDapEnabled() === true && isDapToolCatalogEnabled() === true, '', 'mercuryDapEnabled and isDapToolCatalogEnabled in src/integrations/debugger/client/adapters.ts must return true when MERCURY_DAP is unset')
    process.env.MERCURY_DAP = '0'
    check('=0 ⇒ catalog disabled', isDapToolCatalogEnabled() === false, '', 'isDapToolCatalogEnabled in src/integrations/debugger/client/adapters.ts must return false when MERCURY_DAP=0')
    delete process.env.MERCURY_DAP
    const macroKey = 'MACRO'
    const saved = (globalThis as Record<string, unknown>)[macroKey]
    ;(globalThis as Record<string, unknown>)[macroKey] = { VERSION: '0.0.0-src' }
    check('bare stamp ⇒ catalog STILL enabled (stamp-independence)', isDapToolCatalogEnabled() === true, '', 'isDapToolCatalogEnabled in src/integrations/debugger/client/adapters.ts must not read the MACRO build stamp')
    ;(globalThis as Record<string, unknown>)[macroKey] = saved
    const pySpec = resolveAdapter('python')
    check(
      'builtin python adapter resolves (vendored-dir or module invocation)',
      pySpec !== null &&
        typeof pySpec.command === 'string' &&
        (pySpec.args.join(' ').includes('debugpy.adapter') || (pySpec.args[0] ?? '').endsWith('/debugpy/adapter')),
      pySpec ? `${pySpec.command} ${pySpec.args.join(' ')}` : 'null',
      'resolveAdapter for the python key in src/integrations/debugger/client/adapters.ts must return a debugpy.adapter module call or a vendored debugpy/adapter command',
    )
    check('builtin lldb adapter resolves', /lldb-dap(\.exe)?$/.test(resolveAdapter('lldb')?.command ?? ''), '', 'resolveAdapter for the lldb key in src/integrations/debugger/client/adapters.ts must return a command ending in lldb-dap')
    check('env-table adapter resolves (mock)', resolveAdapter('mock')?.command === process.execPath, '', 'resolveAdapter in src/integrations/debugger/client/adapters.ts must read the MERCURY_DAP_ADAPTERS JSON table')
    check('unknown adapter ⇒ null', resolveAdapter('nope') === null, '', 'resolveAdapter in src/integrations/debugger/client/adapters.ts must return null for a key that is neither builtin nor in MERCURY_DAP_ADAPTERS')
    check('known keys include builtins + env', ['lldb', 'mock', 'python'].every(k => knownAdapterKeys().includes(k)), '', 'knownAdapterKeys in src/integrations/debugger/client/adapters.ts must list the builtin keys plus the MERCURY_DAP_ADAPTERS keys')
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
    check('session registered', getDapSession(OWNER, 'proof') === session, '', 'createDapSession in src/integrations/debugger/dapClient.ts must register the session under its owner and id')
    const stopped = await session.waitForStop(5_000)
    check('stopped on breakpoint, thread 1', stopped?.reason === 'breakpoint' && stopped.threadId === 1, '', 'createDapSession in src/integrations/debugger/dapClient.ts must send the breakpoints map to the adapter, and waitForStop in src/integrations/debugger/client/stops.ts must return the stopped event (adapter: scripts/dap/mock-dap-adapter.mjs)')
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
    check('continue ⇒ debuggee terminated', session.terminated === true, '', 'the DapSession in src/integrations/debugger/dapClient.ts must set terminated when the adapter sends its terminated event after continue')
    check('output ring captured program output', session.output.some(l => l.includes('mock: started')), '', 'the DapSession in src/integrations/debugger/dapClient.ts must push adapter output events into its output ring')
    await removeDapSession(OWNER, 'proof')
    check('dispose reaps the registry entry', getDapSession(OWNER, 'proof') === undefined, '', 'removeDapSession in src/integrations/debugger/dapClient.ts must delete the registry entry')
    let rejected = false
    try {
      await session.request('threads')
    } catch {
      rejected = true
    }
    check('dead-session request rejects', rejected, '', 'DapSession.request in src/integrations/debugger/dapClient.ts must reject once the session is disposed')
    let unknownErr = ''
    try {
      await createDapSession({ owner: OWNER, id: 'x', adapterKey: 'nope', program: 'p', cwd: process.cwd() })
    } catch (e) {
      unknownErr = (e as Error).message
    }
    check('unknown adapter names the known keys', unknownErr.includes('mock') && unknownErr.includes('python'), '', 'createDapSession in src/integrations/debugger/dapClient.ts must put the known adapter keys in its unknown-adapter error')
  }

  section('3. the Debug tool surface')
  {
    check('tool name is Debug', DebugTool.name === 'Debug', '', 'the name field in src/tools/debug/DebugTool.ts must be Debug')
    check('inspect ops are read-only', DebugTool.isReadOnly({ op: 'stack' } as never) === true, '', 'isReadOnly in src/tools/debug/DebugTool.ts must be true for inspect ops such as stack')
    check('launch is NOT read-only', DebugTool.isReadOnly({ op: 'launch' } as never) === false, '', 'isReadOnly in src/tools/debug/DebugTool.ts must be false for the launch op')
    const perm = await DebugTool.checkPermissions(
      { op: 'launch', program: '/tmp/demo.py' } as never,
      {} as never,
    )
    check('launch ⇒ needs approval (the engine resolves it to a card)', perm.behavior === 'passthrough', '', 'checkPermissions in src/tools/debug/DebugTool.ts must return passthrough for the launch op')
    const permStack = await DebugTool.checkPermissions({ op: 'stack' } as never, {} as never)
    check('stack ⇒ allow (rides the session)', permStack.behavior === 'allow', '', 'checkPermissions in src/tools/debug/DebugTool.ts must return allow for the stack op')
    const bad = await DebugTool.validateInput?.({ op: 'launch' } as never, {} as never)
    check('validateInput: launch without program fails', bad?.result === false, '', 'validateInput in src/tools/debug/DebugTool.ts must reject a launch op that has no program')
    const noSession = (await DebugTool.call({ op: 'status' } as never, {} as never)) as {
      data: { result: string }
    }
    check('status with no sessions is friendly', noSession.data.result.includes('no debug sessions'), '', 'the status op in src/tools/debug/DebugTool.ts must say there are no debug sessions when none exist')

    const launch = (await DebugTool.call(
      { op: 'launch', adapter: 'mock', program: '/tmp/demo.py', file: '/tmp/demo.py', lines: [3] } as never,
      {} as never,
    )) as { data: { result: string } }
    check('tool launch reports the first stop + stack', /stopped — reason breakpoint/.test(launch.data.result) && /#0 main/.test(launch.data.result), launch.data.result.split('\n')[0], 'the launch op in src/tools/debug/DebugTool.ts must report the first stop reason and a #0 stack frame')
    const evalOut = (await DebugTool.call(
      { op: 'evaluate', expression: 'x+1', frameId: 1000 } as never,
      {} as never,
    )) as { data: { result: string } }
    check('tool evaluate: x+1 = 42', evalOut.data.result.includes('42'), '', 'the evaluate op in src/tools/debug/DebugTool.ts must return the adapter evaluate result')
    const status = (await DebugTool.call({ op: 'status' } as never, {} as never)) as {
      data: { result: string }
    }
    check('tool status shows the stopped session + breakpoints', status.data.result.includes("session 'main'") && status.data.result.includes('breakpoints:'), '', 'the status op in src/tools/debug/DebugTool.ts must list each live session and its breakpoints')
    const disc = (await DebugTool.call({ op: 'disconnect' } as never, {} as never)) as {
      data: { result: string }
    }
    check('tool disconnect reaps', disc.data.result.includes('disconnected'), '', 'the disconnect op in src/tools/debug/DebugTool.ts must report disconnected and reap the session')
  }

  section('4. wiring — catalog + registry')
  {
    const { getFlagSpec } = await import('../../src/platform/substrate/flagRegistry.js')
    check('registry carries MERCURY_DAP', getFlagSpec('MERCURY_DAP') !== undefined, '', 'register the MERCURY_DAP flag in FLAG_REGISTRY')
    check('registry carries MERCURY_DAP_ADAPTERS', getFlagSpec('MERCURY_DAP_ADAPTERS') !== undefined, '', 'register the MERCURY_DAP_ADAPTERS flag in FLAG_REGISTRY')
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
