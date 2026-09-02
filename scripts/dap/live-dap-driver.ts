#!/usr/bin/env bun
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.MERCURY_HOME = mkdtempSync(join(tmpdir(), 'live-smoke-home-'))


const adapterKey = process.env.SMOKE_ADAPTER!
const program = process.env.SMOKE_PROGRAM!
const source = process.env.SMOKE_SOURCE!
const line = Number(process.env.SMOKE_LINE ?? '3')
const frameName = process.env.SMOKE_FRAME ?? 'compute'

const { createDapSession, removeDapSession } = await import(
  '../../src/services/dap/dapClient.js'
)

let fail = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) fail = 1
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const { makeOwnerKey } = await import('../../src/services/run/ownerKey.js')
const OWNER = makeOwnerKey({ workspace: '/tmp/w', sessionId: 'dap-live', lane: 'main' })
const session = await createDapSession({
  owner: OWNER,
  id: 'smoke',
  adapterKey,
  program,
  cwd: process.cwd(),
  breakpoints: new Map([[source, [line]]]),
})
const outcome = await session.waitForStopOutcome(20_000)
check('stopped at the breakpoint', outcome.state === 'stopped' && outcome.info.reason === 'breakpoint', JSON.stringify(outcome.state === 'stopped' ? outcome.info : outcome))
const stopSession = outcome.state === 'stopped' ? outcome.session : session
const threadId = (outcome.state === 'stopped' ? outcome.info.threadId : undefined) ?? 1
const stack = await stopSession.request('stackTrace', { threadId })
const frames = stack.stackFrames as Array<{ id: number; name?: string; line?: number }>
check(
  `top frame is ${frameName} at line ${line}`,
  (frames[0]?.name ?? '').includes(frameName) && frames[0]?.line === line,
  `${frames[0]?.name}:${frames[0]?.line}`,
)
const scopes = await stopSession.request('scopes', { frameId: frames[0]!.id })
const localsRef = (scopes.scopes as Array<{ name: string; variablesReference: number }>).find(
  s => /local/i.test(s.name),
)?.variablesReference
const vars = await stopSession.request('variables', { variablesReference: localsRef! })
const pairs = (vars.variables as Array<{ name: string; value: string }>).map(
  v => `${v.name}=${String(v.value).trim()}`,
)
check('locals carry a=4 and b=2', pairs.includes('a=4') && pairs.includes('b=2'), pairs.join(','))
const evald = await stopSession.request('evaluate', {
  expression: 'a * 10 + b',
  frameId: frames[0]!.id,
  context: 'repl',
})
check('evaluate a*10+b = 42', /\b42\b/.test(String(evald.result)), String(evald.result))
stopSession.lastStopped = null
await stopSession.request('continue', { threadId })
const deadline = Date.now() + 15_000
while (!session.treeTerminated() && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
check('debuggee ran to completion', session.treeTerminated() === true, session.exitDetail)
console.log(
  `  [note] program output ${session.output.some(l => l.includes('result:')) ? 'captured' : 'not captured'} (adapter-dependent): ${session.output.slice(-3).join(' | ').slice(0, 120)}`,
)
await removeDapSession(OWNER, 'smoke')
process.exit(fail)
