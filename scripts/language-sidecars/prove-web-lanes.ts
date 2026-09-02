#!/usr/bin/env bun
// ============================================================================
//  scripts/language-sidecars/prove-web-lanes.ts — the mercury-web lanes proved
//  over the REAL stdio protocol (spawn the sidecar entry, speak LSP):
//
//    css   diagnostics (unknown property) · hover · format
//    json  diagnostics (trailing comma) · format
//    yaml  diagnostics (bad structure) · format
//    html  hover · format · documentSymbols · diagnostics HONESTLY EMPTY
//          (the maintained service ships no validator — never invented)
//    law   remote-schema refusal: a document naming an https schema still
//          answers (no hang, no fetch); shutdown/exit clean.
// ============================================================================

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { createFrameReader, createFrameWriter, type JsonRpcMessage } from '../../src/services/lsp/sidecarFraming.ts'

const ROOT = join(import.meta.dir, '..', '..')
const ENTRY = join(ROOT, 'src', 'services', 'lsp', 'webSidecar', 'entry.ts')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

// Two modes: source entry under bun (default) or the BUILT bundle's
// --lsp-web-sidecar route under stock node (MERCURY_PROVE_WEB_BUNDLE=1 — the
// artifact truth; run-all.sh runs both when dist is present).
const bundleMode = process.env.MERCURY_PROVE_WEB_BUNDLE === '1'
const bun = process.env.BUN ?? `${process.env.HOME}/.bun/bin/bun`
const child = bundleMode
  ? spawn('node', [join(ROOT, 'dist', 'mercury.mjs'), '--lsp-web-sidecar'], { stdio: ['pipe', 'pipe', 'pipe'] })
  : spawn(bun, [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] })
console.log(`  mode: ${bundleMode ? 'BUILT BUNDLE (node dist/mercury.mjs --lsp-web-sidecar)' : 'source entry (bun)'}`)
const write = createFrameWriter(child.stdin!)

const pending = new Map<number, (msg: JsonRpcMessage) => void>()
const notifications: JsonRpcMessage[] = []
let nextId = 1

const readChunk = createFrameReader(
  msg => {
    if (msg.id !== undefined && msg.id !== null && msg.method === undefined) {
      const resolve = pending.get(msg.id as number)
      if (resolve) {
        pending.delete(msg.id as number)
        resolve(msg)
      }
    } else if (msg.method !== undefined) {
      notifications.push(msg)
    }
  },
  err => {
    console.error(`client protocol error: ${err.message}`)
    process.exit(1)
  },
)
child.stdout!.on('data', (c: Buffer) => readChunk(c))
child.stderr!.on('data', () => {})

function request(method: string, params: unknown, timeoutMs = 15_000): Promise<JsonRpcMessage> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`request ${method} timed out`))
    }, timeoutMs)
    pending.set(id, msg => {
      clearTimeout(timer)
      resolve(msg)
    })
    write({ jsonrpc: '2.0', id, method, params })
  })
}
function notifyServer(method: string, params: unknown): void {
  write({ jsonrpc: '2.0', method, params })
}

function openDoc(uri: string, text: string): void {
  notifyServer('textDocument/didOpen', { textDocument: { uri, version: 1, text } })
}

const exitCode = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)))

// ── initialize ──────────────────────────────────────────────────────────────
{
  const init = await request('initialize', { rootUri: null, capabilities: {} })
  const caps = (init.result as { capabilities?: Record<string, unknown> })?.capabilities
  check('initialize returns capabilities', !!caps)
  check('hover + formatting + diagnostics advertised', !!caps?.hoverProvider && !!caps?.documentFormattingProvider && !!caps?.diagnosticProvider)
  notifyServer('initialized', {})
}

// ── css ─────────────────────────────────────────────────────────────────────
{
  const uri = 'file:///vista/fixture.css'
  openDoc(uri, 'body { colr: red; }\n')
  const diag = await request('textDocument/diagnostic', { textDocument: { uri } })
  const items = (diag.result as { items?: unknown[] })?.items ?? []
  check('css: unknown property produces a diagnostic', items.length >= 1, JSON.stringify(items).slice(0, 120))
  const hover = await request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 1 } })
  check('css: hover answers on a selector', hover.result !== null && hover.result !== undefined)
  const fmt = await request('textDocument/formatting', { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } })
  check('css: format returns edits', Array.isArray(fmt.result))
}

// ── json ────────────────────────────────────────────────────────────────────
{
  const uri = 'file:///vista/fixture.json'
  openDoc(uri, '{"a": 1,}\n')
  const diag = await request('textDocument/diagnostic', { textDocument: { uri } })
  const items = (diag.result as { items?: unknown[] })?.items ?? []
  check('json: trailing comma produces a diagnostic', items.length >= 1, JSON.stringify(items).slice(0, 120))
  const fmt = await request('textDocument/formatting', { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } })
  check('json: format returns edits', Array.isArray(fmt.result) && (fmt.result as unknown[]).length >= 1)
}

// ── yaml ────────────────────────────────────────────────────────────────────
{
  const uri = 'file:///vista/fixture.yaml'
  openDoc(uri, 'a: [1, 2\nb: c\n')
  const diag = await request('textDocument/diagnostic', { textDocument: { uri } })
  const items = (diag.result as { items?: unknown[] })?.items ?? []
  check('yaml: broken flow sequence produces a diagnostic', items.length >= 1, JSON.stringify(items).slice(0, 120))
  const uri2 = 'file:///vista/fixture2.yaml'
  openDoc(uri2, 'key:    value\nlist:\n  - a\n')
  const fmt = await request('textDocument/formatting', { textDocument: { uri: uri2 }, options: { tabSize: 2, insertSpaces: true } })
  check('yaml: format returns edits', Array.isArray(fmt.result), JSON.stringify(fmt.error ?? fmt.result).slice(0, 120))
}

// ── html ────────────────────────────────────────────────────────────────────
{
  const uri = 'file:///vista/fixture.html'
  openDoc(uri, '<div  class="a"><p>hi</p></div>\n')
  const hover = await request('textDocument/hover', { textDocument: { uri }, position: { line: 0, character: 2 } })
  check('html: hover answers on a tag', hover.result !== null && hover.result !== undefined)
  const fmt = await request('textDocument/formatting', { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } })
  check('html: format returns edits', Array.isArray(fmt.result))
  const syms = await request('textDocument/documentSymbol', { textDocument: { uri } })
  check('html: document symbols project', Array.isArray(syms.result) && (syms.result as unknown[]).length >= 1)
  const diag = await request('textDocument/diagnostic', { textDocument: { uri } })
  const items = (diag.result as { items?: unknown[] })?.items ?? []
  check('html: diagnostics HONESTLY empty (no invented validator)', items.length === 0)
}

// ── jsonc-by-convention: tsconfig-class files get NO phantom errors ─────────
{
  const uri = 'file:///vista/tsconfig.json'
  openDoc(uri, '{\n  // comment is fine here\n  "compilerOptions": { "strict": true, },\n}\n')
  const diag = await request('textDocument/diagnostic', { textDocument: { uri } })
  const items = (diag.result as { items?: unknown[] })?.items ?? []
  check('tsconfig.json: comments + trailing commas produce ZERO diagnostics (jsonc by convention)', items.length === 0, JSON.stringify(items).slice(0, 160))
  const uriStrict = 'file:///vista/data.json'
  openDoc(uriStrict, '{"a": 1, /* nope */}\n')
  const strict = await request('textDocument/diagnostic', { textDocument: { uri: uriStrict } })
  const strictItems = (strict.result as { items?: unknown[] })?.items ?? []
  check('plain .json stays STRICT (comments still flagged)', strictItems.length >= 1)
}

// ── law: remote schema refusal answers, never hangs ─────────────────────────
{
  const uri = 'file:///vista/remote-schema.json'
  openDoc(uri, '{"$schema": "https://example.com/schema.json", "a": 1}\n')
  const diag = await request('textDocument/diagnostic', { textDocument: { uri } }, 20_000)
  check('law: document naming an https schema still ANSWERS (refusal, no fetch/hang)', diag.result !== undefined)
}

// ── shutdown ────────────────────────────────────────────────────────────────
{
  await request('shutdown', null)
  notifyServer('exit', null)
  const code = await Promise.race([exitCode, new Promise<null>(r => setTimeout(() => r(null), 5000))])
  check('clean exit after shutdown', code === 0, `exit=${String(code)}`)
}

child.kill()
if (failures > 0) {
  console.error(`\nweb lanes: ${failures} FAILURES`)
  process.exit(1)
}
console.log('\nweb lanes: green')
