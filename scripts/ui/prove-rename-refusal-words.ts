#!/usr/bin/env bun
import { mock } from 'bun:test'
import { join } from 'node:path'

const SRC = join(import.meta.dir, '..', '..', 'src')
;(globalThis as Record<string, unknown>).MACRO ??= { VERSION: '1.0.0' }
const HINT = 'check call in src/commands/rename/rename.ts for how daemon sessionControl rename replies and errors map to user-facing words'
let failures = 0
const check = (label: string, cond: boolean, detail = ''): void => {
  if (!cond) failures++
  console.log(`  [${cond ? 'PASS' : 'FAIL'}] ${label}${!cond ? ` — ${[detail, HINT].filter(Boolean).join('; ')}` : ''}`)
}

let reply: Record<string, unknown> | Error = { ok: true, outcome: 'applied' }
const controlSocketPath = join(SRC, 'daemon/control/controlSocket.ts')
const controlSocket = await import(controlSocketPath)
mock.module(controlSocketPath, () => ({
  ...controlSocket,
  daemonControlRpc: async () => {
    if (reply instanceof Error) throw reply
    return reply
  },
}))
const focusedPath = join(SRC, 'engine/connector/focusedConnector.ts')
const focused = await import(focusedPath)
mock.module(focusedPath, () => ({
  ...focused,
  hasFocusedSession: () => true,
  getFocusedSessionConnector: () => ({ sessionId: () => 'sess-1' }),
}))
const { call } = await import(join(SRC, 'commands/rename/rename.ts'))

const said = async (next: Record<string, unknown> | Error): Promise<string> => {
  reply = next
  let text = ''
  await call(((words: string) => { text = words }) as never, { setAppState: () => {}, messages: [] } as never, 'new name')
  return text
}

console.log("the hosted session's rename: what the row says for each answer of the daemon")
check('applied: the session is renamed', (await said({ ok: true, op: 'sessionControl', outcome: 'applied' })) === 'Renamed this session to new name')
check('a failed reply (code and error, no detail): the daemon refused it, the error text is not printed', (await said({ ok: false, code: 'ETIMEOUT', error: 'daemon did not answer within 10003ms (ETIMEOUT)' })) === 'The session was not renamed — the daemon refused it', await said({ ok: false, code: 'ETIMEOUT', error: 'daemon did not answer within 10003ms (ETIMEOUT)' }))
check('refused with a detail: the detail is the reason', (await said({ ok: true, outcome: 'refused', detail: 'the session has ended' })) === 'The session was not renamed — the session has ended')
check('refused with no detail: the daemon refused it', (await said({ ok: true, outcome: 'refused' })) === 'The session was not renamed — the daemon refused it')
check('refused with a null detail: the daemon refused it', (await said({ ok: true, outcome: 'refused', detail: null })) === 'The session was not renamed — the daemon refused it')
check('refused with an empty detail: printed as it is', (await said({ ok: true, outcome: 'refused', detail: '' })) === 'The session was not renamed — ', JSON.stringify(await said({ ok: true, outcome: 'refused', detail: '' })))
check('the socket throws: the unreachable sentence', (await said(new Error('ENOENT'))) === 'The session was not renamed — the daemon that hosts sessions was unreachable.')

console.log(failures === 0 ? '\nprove-rename-refusal-words: green' : `\nprove-rename-refusal-words: ${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
