import { parentPort, workerData } from 'node:worker_threads'
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, openSync, readFileSync, readSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const { pack, input, directory, query, offset, limit, raw, compact, sourceLines } = workerData
const control = new Int32Array(input, 0, 2)
const channel = new Uint8Array(input, 8)
const pageStop = new Error('page complete')
const owned = new Set()
const openOwned = (path, mode) => { const handle = openSync(path, mode, 0o600); owned.add(handle); return handle }
const closeOwned = handle => { closeSync(handle); owned.delete(handle) }
const write = (handle, bytes) => { let at = 0; while (at < bytes.length) at += writeSync(handle, bytes, at, bytes.length - at) }
const clean = text => text.replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')

function framedQuery(program) {
  let at = 0, prefix = 0
  const skip = () => {
    while (at < program.length) {
      if (/\s/.test(program[at])) at++
      else if (program[at] === '#') { const end = program.indexOf('\n', at); at = end < 0 ? program.length : end + 1 }
      else break
    }
  }
  for (;;) {
    skip()
    if (!/^(?:module|import|include)\b/.test(program.slice(at))) break
    let quoted = false, escaped = false, depth = 0, ended = false
    for (; at < program.length; at++) {
      const c = program[at]
      if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue }
      if (c === '"') quoted = true
      else if (c === '#') { const end = program.indexOf('\n', at); at = end < 0 ? program.length : end }
      else if ('([{'.includes(c)) depth++
      else if (')]}'.includes(c)) depth--
      else if (c === ';' && depth === 0) { prefix = ++at; ended = true; break }
    }
    if (!ended) break
  }
  const name = `__mercury_read_${randomBytes(8).toString('hex')}`
  return `${program.slice(0, prefix)}\ndef ${name}(f): input_line_number as $line | f as $value | [$line, input_line_number, $value];\n${name}((\n${program.slice(prefix)}\n))`
}

try {
  const lock = JSON.parse(readFileSync(join(pack, '.vendor-manifest.json'), 'utf8'))
  const wasmBytes = readFileSync(join(pack, 'dist/build/jq.wasm'))
  const expected = lock.files.find(file => file.path === 'dist/build/jq.wasm')
  if (createHash('sha256').update(wasmBytes).digest('hex') !== expected?.sha256) throw new Error('The JSON query engine differs from its pinned bytes.')
  const compiled = await WebAssembly.compile(wasmBytes)
  const { loadJq } = await import(pathToFileURL(join(pack, 'dist/index.mjs')).href)
  let memoryBytes = 0
  async function execute(read, output, expression, flags) {
    let memory
    let diagnostics = ''
    let diagnosticBytes = 0
    const engine = await loadJq({ instantiateWasm(imports, ready) {
      const host = imports[lock.abi.imports]
      if (!host || typeof host[lock.abi.read] !== 'function' || typeof host[lock.abi.write] !== 'function') throw new Error('The JSON query engine streaming ABI differs from its pin.')
      host[lock.abi.read] = (_input, vectors, count, got) => {
        const words = new Uint32Array(memory.buffer)
        let total = 0
        for (let i = 0; i < count; i++) {
          const start = words[(vectors >> 2) + i * 2]
          const size = Math.min(words[(vectors >> 2) + i * 2 + 1], 65536)
          if (size === 0) continue
          const length = read(Buffer.from(memory.buffer, start, size))
          total += length
          if (length < size) break
        }
        words[got >> 2] = total
        return 0
      }
      host[lock.abi.write] = (channel, vectors, count, got) => {
        const words = new Uint32Array(memory.buffer)
        let total = 0
        for (let i = 0; i < count; i++) {
          const start = words[(vectors >> 2) + i * 2], size = words[(vectors >> 2) + i * 2 + 1]
          const bytes = Buffer.from(memory.buffer, start, size)
          if (channel === 1) output(bytes)
          else {
            diagnosticBytes += size
            if (diagnostics.length < 8192) diagnostics += bytes.subarray(0, Math.max(0, 8192 - diagnostics.length)).toString('utf8')
          }
          total += size
        }
        words[got >> 2] = total
        return 0
      }
      const instance = new WebAssembly.Instance(compiled, imports)
      memory = instance.exports[lock.abi.memory]
      if (!(memory instanceof WebAssembly.Memory)) throw new Error('The JSON query engine memory ABI differs from its pin.')
      ready(instance)
    } })
    let status = 0, stopped = false
    try { status = engine.raw('', expression, [...flags, '--']).exitCode ?? 0 }
    catch (error) { if (error !== pageStop) throw error; stopped = true }
    memoryBytes = Math.max(memoryBytes, memory.buffer.byteLength)
    return { status, stopped, diagnostics: clean(diagnostics) + (diagnosticBytes > 8192 ? '\n[diagnostic truncated]' : '') }
  }
  const firstPath = join(directory, 'first.json')
  const pagePath = join(directory, 'page.jsonl')
  const outputPath = join(directory, 'output.txt')
  const first = openOwned(firstPath, 'w')
  const page = openOwned(pagePath, 'w')
  const originsPath = sourceLines ? join(directory, 'origins.jsonl') : undefined
  const origins = sourceLines ? openOwned(originsPath, 'w') : null
  let origin = null, firstOrigin = null
  let sourceBytes = 0, total = 0, firstByte = null, currentBytes = 0
  let lastLine = false, lastDepth = 0, lastQuoted = false, lastEscaped = false, lastWhole = false
  const readSource = bytes => {
    Atomics.store(control, 0, 0)
    parentPort.postMessage({ read: bytes.length })
    Atomics.wait(control, 0, 0)
    const got = Atomics.load(control, 1)
    if (got < 0) throw new Error('The query source stream failed.')
    if (got > 0) {
      bytes.set(channel.subarray(0, got))
      if (sourceBytes === 0) parentPort.postMessage({ started: true })
      sourceBytes += got
      if (sourceLines) {
        const newline = bytes.lastIndexOf(10, got - 1)
        if (newline >= 0) { lastDepth = 0; lastQuoted = false; lastEscaped = false; lastWhole = false }
        lastLine = newline < got - 1
        for (let at = newline + 1; at < got; at++) {
          const c = bytes[at]
          if (lastQuoted) {
            if (lastEscaped) lastEscaped = false
            else if (c === 92) lastEscaped = true
            else if (c === 34) { lastQuoted = false; if (lastDepth === 0) lastWhole = true }
          } else if (c === 34) lastQuoted = true
          else if (c === 123 || c === 91) lastDepth++
          else if ((c === 125 || c === 93) && lastDepth > 0 && --lastDepth === 0) lastWhole = true
        }
      }
    } else if (lastLine && (lastWhole || (lastDepth === 0 && !lastQuoted))) {
      lastLine = false
      bytes[0] = 10
      return 1
    }
    return got
  }
  const accept = bytes => {
    let start = 0
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start)
      const end = newline < 0 ? bytes.length : newline + 1
      const piece = bytes.subarray(start, end)
      if (firstByte === null && total === 0 && piece.length > 0) firstByte = piece[0]
      if (total === 0) write(first, piece)
      if (total >= offset && total < offset + limit) write(page, piece)
      currentBytes += piece.length
      if (newline >= 0) {
        if (origin !== null) {
          if (total === 0) firstOrigin = origin
          if (total >= offset && total < offset + limit) write(origins, Buffer.from(`${JSON.stringify(origin)}\n`))
        }
        total++
        currentBytes = 0
        if (total >= Math.max(2, offset + limit + 1)) throw pageStop
      }
      start = end
    }
  }
  let prefix = '', commas = 0, held = null
  const framedOutput = bytes => {
    let at = 0
    while (at < bytes.length) {
      const newline = bytes.indexOf(10, at)
      const end = newline < 0 ? bytes.length : newline
      let piece = bytes.subarray(at, end)
      if (origin === null) {
        let used = 0
        while (used < piece.length && commas < 2) {
          const byte = piece[used++]
          prefix += String.fromCharCode(byte)
          if (byte === 44) commas++
          if (prefix.length > 128) throw new Error('The JSON query engine returned an invalid source-line frame.')
        }
        piece = piece.subarray(used)
        if (commas === 2) {
          const pair = /^\[(\d+),(\d+),$/.exec(prefix)
          if (!pair) throw new Error('The JSON query engine returned an invalid source-line frame.')
          origin = [Number(pair[1]), Number(pair[2])]
        }
      }
      if (piece.length > 0) {
        if (held !== null) accept(held)
        if (piece.length > 1) accept(piece.subarray(0, piece.length - 1))
        held = Buffer.from(piece.subarray(piece.length - 1))
      }
      if (newline >= 0) {
        if (origin === null || held?.[0] !== 93) throw new Error('The JSON query engine left an incomplete source-line frame.')
        accept(Buffer.from('\n'))
        prefix = ''; commas = 0; held = null; origin = null
      }
      at = newline < 0 ? bytes.length : newline + 1
    }
  }
  const firstRun = await execute(readSource, sourceLines ? framedOutput : accept, sourceLines ? framedQuery(query) : query, ['-c'])
  closeOwned(first)
  closeOwned(page)
  if (origins !== null) closeOwned(origins)
  if (currentBytes !== 0) throw new Error('The JSON query engine left an incomplete output value.')
  const array = total === 1 && firstByte === 91
  const selected = openOwned(array ? firstPath : pagePath, 'r')
  const rendered = openOwned(outputPath, 'w')
  let renderAt = 0, countText = '', arrayCount = null, outputBytes = 0, outputLines = 0, lastByte = null
  const rendering = await execute(bytes => {
    const got = readSync(selected, bytes, 0, bytes.length, renderAt)
    renderAt += got
    return got
  }, bytes => {
    if (array && arrayCount === null) {
      const end = bytes.indexOf(10)
      if (end < 0) { countText += bytes.toString('utf8'); return }
      countText += bytes.subarray(0, end).toString('utf8')
      arrayCount = Number(countText)
      if (!Number.isSafeInteger(arrayCount) || arrayCount < 0) throw new Error('The JSON query engine returned an invalid array length.')
      bytes = bytes.subarray(end + 1)
    }
    if (bytes.length === 0) return
    write(rendered, bytes)
    outputBytes += bytes.length
    lastByte = bytes[bytes.length - 1]
    for (const byte of bytes) if (byte === 10) outputLines++
  }, array ? `length, .[${offset}:${offset + limit}]` : '.', [...(raw ? ['-r'] : []), ...(compact ? ['-c'] : [])])
  closeOwned(selected)
  closeOwned(rendered)
  if (lastByte !== null && lastByte !== 10) outputLines++
  if (rendering.status !== 0) throw new Error(rendering.diagnostics || 'The JSON query output could not be rendered.')
  const shown = array ? Math.min(limit, Math.max(0, arrayCount - offset)) : Math.max(0, Math.min(total - offset, limit))
  if (sourceLines && array) {
    const group = openOwned(originsPath, 'w')
    if (shown > 0 && firstOrigin !== null) write(group, Buffer.from(`${JSON.stringify(firstOrigin)}\n`))
    closeOwned(group)
  }
  const hasMore = array ? arrayCount > offset + shown : firstRun.stopped || total > offset + shown
  parentPort.postMessage({ result: { outputPath, outputBytes, outputLines, shown, hasMore, array, sourceBytes, memoryBytes, ...(originsPath ? { originsPath } : {}), diagnostics: firstRun.diagnostics, status: firstRun.status, stopped: firstRun.stopped } })
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) })
} finally {
  for (const handle of owned) { try { closeSync(handle) } catch {} }
}
