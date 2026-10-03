;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MercuryChildSession as CurrentChild } from '../../src/services/acp/childSession.ts'

const sourceAt = process.argv.indexOf('--source')
const { MercuryChildSession } = sourceAt < 0 ? { MercuryChildSession: CurrentChild } : await import(pathToFileURL(resolve(process.argv[sourceAt + 1]!)).href)
const scratch = mkdtempSync(join(tmpdir(), 'acp-cancel-window-'))
const script = join(scratch, 'runner.mjs')
writeFileSync(script, `import { createInterface } from 'node:readline'
import { writeFileSync } from 'node:fs'
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
const scenario = process.env.PROOF_CANCEL_CASE
const record = { added: null, withdraw: null, interrupts: 0, started: false }
const note = () => writeFileSync(process.env.PROOF_RECORD, JSON.stringify(record))
let seq = 0
const row = params => send({ jsonrpc: '2.0', method: 'row', params: { seq: ++seq, timestamp: new Date().toISOString(), session_id: 'fixture', turn: 1, ...params } })
const startTurn = () => {
  record.started = true
  note()
  row({ type: 'turn', state: 'started', turn_id: 'turn-1', message_ids: [record.added ?? 'probe'], model: 'fixture' })
}
const usage = { input_tokens: 0, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0 }
const interruptedOutcome = () => row({ type: 'outcome', schema: 1, turn_id: 'turn-1', status: 'interrupted', steps: 0, wall_ms: 0, usage, models: {}, denials: [] })
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocol: 1, runner: { version: 'proof', pid: process.pid }, session_id: 'fixture' } })
  }
  if (message.method === 'queue/add') {
    record.added = typeof message.params.id === 'string' ? message.params.id : null
    note()
    if (scenario === 'active') startTurn()
    send({ jsonrpc: '2.0', id: message.id, result: { accepted: true } })
  }
  if (message.method === 'turn/interrupt') {
    record.interrupts += 1
    note()
    send({ jsonrpc: '2.0', id: message.id, result: { interrupted: record.started } })
    if (record.started) interruptedOutcome()
  }
  if (message.method === 'queue/withdraw') {
    record.withdraw = message.params.id
    note()
    if (scenario === 'withdraw' && message.params.id === record.added) {
      send({ jsonrpc: '2.0', id: message.id, result: { withdrawn: true, text: 'probe' } })
      return
    }
    if (scenario === 'taken-early') startTurn()
    send({ jsonrpc: '2.0', id: message.id, result: { withdrawn: false, reason: 'taken' } })
    if (scenario === 'taken') startTurn()
  }
})
`)
let failures = 0
const check = (label: string, yes: boolean, detail: unknown = '') => {
  if (!yes) failures++
  console.log(`[${yes ? 'PASS' : 'FAIL'}] ${label}${yes ? '' : ` — ${JSON.stringify(detail)}`}`)
}
const bounded = async <T,>(promise: Promise<T>, ms: number): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([promise, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms) })])
  } finally {
    clearTimeout(timer!)
  }
}
type Record_ = { added: string | null; withdraw: string | null; interrupts: number; started: boolean }
const uuidLike = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
try {
  for (const scenario of ['withdraw', 'taken', 'taken-early', 'active']) {
    const recordPath = join(scratch, `${scenario}.json`)
    const ends: Array<{ outcome: string; detail: { status: string; errors: string[] } }> = []
    let ended: (value: boolean) => void = () => {}
    const settlement = new Promise<boolean>(resolve => { ended = resolve })
    const child = new MercuryChildSession({ cwd: scratch, env: { PROOF_CANCEL_CASE: scenario, PROOF_RECORD: recordPath }, entry: { node: 'node', script } }, {
      onInit: () => {}, onAssistantText: () => {}, onToolUse: () => {}, onToolResult: () => {},
      onPermissionAsk: async () => ({ outcome: 'deny' }),
      onTurnEnd: (outcome: string, detail: { status: string; errors: string[] }) => { ends.push({ outcome, detail }); ended(true) },
      onExit: () => {},
    }) as CurrentChild
    try {
      await child.initialized
      await child.writeUserPrompt([{ type: 'text', text: 'probe' }])
      child.interrupt()
      const settled = await bounded(settlement, 5_000)
      await bounded(new Promise<void>(resolve => setTimeout(resolve, 150)), 1_000)
      const record: Record_ = existsSync(recordPath) ? (JSON.parse(readFileSync(recordPath, 'utf8')) as Record_) : { added: null, withdraw: null, interrupts: 0, started: false }
      check(`${scenario}: the first cancel settles the turn as cancelled, exactly once`, settled === true && ends.length === 1 && ends[0]?.outcome === 'cancelled' && ends[0].detail.status === 'interrupted', { ends, record })
      check(`${scenario}: the prompt row carries an identity the host minted`, typeof record.added === 'string' && uuidLike.test(record.added), record)
      if (scenario === 'withdraw') {
        check('withdraw: a cancel with no open turn withdraws the queued prompt by its identity, and asks for no interrupt', record.withdraw === record.added && record.interrupts === 0 && !record.started, record)
      }
      if (scenario === 'taken' || scenario === 'taken-early') {
        check(`${scenario}: a prompt the runner already took is interrupted once its turn opens`, record.withdraw === record.added && record.started && record.interrupts === 1, record)
      }
      if (scenario === 'active') {
        check('active: a cancel against an open turn interrupts it and withdraws nothing', record.started && record.interrupts >= 1 && record.withdraw === null, record)
      }
    } finally {
      await child.close()
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`ACP cancel window: ${failures} failures`)
process.exitCode = failures ? 1 : 0
