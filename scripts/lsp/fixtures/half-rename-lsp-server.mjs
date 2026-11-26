#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const pullCapable = process.env.HALF_RENAME_PULL === '1'
const workspaceStems = ['defs', 'a', 'b', 'c']

let buf = Buffer.alloc(0)
const docs = new Map()
const heldHalfState = new Map()
let config = {
  releaseHalfOnSaveCount: 0,
  releaseHalfOnFirstChange: false,
  versioned: false,
  settledPushOnSaveCount: 0,
  settledPushDelayMs: 0,
  settledSplitDelayMs: 0,
  settledStaggerMs: [],
  defectFile: '',
  defectMessage: '',
}
let saveCount = 0

function send(msg) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`)
  process.stdout.write(body)
}

function publish(uri, diagnostics, version) {
  const params = { uri, diagnostics }
  if (version !== undefined) params.version = version
  send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params })
}

function identifierAt(text, line, character) {
  const lines = text.split('\n')
  const row = lines[line] ?? ''
  let start = character
  let end = character
  while (start > 0 && /[A-Za-z0-9_$]/.test(row[start - 1])) start--
  while (end < row.length && /[A-Za-z0-9_$]/.test(row[end])) end++
  return row.slice(start, end)
}

function wordRanges(text, word) {
  const ranges = []
  const lines = text.split('\n')
  const re = new RegExp(`\\b${word}\\b`, 'g')
  for (let line = 0; line < lines.length; line++) {
    let match
    while ((match = re.exec(lines[line])) !== null) {
      ranges.push({
        start: { line, character: match.index },
        end: { line, character: match.index + word.length },
      })
    }
  }
  return ranges
}

function exportedSymbolIn(text) {
  const match = /export const ([A-Za-z0-9_$]+)/.exec(text)
  return match ? match[1] : null
}

function importedSymbolIn(text) {
  const match = /import\s*\{\s*([A-Za-z0-9_$]+)\s*\}/.exec(text)
  return match ? match[1] : null
}

function textForPath(filePath) {
  const uri = pathToFileURL(filePath).href
  const open = docs.get(uri)
  if (open !== undefined) return open.text
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

function computeDiagnosticsForUri(uri) {
  const filePath = fileURLToPath(uri)
  const dir = dirname(filePath)
  const name = basename(filePath)
  const ext = extname(filePath)
  const diagnostics = []
  if (config.defectFile && name === config.defectFile) {
    diagnostics.push({
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 10 } },
      severity: 1,
      source: 'half-rename-stub',
      code: '2322',
      message: config.defectMessage || 'Post-apply type defect.',
    })
  }
  if (name === `defs${ext}`) return diagnostics
  const defsText = textForPath(join(dir, `defs${ext}`))
  const exported = exportedSymbolIn(defsText)
  if (!exported) return diagnostics
  const text = textForPath(filePath)
  const imported = importedSymbolIn(text)
  if (!imported || imported === exported) return diagnostics
  const ranges = wordRanges(text, imported)
  for (let i = 0; i < ranges.length; i++) {
    diagnostics.push({
      range: ranges[i],
      severity: 1,
      source: 'half-rename-stub',
      code: i === 0 ? '2305' : '2304',
      message: i === 0 ? `Module './defs' has no exported member '${imported}'.` : `Cannot find name '${imported}'.`,
    })
  }
  return diagnostics
}

function captureHalfStateIfAny(changedUri) {
  const filePath = fileURLToPath(changedUri)
  const dir = dirname(filePath)
  const ext = extname(filePath)
  for (const stem of ['a', 'b', 'c']) {
    const uri = pathToFileURL(join(dir, `${stem}${ext}`)).href
    const diags = computeDiagnosticsForUri(uri)
    if (diags.length > 0) {
      const open = docs.get(uri)
      heldHalfState.set(uri, { diagnostics: diags, version: open?.version })
    }
  }
}

function flushHeldHalfState(versionedOverride) {
  const useVersion = versionedOverride ?? config.versioned
  for (const [uri, entry] of heldHalfState) {
    publish(uri, entry.diagnostics, useVersion ? entry.version : undefined)
  }
}

function flushSettledState(dir, ext) {
  const useVersion = config.versioned
  const defsUri = pathToFileURL(join(dir, `defs${ext}`)).href
  const defsOpen = docs.get(defsUri)
  publish(defsUri, computeDiagnosticsForUri(defsUri), useVersion ? defsOpen?.version : undefined)
  const consumers = ['a', 'b', 'c']
  if (Array.isArray(config.settledStaggerMs) && config.settledStaggerMs.length === consumers.length) {
    for (let i = 0; i < consumers.length; i++) {
      const stem = consumers[i]
      const delay = config.settledStaggerMs[i]
      setTimeout(() => {
        const uri = pathToFileURL(join(dir, `${stem}${ext}`)).href
        const open = docs.get(uri)
        publish(uri, computeDiagnosticsForUri(uri), useVersion ? open?.version : undefined)
      }, delay)
    }
    return
  }
  const emitConsumers = () => {
    for (const stem of consumers) {
      const uri = pathToFileURL(join(dir, `${stem}${ext}`)).href
      const open = docs.get(uri)
      publish(uri, computeDiagnosticsForUri(uri), useVersion ? open?.version : undefined)
    }
  }
  if (config.settledSplitDelayMs > 0) {
    setTimeout(emitConsumers, config.settledSplitDelayMs)
  } else {
    emitConsumers()
  }
}

function onMessage(msg) {
  if (msg.method === 'initialize') {
    const capabilities = {
      textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
      renameProvider: true,
      ...(pullCapable
        ? { diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: false } }
        : {}),
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { capabilities } })
    return
  }
  if (msg.method === 'initialized') return
  if (msg.method === 'shutdown') {
    send({ jsonrpc: '2.0', id: msg.id, result: null })
    return
  }
  if (msg.method === 'exit') process.exit(0)

  if (msg.method === 'test/configure') {
    config = { ...config, ...(msg.params ?? {}) }
    saveCount = 0
    if (msg.params?.clearHeld === true) heldHalfState.clear()
    send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } })
    return
  }
  if (msg.method === 'test/releaseHalfState') {
    flushHeldHalfState(msg.params?.versioned)
    send({ jsonrpc: '2.0', id: msg.id, result: { released: heldHalfState.size } })
    return
  }
  if (msg.method === 'test/publish') {
    const p = msg.params ?? {}
    publish(p.uri, p.diagnostics ?? [], p.version)
    send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } })
    return
  }
  if (msg.method === 'test/sync') {
    send({ jsonrpc: '2.0', id: msg.id, result: { ok: true } })
    return
  }

  if (msg.method === 'textDocument/didOpen') {
    const td = msg.params.textDocument
    docs.set(td.uri, { text: td.text, version: td.version })
    return
  }
  if (msg.method === 'textDocument/didChange') {
    const td = msg.params.textDocument
    const last = msg.params.contentChanges[msg.params.contentChanges.length - 1]
    if (last) docs.set(td.uri, { text: last.text, version: td.version })
    captureHalfStateIfAny(td.uri)
    if (config.releaseHalfOnFirstChange && heldHalfState.size > 0) {
      flushHeldHalfState()
    }
    return
  }
  if (msg.method === 'textDocument/didSave') {
    const uri = msg.params.textDocument.uri
    saveCount++
    if (config.releaseHalfOnSaveCount > 0 && saveCount === config.releaseHalfOnSaveCount && heldHalfState.size > 0) {
      flushHeldHalfState()
    }
    if (config.settledPushOnSaveCount > 0 && saveCount === config.settledPushOnSaveCount) {
      const filePath = fileURLToPath(uri)
      const dir = dirname(filePath)
      const ext = extname(filePath)
      if (config.settledPushDelayMs > 0) {
        setTimeout(() => flushSettledState(dir, ext), config.settledPushDelayMs)
      } else {
        flushSettledState(dir, ext)
      }
    }
    return
  }
  if (msg.method === 'textDocument/didClose') {
    docs.delete(msg.params.textDocument.uri)
    return
  }
  if (msg.method === 'textDocument/rename') {
    const uri = msg.params.textDocument.uri
    const filePath = fileURLToPath(uri)
    const dir = dirname(filePath)
    const ext = extname(filePath)
    const oldName = identifierAt(textForPath(filePath), msg.params.position.line, msg.params.position.character)
    const newName = msg.params.newName
    const changes = {}
    for (const stem of workspaceStems) {
      const targetPath = join(dir, `${stem}${ext}`)
      const targetUri = pathToFileURL(targetPath).href
      const ranges = wordRanges(textForPath(targetPath), oldName)
      if (ranges.length > 0) {
        changes[targetUri] = ranges.map(range => ({ range, newText: newName }))
      }
    }
    send({ jsonrpc: '2.0', id: msg.id, result: { changes } })
    return
  }
  if (msg.method === 'textDocument/diagnostic') {
    const uri = msg.params.textDocument.uri
    send({ jsonrpc: '2.0', id: msg.id, result: { kind: 'full', items: computeDiagnosticsForUri(uri) } })
    return
  }
  if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, result: null })
}

process.stdin.on('data', chunk => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const headerEnd = buf.indexOf('\r\n\r\n')
    if (headerEnd === -1) return
    const header = buf.slice(0, headerEnd).toString('utf8')
    const m = /Content-Length: (\d+)/i.exec(header)
    if (!m) {
      buf = buf.slice(headerEnd + 4)
      continue
    }
    const len = Number(m[1])
    const start = headerEnd + 4
    if (buf.length < start + len) return
    const body = buf.slice(start, start + len).toString('utf8')
    buf = buf.slice(start + len)
    try {
      onMessage(JSON.parse(body))
    } catch {
    }
  }
})
