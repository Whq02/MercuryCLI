#!/usr/bin/env bun
// ============================================================================
//  scripts/dap/prove-dap-multisession.ts
//  PROOF: the child-session road (DAP startDebugging reverse requests — the
//  js-debug/debugpy parent-child shape) against the deterministic
//  multi-session mock (mock-dap-adapter-multi.mjs). Zero network, zero real
//  debuggers, gate-safe.
//
//  Contract proven here:
//   1. TCP (the js-debug dapDebugServer shape): launch → the adapter's
//      startDebugging reverse request → a child session DIALS THE SAME
//      SERVER PORT with the configuration verbatim → the breakpoint binds in
//      the CHILD (the parent verifies nothing) → stopped routes to the child
//      → stack/scopes/variables/evaluate on the stopped child → continue →
//      the parent's terminated aggregates the tree. runInTerminal and
//      unknown reverse requests answer success:false (typed refusals, never
//      dropped frames).
//   2. The rerun respelling: a clean re-launch runs to completion; a
//      re-launch on a HELD alias replaces the whole tree (old children die).
//   3. Bounds (R2): past the child-count/depth bound, startDebugging answers
//      success:false NAMING the bound and the ring carries the honest
//      refusal line — a refused child is never silent.
//   4. The grandchild road: a child's own startDebugging attaches a
//      grandchild; ops route to the stopped grandchild.
//   5. Ambiguity (R1): multiple live children, none stopped ⇒ debugTarget()
//      answers typed-ambiguous naming the tree — never a silent guess.
//   6. stdio (the debugpy shape): the child is a FRESH adapter process of
//      the same spec; the all-children-terminated arm reports tree
//      termination while the parent process lingers.
//
//  Run:  ~/.bun/bin/bun run scripts/dap/prove-dap-multisession.ts
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
async function waitFor(cond: () => boolean, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (cond()) return true
    await new Promise(res => setTimeout(res, 20))
  }
  return cond()
}
function clearKnobs(): void {
  delete process.env.MOCK_MULTI_CHILDREN
  delete process.env.MOCK_MULTI_PARENT_LINGERS
  delete process.env.MOCK_MULTI_RUNINTERMINAL
  delete process.env.MOCK_MULTI_UNKNOWN_REVERSE
  delete process.env.MOCK_MULTI_GRANDCHILD
  delete process.env.MOCK_MULTI_CHILD_SILENT
  delete process.env.MOCK_MULTI_LAZY_VERIFY
}

async function main(): Promise<void> {
  const MOCK = join(import.meta.dir, 'mock-dap-adapter-multi.mjs')
  process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({
    mockmulti: { command: process.execPath, args: [MOCK, '${port}', '127.0.0.1'], connect: 'tcp' },
    mockmultiStdio: { command: process.execPath, args: [MOCK] },
  })
  delete process.env.MERCURY_DAP

  const {
    createDapSession,
    getDapSession,
    removeDapSession,
    _dapSessionCountForTesting,
    _setDapChildBoundsForTesting,
  } = await import('../../src/services/dap/dapClient.js')
  const { makeOwnerKey } = await import('../../src/services/run/ownerKey.js')
  const OWNER = makeOwnerKey({ workspace: '/tmp/w', sessionId: 'dap-multi-proof', lane: 'main' })

  console.log('============================================================')
  console.log(' DAP child sessions (startDebugging) — proof')
  console.log('============================================================')

  section('1. TCP walk (the js-debug shape): reverse requests + the child loop')
  {
    clearKnobs()
    process.env.MOCK_MULTI_RUNINTERMINAL = '1'
    process.env.MOCK_MULTI_UNKNOWN_REVERSE = '1'
    const root = await createDapSession({
      owner: OWNER,
      id: 'walk',
      adapterKey: 'mockmulti',
      program: '/tmp/demo.js',
      cwd: process.cwd(),
      breakpoints: new Map([['/tmp/demo.js', [3]]]),
    })
    const outcome = await root.waitForStopOutcome(10_000)
    check('stopped outcome carries the stopped SESSION', outcome.state === 'stopped' && outcome.session !== undefined)
    if (outcome.state !== 'stopped' || !outcome.session) {
      check('TCP walk aborted (no stop) — remaining checks skipped', false, JSON.stringify(outcome))
    } else {
      const child = outcome.session
      check('the stop happened in the CHILD, not the root', child !== root, child.label)
      check("child label is the configuration's name", child.label === 'child-1')
      check('stop is breakpoint on thread 11', outcome.info.reason === 'breakpoint' && outcome.info.threadId === 11)
      check('tree size is 2 (root + child)', root.treeSize() === 2)
      const stack = await child.request('stackTrace', { threadId: 11 })
      const frames = stack.stackFrames as Array<{ id?: number; name?: string; line?: number }>
      check('child stack: childMain at demo.js:3 [frameId 210]', frames[0]?.name === 'childMain' && frames[0]?.line === 3 && frames[0]?.id === 210)
      const scopes = await child.request('scopes', { frameId: 210 })
      check('child scopes: Locals ref 300', (scopes.scopes as Array<{ variablesReference?: number }>)[0]?.variablesReference === 300)
      const vars = await child.request('variables', { variablesReference: 300 })
      const a = (vars.variables as Array<{ name?: string; value?: string }>)[0]
      check('child variables: a = 41', a?.name === 'a' && a?.value === '41')
      const evald = await child.request('evaluate', { expression: 'a+b', frameId: 210 })
      check('child evaluate: a+b = 42', evald.result === '42')
      const rootBps = root.breakpoints.get('/tmp/demo.js') ?? []
      check('parent breakpoint UNVERIFIED (a multi-session parent binds nothing)', rootBps[0]?.verified === false)
      const childBps = child.breakpoints.get('/tmp/demo.js') ?? []
      check('child breakpoint VERIFIED (the child is the verifier)', childBps[0]?.verified === true)
      // The execution-plane READ speaks the tree: the root's record derives
      // one child line per live tree member on read (no plane records per
      // child — the session registry is the domain truth).
      const { executionAdapter } = await import('../../src/services/resources/adapters/execution.ts')
      const planeRead = await executionAdapter.resolve(
        { kind: 'execution', id: 'debug:walk', selectors: {}, canonical: 'mercury://execution/debug:walk' } as never,
        { owner: OWNER, cwd: process.cwd() } as never,
      )
      const planeKids = planeRead.state === 'ok' ? (planeRead.resource.children ?? []) : []
      check("the execution-plane read shows a child line under the root (projected on read, stopped state named)", planeKids.some(k => k.title === "child session 'child-1'" && /stopped — breakpoint/.test(k.summary ?? '')), JSON.stringify(planeKids.map(k => k.title)))
      const ring = () => root.output.join('\n')
      check('ring carries the child arrival', ring().includes('[mock] child target-1 up'))
      check('runInTerminal answered success:false (typed refusal)', ring().includes('runInTerminal#1 success=false'))
      check('unknown reverse request answered success:false', ring().includes('mercuryNoSuchReverse#2 success=false') && ring().includes('unsupported reverse request'))
      check('startDebugging answered success:true', ring().includes('startDebugging#3 success=true'))
      child.lastStopped = null
      await child.request('continue', { threadId: 11 })
      check('continue ⇒ the TREE terminates (parent aggregation)', await waitFor(() => root.treeTerminated()))
      check('ring carries the child output', ring().includes('mock-child: done'))
      await removeDapSession(OWNER, 'walk')
      check('dispose reaps the registry entry', getDapSession(OWNER, 'walk') === undefined)
      check('the child died with the tree', child.alive === false)
      // Settled record ⇒ the read derives NO child rows (never a resurrection).
      const settledRead = await executionAdapter.resolve(
        { kind: 'execution', id: 'debug:walk', selectors: {}, canonical: 'mercury://execution/debug:walk' } as never,
        { owner: OWNER, cwd: process.cwd() } as never,
      )
      check('a settled debug record derives no child lines on read', settledRead.state !== 'ok' || !(settledRead.resource.children ?? []).some(k => k.title.startsWith('child session')), settledRead.state)
    }
  }

  section('2. the rerun respelling + tree replacement')
  {
    clearKnobs()
    const clean = await createDapSession({
      owner: OWNER,
      id: 'rerun',
      adapterKey: 'mockmulti',
      program: '/tmp/demo.js',
      cwd: process.cwd(),
    })
    check('clean re-launch runs to completion (tree terminated)', await waitFor(() => clean.treeTerminated()))
    check('ring carries the clean run output', clean.output.join('\n').includes('mock-child: ran'))
    await removeDapSession(OWNER, 'rerun')

    const held = await createDapSession({
      owner: OWNER,
      id: 'rep',
      adapterKey: 'mockmulti',
      program: '/tmp/demo.js',
      cwd: process.cwd(),
      breakpoints: new Map([['/tmp/demo.js', [3]]]),
    })
    const heldStop = await held.waitForStopOutcome(10_000)
    const heldChild = heldStop.state === 'stopped' ? heldStop.session : undefined
    check('held tree stopped in its child', heldChild !== undefined && heldChild !== held)
    const replacement = await createDapSession({
      owner: OWNER,
      id: 'rep',
      adapterKey: 'mockmulti',
      program: '/tmp/demo.js',
      cwd: process.cwd(),
    })
    check('re-launch on the alias replaces the whole tree (old root dead)', held.terminated === true)
    check('…and the old CHILD died with it', heldChild !== undefined && heldChild.terminated === true)
    check('the replacement is registered', getDapSession(OWNER, 'rep') === replacement)
    await removeDapSession(OWNER, 'rep')
  }

  section('2b. runtimeArgs pass-through: on the standard body VERBATIM when given, no key otherwise')
  {
    // Split-grammar adapters (js-debug pwa-node) separate program args from
    // runtime (interpreter) flags — the node-test debug shim rides this.
    clearKnobs()
    const withRt = await createDapSession({
      owner: OWNER,
      id: 'rtargs',
      adapterKey: 'mockmulti',
      program: '/tmp/demo.js',
      cwd: process.cwd(),
      runtimeArgs: ['--test-name-pattern=^adds$'],
    })
    check('runtimeArgs land on the launch body verbatim', await waitFor(() => withRt.output.join('\n').includes('[mock] launch runtimeArgs ["--test-name-pattern=^adds$"]')))
    await removeDapSession(OWNER, 'rtargs')
    const without = await createDapSession({
      owner: OWNER,
      id: 'rtargs-none',
      adapterKey: 'mockmulti',
      program: '/tmp/demo.js',
      cwd: process.cwd(),
    })
    check('no runtimeArgs option ⇒ NO runtimeArgs key on the body (only-when-present)', await waitFor(() => without.treeTerminated()) && !without.output.join('\n').includes('runtimeArgs'))
    await removeDapSession(OWNER, 'rtargs-none')
  }

  section('3. bounds answer typed + ringed (R2)')
  {
    clearKnobs()
    process.env.MOCK_MULTI_CHILDREN = '2'
    _setDapChildBoundsForTesting(1, 4)
    const bounded = await createDapSession({
      owner: OWNER,
      id: 'bound',
      adapterKey: 'mockmulti',
      program: '/tmp/demo.js',
      cwd: process.cwd(),
      breakpoints: new Map([['/tmp/demo.js', [3]]]),
    })
    const ring = () => bounded.output.join('\n')
    check('the second child is refused success:false NAMING the bound', await waitFor(() => ring().includes('startDebugging#2 success=false') && /child-session bound/.test(ring())))
    check('the ring carries the honest refusal line', ring().includes('[dap] refused startDebugging'))
    check('tree size stays at the bound (root + 1 child)', bounded.treeSize() === 2)
    await removeDapSession(OWNER, 'bound')
    _setDapChildBoundsForTesting()

    clearKnobs()
    process.env.MOCK_MULTI_GRANDCHILD = '1'
    _setDapChildBoundsForTesting(16, 1)
    const shallow = await createDapSession({
      owner: OWNER,
      id: 'depth',
      adapterKey: 'mockmulti',
      program: '/tmp/demo.js',
      cwd: process.cwd(),
      breakpoints: new Map([['/tmp/demo.js', [3]]]),
    })
    const dring = () => shallow.output.join('\n')
    check('the grandchild is refused past the depth bound', await waitFor(() => dring().includes('startDebugging#1 success=false') && /depth bound/.test(dring())))
    check('depth refusal rides the ring too', dring().includes('[dap] refused startDebugging'))
    check('tree stayed shallow (root + 1 child)', shallow.treeSize() === 2)
    await removeDapSession(OWNER, 'depth')
    _setDapChildBoundsForTesting()
  }

  section('4. the grandchild road (children of children)')
  {
    clearKnobs()
    process.env.MOCK_MULTI_GRANDCHILD = '1'
    const deep = await createDapSession({
      owner: OWNER,
      id: 'deep',
      adapterKey: 'mockmulti',
      program: '/tmp/demo.js',
      cwd: process.cwd(),
      breakpoints: new Map([['/tmp/demo.js', [3]]]),
    })
    const outcome = await deep.waitForStopOutcome(10_000)
    check('the GRANDCHILD is the stopped session', outcome.state === 'stopped' && outcome.session?.label === 'grandchild')
    check('tree size is 3 (root + child + grandchild)', deep.treeSize() === 3)
    if (outcome.state === 'stopped' && outcome.session) {
      const evald = await outcome.session.request('evaluate', { expression: 'a+b', frameId: 210 })
      check('evaluate routes to the grandchild: a+b = 42', evald.result === '42')
    }
    const legacy = await deep.waitForStop(1_000)
    check('waitForStop (back-compat) sees the tree stop', legacy?.reason === 'breakpoint')
    await removeDapSession(OWNER, 'deep')
  }

  section('5. ambiguity is TYPED, never a silent guess (R1)')
  {
    clearKnobs()
    process.env.MOCK_MULTI_CHILDREN = '2'
    process.env.MOCK_MULTI_CHILD_SILENT = '1'
    const murky = await createDapSession({
      owner: OWNER,
      id: 'murky',
      adapterKey: 'mockmulti',
      program: '/tmp/demo.js',
      cwd: process.cwd(),
    })
    check('both children attached', await waitFor(() => murky.treeSize() === 3))
    const target = murky.debugTarget()
    check('debugTarget answers typed-ambiguous', 'ambiguousDetail' in target)
    if ('ambiguousDetail' in target) {
      check('…naming every tree member', target.ambiguousDetail.includes('child-1') && target.ambiguousDetail.includes('child-2'))
      check('…and refusing to guess', target.ambiguousDetail.includes('refusing to guess'))
    }
    await removeDapSession(OWNER, 'murky')
  }

  section('6. stdio walk (the debugpy shape): a fresh adapter process per child')
  {
    clearKnobs()
    const root = await createDapSession({
      owner: OWNER,
      id: 'stdio',
      adapterKey: 'mockmultiStdio',
      program: '/tmp/demo.js',
      cwd: process.cwd(),
      breakpoints: new Map([['/tmp/demo.js', [3]]]),
    })
    const outcome = await root.waitForStopOutcome(10_000)
    check('stdio child stopped on the breakpoint', outcome.state === 'stopped' && outcome.session?.label === 'child-1')
    check('tree size is 2', root.treeSize() === 2)
    if (outcome.state === 'stopped' && outcome.session) {
      const child = outcome.session
      const evald = await child.request('evaluate', { expression: 'a+b', frameId: 210 })
      check('stdio child evaluate: a+b = 42', evald.result === '42')
      child.lastStopped = null
      await child.request('continue', { threadId: 11 })
      check(
        'all-children-terminated ⇒ tree terminated while the parent LINGERS',
        await waitFor(() => root.treeTerminated() && root.terminated === false),
      )
    }
    await removeDapSession(OWNER, 'stdio')
  }

  section('7. the Debug tool routes the tree (target routing, fan-out, status)')
  {
    clearKnobs()
    const { DebugTool } = await import('../../src/tools/DebugTool/DebugTool.js')
    const call = async (input: Record<string, unknown>): Promise<string> =>
      ((await DebugTool.call(input as never, {} as never)) as { data: { result: string } }).data.result
    const launch = await call({ op: 'launch', adapter: 'mockmulti', program: '/tmp/demo.js', file: '/tmp/demo.js', lines: [3] })
    check("tool launch reports the stop IN the child", /stopped in 'child-1' — reason breakpoint/.test(launch), launch.split('\n')[0])
    check('tool launch breakpoint note is the MERGED truth naming the verifier', launch.includes('line 3 verified by child-1'))
    const stack = await call({ op: 'stack' })
    check('tool stack routes to the stopped child', stack.includes('#0 childMain'))
    const evald = await call({ op: 'evaluate', expression: 'a+b', frameId: 210 })
    check('tool evaluate routes to the child: 42', evald.includes('42'))
    const bps = await call({ op: 'breakpoints', file: '/tmp/demo.js', lines: [3, 9] })
    check('tool breakpoints fan tree-wide, verified by the child', bps.includes('line 9: verified by child-1'), bps)
    const status = await call({ op: 'status' })
    check('tool status paints the tree', status.includes("child 'child-1': stopped"), status)
    const cont = await call({ op: 'continue' })
    check('tool continue reports tree termination', cont.includes('debuggee terminated'))
    const disc = await call({ op: 'disconnect' })
    check('tool disconnect reaps the tree', disc.includes('disconnected'))

    // R1 through the TOOL: two silent children, none stopped ⇒ a debuggee-
    // facing op answers typed-ambiguous naming the tree — never a guess.
    process.env.MOCK_MULTI_CHILDREN = '2'
    process.env.MOCK_MULTI_CHILD_SILENT = '1'
    await call({ op: 'launch', adapter: 'mockmulti', program: '/tmp/demo.js' })
    let seenBoth = false
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline && !seenBoth) {
      seenBoth = (await call({ op: 'status' })).includes("child 'child-2'")
      if (!seenBoth) await new Promise(res => setTimeout(res, 25))
    }
    check('both silent children visible in tool status', seenBoth)
    const murkyThreads = await call({ op: 'threads' })
    check(
      'tool op answers TYPED-AMBIGUOUS naming the tree (R1)',
      murkyThreads.includes('refusing to guess a target') && murkyThreads.includes('child-1') && murkyThreads.includes('child-2'),
      murkyThreads,
    )
    await call({ op: 'disconnect' })
  }

  section('8. lazy verifiers: breakpoint-changed events fold into the map')
  {
    clearKnobs()
    process.env.MOCK_MULTI_LAZY_VERIFY = '1'
    const lazy = await createDapSession({
      owner: OWNER,
      id: 'lazy',
      adapterKey: 'mockmulti',
      program: '/tmp/demo.js',
      cwd: process.cwd(),
      breakpoints: new Map([['/tmp/demo.js', [3]]]),
    })
    const outcome = await lazy.waitForStopOutcome(10_000)
    check('the lazy child still stops on the breakpoint', outcome.state === 'stopped' && outcome.session?.label === 'child-1')
    if (outcome.state === 'stopped' && outcome.session) {
      const rows = outcome.session.breakpoints.get('/tmp/demo.js') ?? []
      check(
        'the UNVERIFIED response was flipped by the breakpoint-changed event (id join)',
        rows[0]?.verified === true && rows[0]?.id === 703,
        JSON.stringify(rows),
      )
      const merged = lazy.treeVerifiedBreakpoints().get('/tmp/demo.js') ?? []
      check('…and the merged tree truth carries it with the verifier named', merged[0]?.verified === true && merged[0]?.verifier === 'child-1')
    }
    await removeDapSession(OWNER, 'lazy')
  }

  section('9. the resolver ladder + the retired-PARTIAL honesty (re-cut WITH reason)')
  {
    clearKnobs()
    const { resolveJsDebugServer, jsDebugSourceLabel } = await import('../../src/services/dap/dapClient.js')
    const savedPin = process.env.MERCURY_JS_DEBUG_DAP
    process.env.MERCURY_JS_DEBUG_DAP = MOCK
    const pinned = resolveJsDebugServer()
    check('env override is the exclusive top rung', pinned?.source === 'env-override' && pinned.path === MOCK)
    process.env.MERCURY_JS_DEBUG_DAP = '/nonexistent/dapDebugServer.js'
    check('a pinned-but-missing file refuses honestly (no silent substitute)', resolveJsDebugServer() === null)
    if (savedPin === undefined) delete process.env.MERCURY_JS_DEBUG_DAP
    else process.env.MERCURY_JS_DEBUG_DAP = savedPin
    check('rung labels are the one human spelling', jsDebugSourceLabel('vendored') === 'the vendored bundle' && jsDebugSourceLabel('user-dir') === 'the ~/.js-debug unpack')

    const { readFileSync } = await import('node:fs')
    const src = (...p: string[]) => readFileSync(join(import.meta.dir, '..', '..', 'src', ...p), 'utf-8')
    const readiness = src('utils', 'readiness.ts')
    check(
      "the PARTIAL honesty is RETIRED from the js row (its reason closed: the child road landed)",
      !readiness.includes('PARTIAL: js-debug is a multi-session debugger'),
    )
    check(
      // RE-TRUED for FC-105: 'is live' was a liveness claim resolution never
      // earned — the row now speaks resolution and points at the deep boot
      // probe; provenance stays.
      'the js row speaks multi-session + provenance, with liveness left to the deep probe',
      readiness.includes('multi-session (resolution only; doctor --deep boots it)') &&
        readiness.includes('MERCURY_JS_DEBUG_DAP > vendored bundle > ~/.js-debug'),
    )
    check(
      'the dapClient ladder resolves the vendored bundle between the override and the unpack',
      src('services', 'dap', 'dapClient.ts').includes("path.resolve(__dapDirname, 'vendor', 'js-debug', 'src', 'dapDebugServer.js')"),
    )
    check(
      'the flag registry row names the ladder',
      src('substrate', 'flagRegistry.ts').includes('env override > the vendored dist/vendor/js-debug bundle > the legacy ~/.js-debug unpack'),
    )
  }

  clearKnobs()
  check('no sessions leak', _dapSessionCountForTesting() === 0)

  console.log('\n' + '='.repeat(60))
  if (failures > 0) {
    console.log(`❌ ${failures} CHECK(S) FAILED`)
    process.exit(1)
  }
  console.log('✅ ALL DAP CHILD-SESSION PROOFS PASS')
  process.exit(0)
}

void main()
