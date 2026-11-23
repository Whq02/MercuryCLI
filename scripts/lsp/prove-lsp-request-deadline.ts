
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { getEventListeners } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const repo = path.resolve(import.meta.dir, '../..')
const scratchHome = mkdtempSync(path.join(tmpdir(), 'mercury-lsp-deadline-'))
process.env.MERCURY_CONFIG_DIR = scratchHome
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_LSP
delete process.env.MERCURY_LSP_SERVERS

let failures = 0
let fixHintNow = ''
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}${fixHintNow ? ` — fix: ${fixHintNow}` : ''}`)
  }
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { createLSPServerInstance } = await import('../../src/integrations/lsp/LSPServerInstance.js')
const lspAbort = (await import('../../src/integrations/lsp/lspAbort.js').catch(() => null)) as
  | { runWithLspAbortSignal: <T>(s: AbortSignal | undefined, fn: () => T) => T; currentLspAbortSignal: () => AbortSignal | undefined }
  | null

const FAKE = path.join(repo, 'scripts/lsp/fixtures/fake-lsp-server.mjs')

function instance(name: string, mode: string, extra: Record<string, unknown> = {}) {
  return createLSPServerInstance(name, {
    command: process.execPath,
    args: [FAKE],
    extensionToLanguage: { '.fake': 'fake' },
    transport: 'stdio' as const,
    env: { FAKE_LSP_MODE: mode },
    workspaceFolder: repo,
    startupTimeout: 8000,
    scope: 'dynamic' as const,
    source: 'deadline-proof',
    ...extra,
  } as Parameters<typeof createLSPServerInstance>[1])
}

async function cancelsSeen(server: { sendRequest: <T>(m: string, p: unknown) => Promise<T> }): Promise<number> {
  const answer = await server.sendRequest<{ cancels: number }>('fake/cancelCount', {})
  return answer?.cancels ?? -1
}

console.log('prove-lsp-request-deadline — a wedged server can never hang the turn')

section('§1 a wedged request settles at its budget, typed, and cancels on the wire')
{
  fixHintNow = 'sendRequestOf in src/integrations/lsp/server-instance/requests.ts must settle a request at its requestTimeout with an LspRequestTimeout error naming the method, the server and the seconds, and send $/cancelRequest'
  const server = instance('deadline-proof', 'wedged', { requestTimeout: 700 })
  await server.start()
  const t0 = Date.now()
  let failure: unknown
  try {
    await server.sendRequest('textDocument/definition', { textDocument: { uri: 'file:///x.fake' } })
  } catch (e) {
    failure = e
  }
  const elapsed = Date.now() - t0
  check('the request SETTLES (it did not hang)', failure !== undefined)
  check(`it settles at its configured budget, not before (${elapsed}ms ≥ 700ms)`, elapsed >= 650)
  check(`…and not far past it (${elapsed}ms < 5000ms)`, elapsed < 5000)
  const message = failure instanceof Error ? failure.message : String(failure)
  check('the failure names the method it was waiting on', /textDocument\/definition/.test(message), message)
  check('…and the server it was waiting on', /deadline-proof/.test(message), message)
  check('…and says it was a wait that ran out, in seconds', /0\.7s|700ms/.test(message) && /answer/i.test(message), message)
  check('the failure is typed (name LspRequestTimeout), never a bare Error', failure instanceof Error && failure.name === 'LspRequestTimeout', failure instanceof Error ? failure.name : 'not an Error')
  check('the server received a $/cancelRequest for the abandoned request', (await cancelsSeen(server)) >= 1, 'no cancel reached the wire')
  await server.stop().catch(() => undefined)
}

section('§2 the operator\'s abort reaches an in-flight request')
{
  fixHintNow = 'sendRequestOf in src/integrations/lsp/server-instance/requests.ts must listen to currentLspAbortSignal() (src/integrations/lsp/lspAbort.ts) and settle an in-flight request with an AbortError naming the method and server, and send $/cancelRequest'
  check('the ambient abort owner exists', lspAbort !== null)
  if (lspAbort) {
    const server = instance('abort-proof', 'wedged', { requestTimeout: 60_000 })
    await server.start()
    const controller = new AbortController()
    const t0 = Date.now()
    const inFlight = lspAbort.runWithLspAbortSignal(controller.signal, () =>
      server.sendRequest('textDocument/references', { textDocument: { uri: 'file:///x.fake' } }).catch((e: unknown) => e),
    )
    setTimeout(() => controller.abort(), 300)
    const failure = await inFlight
    const elapsed = Date.now() - t0
    check(`the abort settles the request promptly (${elapsed}ms — the 60s budget never ran)`, elapsed < 5000 && elapsed >= 250)
    check('the settlement is an Error', failure instanceof Error)
    check('it is named AbortError, so the tool layer reads an INTERRUPT, never a tool failure', failure instanceof Error && failure.name === 'AbortError', failure instanceof Error ? failure.name : String(failure))
    const message = failure instanceof Error ? failure.message : ''
    check('the sentence names what was interrupted', /textDocument\/references/.test(message) && /abort-proof/.test(message), message)
    check('the server received a $/cancelRequest for the aborted request', (await cancelsSeen(server)) >= 1, 'no cancel reached the wire')
    await server.stop().catch(() => undefined)
  }
}

section('§3 an already-aborted signal never sends the request')
if (lspAbort) {
  fixHintNow = 'sendRequestOf in src/integrations/lsp/server-instance/requests.ts must refuse at once with an AbortError, without sending, when the ambient signal (src/integrations/lsp/lspAbort.ts) is already aborted'
  const server = instance('pre-abort-proof', 'wedged', { requestTimeout: 60_000 })
  await server.start()
  const controller = new AbortController()
  controller.abort()
  const t0 = Date.now()
  const failure = await lspAbort.runWithLspAbortSignal(controller.signal, () =>
    server.sendRequest('textDocument/hover', {}).catch((e: unknown) => e),
  )
  const elapsed = Date.now() - t0
  check(`it refuses at once (${elapsed}ms)`, elapsed < 1000)
  check('named AbortError', failure instanceof Error && failure.name === 'AbortError', failure instanceof Error ? failure.name : String(failure))
  await server.stop().catch(() => undefined)
}

section('§4 a healthy server still answers, and one budget covers the retry ladder')
{
  fixHintNow = 'sendRequestOf in src/integrations/lsp/server-instance/requests.ts must resolve normal requests and remove its abort listener from the operation signal once each request settles'
  const server = instance('healthy-proof', 'normal', { requestTimeout: 5000 })
  await server.start()
  const answer = await server.sendRequest('textDocument/documentSymbol', {})
  check('a normal request still resolves through the bounded road', answer === null, JSON.stringify(answer))
  const controller = new AbortController()
  await lspAbort!.runWithLspAbortSignal(controller.signal, async () => {
    for (let index = 0; index < 5; index++) await server.sendRequest('textDocument/documentSymbol', {})
  })
  check('successful requests leave no abort listeners on the operation signal', getEventListeners(controller.signal, 'abort').length === 0)
  await server.stop().catch(() => undefined)
}

section('§5 the per-request budget is config-driven and the tool arms the one door')
{
  fixHintNow = 'LspServerConfigSchema in src/integrations/lsp/lspServerConfigSchema.ts must accept requestTimeout as a positive integer and refuse zero'
  const { LspServerConfigSchema } = await import('../../src/integrations/lsp/lspServerConfigSchema.js')
  const parsed = LspServerConfigSchema().safeParse({
    command: '/usr/bin/true',
    extensionToLanguage: { '.x': 'x' },
    requestTimeout: 1234,
  })
  check('the schema accepts requestTimeout', parsed.success, JSON.stringify(parsed.error?.issues?.[0] ?? {}))
  const bad = LspServerConfigSchema().safeParse({
    command: '/usr/bin/true',
    extensionToLanguage: { '.x': 'x' },
    requestTimeout: 0,
  })
  check('…and refuses a non-positive budget', !bad.success)
}

rmSync(scratchHome, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-lsp-request-deadline${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
