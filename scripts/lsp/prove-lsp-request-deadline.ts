// prove-lsp-request-deadline — no language-server request may hang the turn
// (FN-015 rank 1).
//
// A server that accepts a request and never answers — clangd or pyright
// wedged mid-reindex, a sidecar loading a large program off a spinning disk
// — held the tool call forever: the instance's sendRequest awaited the
// connection with no deadline, no cancellation token and no observer of the
// operator's abort, so the tool loop never advanced, Esc did nothing (the
// turn machine's abort check runs only after tool results settle) and the
// only recovery was killing Mercury, which on Windows takes the in-flight
// transcript with it.
//
// Driven against the REAL createLSPServerInstance + LSPClient over the
// scripted stdio server (fixtures/fake-lsp-server.mjs, mode `wedged`: it
// answers initialize, never answers anything else, and COUNTS the
// `$/cancelRequest` notifications it receives so the cancel can be read back
// off the wire). Time IS the contract here: a deadline that fires, and an
// abort that arrives mid-flight, are both wall-clock facts.
//
//   §1 the deadline: a wedged request settles at its configured budget with
//      a typed sentence naming the method and the server, and the cancel
//      reaches the server
//   §2 the abort observer: the operator's signal settles an in-flight
//      request promptly, named so the tool layer reads an interrupt, and
//      the cancel reaches the server
//   §3 an ALREADY-aborted signal never sends the request at all
//   §4 the healthy path is untouched: a normal server still answers, and
//      the ContentModified retry ladder still rides one whole-call budget
//   §5 the schema carries the per-request field; the ambient owner is the
//      one door the tool arms

// Fork-sim BEFORE any import that folds off MACRO.
;(globalThis as Record<string, unknown>).MACRO = { VERSION: '1.0.0' }

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const repo = path.resolve(import.meta.dir, '../..')
const scratchHome = mkdtempSync(path.join(tmpdir(), 'mercury-lsp-deadline-'))
process.env.MERCURY_CONFIG_DIR = scratchHome
process.env.NODE_ENV = 'test'
delete process.env.MERCURY_LSP
delete process.env.MERCURY_LSP_SERVERS

let failures = 0
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  ok  ${name}`)
  else {
    failures++
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}
function section(t: string): void {
  console.log('\n' + '─'.repeat(76) + '\n' + t + '\n' + '─'.repeat(76))
}

const { createLSPServerInstance } = await import('../../src/services/lsp/LSPServerInstance.js')
const lspAbort = (await import('../../src/services/lsp/lspAbort.js').catch(() => null)) as
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

/** The fixture's read-back door: how many $/cancelRequest it has seen. */
async function cancelsSeen(server: { sendRequest: <T>(m: string, p: unknown) => Promise<T> }): Promise<number> {
  const answer = await server.sendRequest<{ cancels: number }>('fake/cancelCount', {})
  return answer?.cancels ?? -1
}

console.log('prove-lsp-request-deadline — a wedged server can never hang the turn')

// ── §1 the deadline ─────────────────────────────────────────────────────────
section('§1 a wedged request settles at its budget, typed, and cancels on the wire')
{
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
  // The cancel must reach the server, not just the local promise.
  check('the server received a $/cancelRequest for the abandoned request', (await cancelsSeen(server)) >= 1, 'no cancel reached the wire')
  await server.stop().catch(() => undefined)
}

// ── §2 the abort observer ───────────────────────────────────────────────────
section('§2 the operator\'s abort reaches an in-flight request')
{
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

// ── §3 an already-aborted signal ────────────────────────────────────────────
section('§3 an already-aborted signal never sends the request')
if (lspAbort) {
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

// ── §4 the healthy path is untouched ────────────────────────────────────────
section('§4 a healthy server still answers, and one budget covers the retry ladder')
{
  const server = instance('healthy-proof', 'normal', { requestTimeout: 5000 })
  await server.start()
  const answer = await server.sendRequest('textDocument/documentSymbol', {})
  check('a normal request still resolves through the bounded road', answer === null, JSON.stringify(answer))
  const src = readFileSync(path.join(repo, 'src/services/lsp/LSPServerInstance.ts'), 'utf8')
  const fn = src.slice(src.indexOf('async function sendRequest'), src.indexOf('async function sendNotification'))
  check('the ContentModified retry ladder still exists', /TRANSIENT_RETRIES/.test(fn))
  check('the whole call shares ONE deadline (the retries cannot multiply it)', /deadlineAt/.test(fn) && !/for \(let attempt[\s\S]{0,400}setTimeout\(/.test(fn), 'a per-attempt timer would multiply the budget')
  await server.stop().catch(() => undefined)
}

// ── §5 the shape: config field + the one ambient door ───────────────────────
section('§5 the per-request budget is config-driven and the tool arms the one door')
{
  const { LspServerConfigSchema } = await import('../../src/services/lsp/schema.js')
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
  const tool = readFileSync(path.join(repo, 'src/tools/LSPTool/LSPTool.ts'), 'utf8')
  check('the LSP tool arms the ambient abort door around its whole call', /runWithLspAbortSignal\(context\.abortController\.signal/.test(tool), 'the tool never arms the door — no request can observe Esc')
  const instanceSrc = readFileSync(path.join(repo, 'src/services/lsp/LSPServerInstance.ts'), 'utf8')
  check('the instance reads the ambient signal (the one observer, no call site can forget)', /currentLspAbortSignal\(\)/.test(instanceSrc))
  const client = readFileSync(path.join(repo, 'src/services/lsp/LSPClient.ts'), 'utf8')
  check('the client forwards a cancellation token to the connection', /sendRequest<T>\(method: string, params: unknown, token\?: CancellationToken\)/.test(client) && /connection\.sendRequest\(method, params, token\)/.test(client))
}

rmSync(scratchHome, { recursive: true, force: true })
console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} prove-lsp-request-deadline${failures ? ` (${failures} failure(s))` : ''}`)
process.exit(failures === 0 ? 0 : 1)
