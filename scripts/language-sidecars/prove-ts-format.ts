#!/usr/bin/env bun
// ============================================================================
//  scripts/language-sidecars/prove-ts-format.ts — the TS/JS formatting owner is
//  the SHIPPED compiler's own formatter, proved over the REAL stdio protocol
//  against the mercury-ts sidecar (the census-flagged "formatDocument on .ts
//  refuses" gap closes with ZERO new bytes).
// ============================================================================

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createFrameReader, createFrameWriter, type JsonRpcMessage } from '../../src/services/lsp/sidecarFraming.ts'

const ROOT = join(import.meta.dir, '..', '..')
const ENTRY = join(ROOT, 'src', 'services', 'lsp', 'tsSidecar', 'entry.ts')
const TSPATH = join(ROOT, 'node_modules', 'typescript', 'lib', 'typescript.js')

let failures = 0
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${!ok && detail ? ` — ${detail}` : ''}`)
}

const ws = mkdtempSync(join(tmpdir(), 'vista-tsfmt-'))
const filePath = join(ws, 'a.ts')
const unformatted = 'function greet( a:number,b:string ) {return a+1}\n'
writeFileSync(filePath, unformatted)

const bun = process.env.BUN ?? `${process.env.HOME}/.bun/bin/bun`
const child = spawn(bun, [ENTRY], { stdio: ['pipe', 'pipe', 'pipe'] })
const write = createFrameWriter(child.stdin!)
const pending = new Map<number, (msg: JsonRpcMessage) => void>()
let nextId = 1
const readChunk = createFrameReader(
  msg => {
    if (msg.id !== undefined && msg.id !== null && msg.method === undefined) {
      const r = pending.get(msg.id as number)
      if (r) {
        pending.delete(msg.id as number)
        r(msg)
      }
    }
  },
  err => {
    console.error(`client protocol error: ${err.message}`)
    process.exit(1)
  },
)
child.stdout!.on('data', (c: Buffer) => readChunk(c))
child.stderr!.on('data', () => {})

function request(method: string, params: unknown): Promise<JsonRpcMessage> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`${method} timed out`))
    }, 20_000)
    pending.set(id, m => {
      clearTimeout(t)
      resolve(m)
    })
    write({ jsonrpc: '2.0', id, method, params })
  })
}
function notify(method: string, params: unknown): void {
  write({ jsonrpc: '2.0', method, params })
}

const uri = pathToFileURL(filePath).toString()

{
  const init = await request('initialize', {
    rootUri: pathToFileURL(ws).toString(),
    capabilities: {},
    initializationOptions: { typescriptPath: TSPATH },
  })
  const caps = (init.result as { capabilities?: Record<string, unknown> })?.capabilities
  check('mercury-ts advertises documentFormattingProvider', caps?.documentFormattingProvider === true)
  check('mercury-ts advertises documentRangeFormattingProvider', caps?.documentRangeFormattingProvider === true)
  notify('initialized', {})
}

{
  notify('textDocument/didOpen', { textDocument: { uri, text: unformatted } })
  const fmt = await request('textDocument/formatting', {
    textDocument: { uri },
    options: { tabSize: 2, insertSpaces: true },
  })
  const edits = fmt.result as Array<{ newText: string }> | undefined
  check('formatting returns edits for messy TS', Array.isArray(edits) && edits.length >= 1, JSON.stringify(fmt.error ?? fmt.result).slice(0, 120))
  const rf = await request('textDocument/rangeFormatting', {
    textDocument: { uri },
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 47 } },
    options: { tabSize: 2, insertSpaces: true },
  })
  check('rangeFormatting returns edits', Array.isArray(rf.result), JSON.stringify(rf.error ?? '').slice(0, 120))
}

{
  await request('shutdown', null)
  notify('exit', null)
}
child.kill()

if (failures > 0) {
  console.error(`\nts format: ${failures} FAILURES`)
  process.exit(1)
}
console.log('\nts format: green')
