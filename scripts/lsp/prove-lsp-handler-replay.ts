#!/usr/bin/env bun
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const SRC = process.env.PROVE_SRC ?? join(import.meta.dir, '../../src')
const FIXTURE = join(import.meta.dir, 'fixtures/fake-lsp-server.mjs')
const { createLSPClient } = await import(join(SRC, 'services/lsp/LSPClient.ts'))

let failures = 0
const t = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? ` — ${detail}` : ''}`)
  if (!ok) failures = 1
}

type ConfigAnswer = { tag: string; result: unknown; error: unknown }
const diagnostics: string[] = []
const configAnswers: ConfigAnswer[] = []
const extras: string[] = []
let configHandlerCalls = 0

const client = createLSPClient('fake', () => {})
client.onNotification('textDocument/publishDiagnostics', (params: unknown) => {
  const p = params as { diagnostics?: Array<{ message: string }> }
  diagnostics.push(p.diagnostics?.[0]?.message ?? '(none)')
})
client.onRequest('workspace/configuration', () => {
  configHandlerCalls++
  return [{ pythonPath: '/venv/bin/python' }]
})
client.onNotification('test/configAnswer', (params: unknown) => {
  configAnswers.push(params as ConfigAnswer)
})

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(pred: () => boolean, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (pred()) return true
    await sleep(25)
  }
  return pred()
}

async function generation(tag: string): Promise<void> {
  await client.start(process.execPath, [FIXTURE], { env: { ...process.env, FAKE_LSP_MODE: 'normal' } })
  await client.initialize({ processId: process.pid, rootUri: null, capabilities: {} })
  await client.sendNotification('test/ping', { tag })
  await waitFor(() => diagnostics.includes(`probe ${tag}`) && configAnswers.some(a => a.tag === tag))
}

await generation('gen1')
{
  const answer = configAnswers.find(a => a.tag === 'gen1')
  t('L1 push diagnostics reach the handler registered before start()', diagnostics.includes('probe gen1'), JSON.stringify(diagnostics))
  t('L1 workspace/configuration is answered by our handler', answer !== undefined && answer.error === null && Array.isArray(answer.result) && configHandlerCalls === 1, JSON.stringify(answer))
}

client.onNotification('test/extra', (params: unknown) => {
  extras.push((params as { tag: string }).tag)
})
{
  await client.sendNotification('test/ping', { tag: 'gen1b' })
  await waitFor(() => extras.includes('gen1b'))
  t('L2 a handler registered while connected fires in the same generation', extras.includes('gen1b'), JSON.stringify(extras))
}

await client.stop()
const diagsBefore = diagnostics.length
const answersBefore = configAnswers.length
await generation('gen2')
await waitFor(() => extras.includes('gen2'), 1000)
{
  const answer = configAnswers.find(a => a.tag === 'gen2')
  t('L3 push diagnostics still reach the handler after the restart', diagnostics.includes('probe gen2'), `diagnostics after restart: ${diagnostics.slice(diagsBefore).join(',') || '(none)'}`)
  t('L3 workspace/configuration is still answered by our handler after the restart', answer !== undefined && answer.error === null && Array.isArray(answer.result) && configHandlerCalls === 3, answer ? JSON.stringify(answer) : `no answer relayed (${configAnswers.length - answersBefore} new)`)
  t('L3 the mid-generation handler survives the restart too', extras.includes('gen2'), JSON.stringify(extras))
}
await client.stop()

{
  const src = readFileSync(join(SRC, 'services/lsp/LSPClient.ts'), 'utf8')
  t('L4 the durable registries exist', src.includes('const notificationHandlers') && src.includes('const requestHandlers'))
  t('L4 the one-shot clears are gone', !src.includes('pendingNotifications.length = 0') && !src.includes('pendingRequests.length = 0'))
}

console.log(failures === 0 ? 'LSP HANDLER REPLAY: ALL PASS' : 'LSP HANDLER REPLAY: RED')
process.exit(failures)
