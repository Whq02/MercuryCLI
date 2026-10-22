#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')

let failures = 0
function check(label: string, cond: boolean, detail = ''): void {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond && detail ? ` — ${detail}` : ''}`)
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}
const guard = setTimeout(() => {
  console.log('\nTIMEOUT — evaluate-context proof exceeded 90s')
  process.exit(1)
}, 90_000)
guard.unref?.()

type Call = { data: { result: string; outcome: string; debuggee?: string }; effect: { details?: Record<string, unknown> } }

async function main(): Promise<void> {
  const MOCK = join(import.meta.dir, 'mock-dap-adapter.mjs')
  const FILE = '/tmp/demo.py'
  process.env.MERCURY_DAP_ADAPTERS = JSON.stringify({ mock: { command: process.execPath, args: [MOCK] } })
  delete process.env.MERCURY_DAP
  delete process.env.MOCK_DAP_REFUSE_BREAKPOINTS
  delete process.env.MOCK_DAP_BREAKPOINT_DELAY_MS

  const { getDapSession, _dapSessionCountForTesting } = await import(join(SRC, 'services/dap/dapClient.ts'))
  const { DebugTool } = await import(join(SRC, 'tools/DebugTool/DebugTool.ts'))
  const { getDebugToolDescription } = await import(join(SRC, 'tools/DebugTool/prompt.ts'))
  const { processMainOwner } = await import(join(SRC, 'services/run/resolveOwner.ts'))
  const owner = processMainOwner()
  const call = async (input: Record<string, unknown>): Promise<Call> =>
    (await DebugTool.call(input as never, { owner } as never)) as Call
  const lastEvaluate = async (session = 'main'): Promise<Record<string, unknown>> => {
    const s = getDapSession(owner, session)
    if (!s) return {}
    const body = (await s.request('mock/lastEvaluate')) as { lastEvaluate?: Record<string, unknown> }
    return body.lastEvaluate ?? {}
  }

  console.log('============================================================')
  console.log(' Debug tool: evaluate with context, default frame, expandable reference — proof')
  console.log('============================================================')

  section('S  the schema: context is one of five words, nothing else')
  {
    const schema = DebugTool.inputSchema as { safeParse: (v: unknown) => { success: boolean } }
    for (const context of ['repl', 'watch', 'hover', 'clipboard', 'variables']) {
      check(`context "${context}" is accepted`, schema.safeParse({ op: 'evaluate', expression: 'x', context }).success === true)
    }
    check('an unknown context is refused', schema.safeParse({ op: 'evaluate', expression: 'x', context: 'nope' }).success === false)
    check('context is optional', schema.safeParse({ op: 'evaluate', expression: 'x' }).success === true)
  }

  section('E1 stopped, no frameId: the top frame of the stopped thread, a reference back')
  {
    const launch = await call({ op: 'launch', adapter: 'mock', program: FILE, file: FILE, lines: [3] })
    check('launch stops on the breakpoint', /stopped — reason breakpoint/.test(launch.data.result), launch.data.result.split('\n')[0])
    const obj = await call({ op: 'evaluate', expression: 'obj' })
    check('evaluate without frameId succeeds while stopped', obj.data.outcome === 'succeeded' && obj.data.debuggee === 'stopped', `${obj.data.outcome}: ${obj.data.result}`)
    check('the result carries the value and type', /obj = \{'a': 1, 'b': \[1, 2\]\} \(dict\)/.test(obj.data.result), obj.data.result)
    check('the result carries variablesReference 200 with its named count', /\[variablesReference 200, 2 named\]/.test(obj.data.result), obj.data.result)
    check('the effect details carry the reference, counts, type and the frame used', obj.effect.details?.variablesReference === 200 && obj.effect.details?.namedVariables === 2 && obj.effect.details?.type === 'dict' && obj.effect.details?.frameId === 1000 && obj.effect.details?.context === 'repl', JSON.stringify(obj.effect.details))
    const seen = await lastEvaluate()
    check('the adapter received the TOP frame of the stopped thread (frameId 1000) in context repl', seen.frameId === 1000 && seen.context === 'repl', JSON.stringify(seen))

    section('E2 variables on that reference lists the nested values')
    const vars = await call({ op: 'variables', variablesReference: 200 })
    check('a and b are listed', /a = 1 \(int\)/.test(vars.data.result) && /b = \[1, 2\] \(list\) \[ref 201\]/.test(vars.data.result), vars.data.result)
    const inner = await call({ op: 'variables', variablesReference: 201 })
    check('the nested list expands by its reference', /0 = 1/.test(inner.data.result) && /1 = 2/.test(inner.data.result), inner.data.result)

    section('E3 context rides to the adapter; an explicit frameId wins')
    const watch = await call({ op: 'evaluate', expression: 'x+1', context: 'watch' })
    check('evaluate in context watch answers', watch.data.outcome === 'succeeded' && /x\+1 = 42 \(int\)/.test(watch.data.result), watch.data.result)
    const seenWatch = await lastEvaluate()
    check('the adapter saw context watch', seenWatch.context === 'watch', JSON.stringify(seenWatch))
    check('a scalar result carries no variablesReference', !/variablesReference/.test(watch.data.result) && watch.effect.details?.variablesReference === undefined, watch.data.result)
    const explicit = await call({ op: 'evaluate', expression: 'x+1', frameId: 1001, context: 'hover' })
    check('an explicit frameId is sent as given', explicit.data.outcome === 'succeeded' && (await lastEvaluate()).frameId === 1001, explicit.data.result)
    check('…in the context given', (await lastEvaluate()).context === 'hover')
    const plain = await call({ op: 'evaluate', expression: 'x+1', frameId: 1000 })
    check('no context ⇒ repl (the default), the pre-.42 shape unchanged', (await lastEvaluate()).context === 'repl' && /x\+1 = 42/.test(plain.data.result), plain.data.result)

    section('E4 terminated, no frameId: the refusal names the state, nothing hits the wire')
    const cont = await call({ op: 'continue' })
    check('continue runs the debuggee to its end', /debuggee terminated/.test(cont.data.result), cont.data.result.split('\n')[0])
    const dead = await call({ op: 'evaluate', expression: 'obj' })
    check('the refusal is typed and names terminated', dead.data.outcome === 'failed' && /evaluate needs a stopped frame: the debuggee is terminated and no frameId was given/.test(dead.data.result), `${dead.data.outcome}: ${dead.data.result}`)
    await call({ op: 'disconnect' })
  }

  section('E5 running, no frameId: the refusal names running and the two roads; a given frame still goes to the wire')
  {
    const launch = await call({ op: 'launch', adapter: 'mock', program: FILE, session: 'free' })
    check('a launch without breakpoints runs', /running — op:"output"/.test(launch.data.result), launch.data.result.split('\n')[0])
    const running = await call({ op: 'evaluate', expression: 'obj', session: 'free' })
    check('the refusal names running, pause and frameId', running.data.outcome === 'failed' && running.data.debuggee === 'running' && /the debuggee is running and no frameId was given/.test(running.data.result) && /op:"pause" first, or give frameId from op:"stack"/.test(running.data.result), `${running.data.outcome}: ${running.data.result}`)
    const before = await lastEvaluate('free')
    check('nothing reached the adapter for the refused call', before.expression === undefined, JSON.stringify(before))
    const withFrame = await call({ op: 'evaluate', expression: 'x+1', frameId: 1000, session: 'free' })
    check('an explicit frameId while running still evaluates', withFrame.data.outcome === 'succeeded' && /x\+1 = 42/.test(withFrame.data.result) && withFrame.data.debuggee === 'running', `${withFrame.data.outcome}: ${withFrame.data.result}`)
    await call({ op: 'disconnect', session: 'free' })
  }

  section('D  the description says it in one sentence')
  {
    const text = getDebugToolDescription(false)
    check('…the default frame', /evaluate runs in the top frame of the thread that stopped last unless frameId is given/.test(text))
    check('…the five contexts', /context "repl" \(default\) \| "watch" \| "hover" \| "clipboard" \| "variables"/.test(text))
    check('…the expandable reference', /an expandable result carries \[variablesReference N\] — pass N to op:"variables"/.test(text))
  }

  check('no sessions leak', _dapSessionCountForTesting() === 0, String(_dapSessionCountForTesting()))

  console.log('\n' + '='.repeat(60))
  if (failures > 0) {
    console.log(`❌ ${failures} CHECK(S) FAILED`)
    process.exit(1)
  }
  console.log('✅ ALL EVALUATE-CONTEXT PROOFS PASS')
  process.exit(0)
}

void main()
