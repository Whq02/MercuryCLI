;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MercuryChildSession as CurrentChild } from '../../src/services/acp/childSession.ts'

const sourceAt = process.argv.indexOf('--source')
const { MercuryChildSession } = sourceAt < 0 ? { MercuryChildSession: CurrentChild } : await import(pathToFileURL(resolve(process.argv[sourceAt + 1]!)).href)
const scratch = mkdtempSync(join(tmpdir(), 'acp-protocol-'))
const script = join(scratch, 'runner.mjs')
writeFileSync(script, `import { createInterface } from 'node:readline'
const send = value => process.stdout.write(JSON.stringify(value) + '\\n')
const scenario = process.env.PROOF_PROTOCOL_CASE
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocol: scenario === 'protocol' ? 2 : 1, runner: { version: 'proof', pid: process.pid }, session_id: 'fixture' } })
  }
  if (message.method === 'queue/add') {
    send({ jsonrpc: '2.0', id: message.id, result: { accepted: true } })
    send({ jsonrpc: '2.0', method: 'row', params: { type: scenario, schema: 2, session_id: 'fixture' } })
  }
})
`)
let failures = 0
const check = (label: string, yes: boolean, detail: unknown = '') => {
  if (!yes) failures++
  console.log(`[${yes ? 'PASS' : 'FAIL'}] ${label}${yes ? '' : ` — ${JSON.stringify(detail)}`}`)
}
const bounded = async <T,>(promise: Promise<T>): Promise<T | null> => {
  let timer: ReturnType<typeof setTimeout>
  try {
    return await Promise.race([promise, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 2000) })])
  } finally {
    clearTimeout(timer!)
  }
}
try {
  for (const scenario of ['protocol', 'session', 'outcome']) {
    const ends: Array<{ outcome: string; detail: { status: string; errors: string[] } }> = []
    let ended: (value: boolean) => void = () => {}
    const settlement = new Promise<boolean>(resolve => { ended = resolve })
    const child = new MercuryChildSession({ cwd: scratch, env: { PROOF_PROTOCOL_CASE: scenario }, entry: { node: 'node', script } }, {
      onInit: () => {}, onAssistantText: () => {}, onToolUse: () => {}, onToolResult: () => {},
      onPermissionAsk: async () => ({ outcome: 'deny' }),
      onTurnEnd: (outcome: string, detail: { status: string; errors: string[] }) => { ends.push({ outcome, detail }); ended(true) },
      onExit: () => {},
    }) as CurrentChild
    const exited = new Promise<boolean>(resolve => child.child.once('exit', () => resolve(true)))
    try {
      await child.initialized
      const delivered = await child.writeUserPrompt([{ type: 'text', text: 'probe' }]).then(() => true, () => false)
      check(`${scenario}: incompatible version settles explicitly, never waits for an outcome`, await bounded(settlement) === true, ends)
      check(`${scenario}: one failed turn names the protocol refusal`, ends.length === 1 && ends[0]?.outcome === 'error' && ends[0].detail.status === 'protocol_error' && /protocol|schema/i.test(ends[0].detail.errors.join(' ')), ends)
      if (scenario === 'protocol') check('an incompatible initialize answer cannot accept a prompt', !delivered)
      check(`${scenario}: the owned child is closed after protocol refusal`, await bounded(exited) === true)
    } finally {
      await child.close()
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
console.log(`ACP protocol refusal: ${failures} failures`)
process.exitCode = failures ? 1 : 0
