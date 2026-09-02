// ============================================================================
//  services/eval/jsRunnerSource — the bundled JavaScript kernel runner.
//
//  A plain .mjs written to the content-hash cache and spawned as a child
//  NODE process (never a worker sharing host memory, never a bun-only
//  API): protocol per protocol.ts — host frames on stdin, runner frames on
//  FD 3, user stdout/stderr raw on fd 1/2. Cells arrive ALREADY transformed
//  (jsCellTransform) and run as sloppy-mode async function bodies against
//  the runner's globalThis; __mercuryImport resolves specifiers against the
//  kernel cwd and cache-busts relative files per cell.
//
//  Cancellation contract: SIGINT while idle is a no-op (idle immunity);
//  SIGINT mid-cell aborts in-flight bridge waits and races the cell to a
//  cancelled `done` — await-shaped code yields promptly, a sync busy-loop
//  cannot be interrupted and is the host's escalation-kill case. The host
//  REPLACES a JS kernel after any cancelled cell: residual async work from
//  the cancelled cell cannot be stopped inside one JS runtime, so a fresh
//  kernel is the honest state (annotated to the model).
// ============================================================================

export const JS_RUNNER_SOURCE: string = `// Mercury eval kernel runner (generated; do not edit in place)
import { createInterface } from 'node:readline'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve as resolvePath, join as joinPath, isAbsolute } from 'node:path'
import { createWriteStream } from 'node:fs'
import { inspect } from 'node:util'

const proto = createWriteStream('', { fd: 3 })
let token = null
let currentCell = null
let execCount = 0
let bridgeSeq = 0
const bridgeWaits = new Map()
let cancelController = null

class KernelInterrupt extends Error {
  constructor() { super('cell interrupted') }
}

function emit(frame) {
  frame.token = token
  proto.write(JSON.stringify(frame) + '\\n')
}

function display(obj, mime) {
  const id = currentCell || ''
  if (typeof mime === 'string') {
    emit({ t: 'display', id, mime, data: String(obj) })
    return
  }
  if (obj && typeof obj === 'object' && !Array.isArray(obj) &&
      Object.keys(obj).length > 0 && Object.keys(obj).every(k => k.includes('/'))) {
    for (const key of Object.keys(obj)) emit({ t: 'display', id, mime: key, data: String(obj[key]) })
    return
  }
  emit({ t: 'display', id, mime: 'text/plain', data: inspect(obj, { depth: 4 }).slice(0, 100000) })
}

function displayMarkdown(text) {
  emit({ t: 'display', id: currentCell || '', mime: 'text/markdown', data: String(text) })
}

function displayJson(obj) {
  emit({ t: 'display', id: currentCell || '', mime: 'application/json', data: JSON.stringify(obj) })
}

function displayImage(data, mime) {
  const payload = Buffer.isBuffer(data) || data instanceof Uint8Array
    ? Buffer.from(data).toString('base64')
    : String(data)
  emit({ t: 'display', id: currentCell || '', mime: mime || 'image/png', data: payload, b64: true })
}

function bridge(kind, payload) {
  bridgeSeq += 1
  const bridgeId = 'b' + bridgeSeq
  return new Promise((resolve, reject) => {
    bridgeWaits.set(bridgeId, { resolve, reject })
    emit({ t: 'bridge', bridgeId, id: currentCell || '', kind, payload })
  })
}

const tool = new Proxy(function () {}, {
  apply(_target, _thisArg, args) {
    return bridge('tool', { name: String(args[0]), input: args[1] || {} })
  },
  get(_target, name) {
    if (typeof name !== 'string' || name.startsWith('_') || name === 'then') return undefined
    return (input) => bridge('tool', { name, input: input || {} })
  },
})

function agent(prompt, opts) {
  const o = opts || {}
  return bridge('agent', {
    prompt,
    agentType: o.agentType ?? null,
    label: o.label ?? null,
    schema: o.schema ?? null,
    strict: o.strict !== false,
    worktree: Boolean(o.worktree),
  })
}

function completion(prompt, opts) {
  const o = opts || {}
  return bridge('completion', {
    prompt,
    system: o.system ?? null,
    model: o.model ?? null,
    tier: o.tier ?? null,
    schema: o.schema ?? null,
  })
}

async function parallel(thunks, opts) {
  const list = Array.from(thunks)
  if (list.length === 0) return []
  const o = opts || {}
  let width = o.width || (await bridge('width', {})) || 2
  width = Math.max(1, Math.min(Number(width) || 2, list.length))
  const results = new Array(list.length)
  const states = new Array(list.length)
  let next = 0
  async function worker() {
    for (;;) {
      const i = next
      next += 1
      if (i >= list.length) return
      try {
        results[i] = await list[i]()
        states[i] = 'ok'
      } catch (error) {
        states[i] = { error }
      }
    }
  }
  await Promise.all(Array.from({ length: width }, () => worker()))
  for (let i = 0; i < states.length; i++) {
    const s = states[i]
    if (s && s !== 'ok') throw s.error // input order preserved; lowest index wins
  }
  return results
}

async function pipeline(items, ...stages) {
  let current = Array.from(items)
  for (const stage of stages) {
    current = await parallel(current.map(item => () => stage(item)))
  }
  return current
}

function readFile(path, extra) {
  const abs = isAbsolute(path) ? path : resolvePath(process.cwd(), path)
  return bridge('tool', { name: 'Read', input: Object.assign({ file_path: abs }, extra || {}) })
}

function writeFile(path, content) {
  const abs = isAbsolute(path) ? path : resolvePath(process.cwd(), path)
  return bridge('tool', { name: 'Write', input: { file_path: abs, content } })
}

async function __mercuryImport(spec) {
  if (typeof spec !== 'string' || spec === '') throw new Error('import needs a specifier')
  if (spec.startsWith('node:')) return import(spec)
  if (spec.startsWith('./') || spec.startsWith('../') || isAbsolute(spec)) {
    const abs = resolvePath(process.cwd(), spec)
    return import(pathToFileURL(abs).href + '?mercuryEval=' + execCount)
  }
  try {
    const resolver = createRequire(joinPath(process.cwd(), '__mercury_resolver__.js'))
    const resolved = resolver.resolve(spec)
    if (isAbsolute(resolved)) return import(pathToFileURL(resolved).href)
    return import(resolved) // node builtins resolve to their own name
  } catch {
    return import(spec)
  }
}

Object.assign(globalThis, {
  display,
  display_markdown: displayMarkdown,
  displayMarkdown,
  display_json: displayJson,
  displayJson,
  display_image: displayImage,
  displayImage,
  tool,
  agent,
  completion,
  parallel,
  pipeline,
  readFile,
  writeFile,
  read_file: readFile,
  write_file: writeFile,
  __mercuryImport,
})

const AsyncFunction = (async () => {}).constructor

async function runCell(id, code) {
  currentCell = id
  execCount += 1
  emit({ t: 'started', id })
  let status = 'ok'
  let cancelled = false
  cancelController = new AbortController()
  const signal = cancelController.signal
  try {
    const fn = new AsyncFunction(code)
    await Promise.race([
      fn.call(globalThis),
      new Promise((_resolve, reject) => {
        if (signal.aborted) reject(new KernelInterrupt())
        else signal.addEventListener('abort', () => reject(new KernelInterrupt()), { once: true })
      }),
    ])
    if (globalThis.__mercuryResult !== undefined) {
      emit({ t: 'result', id, repr: inspect(globalThis.__mercuryResult, { depth: 4 }).slice(0, 10000) })
    }
  } catch (error) {
    if (error instanceof KernelInterrupt) {
      status = 'cancelled'
      cancelled = true
      emit({ t: 'error', id, name: 'Interrupt', value: 'cell interrupted', traceback: '' })
    } else {
      status = 'error'
      emit({
        t: 'error',
        id,
        name: (error && error.constructor && error.constructor.name) || 'Error',
        value: String((error && error.message) !== undefined ? error.message : error).slice(0, 2000),
        traceback: String((error && error.stack) || '').slice(0, 8000),
      })
    }
  } finally {
    delete globalThis.__mercuryResult
    currentCell = null
    cancelController = null
  }
  await endMarks(id)
  emit({ t: 'done', id, status, cancelled })
}

// The cell's end mark on fd 1 AND fd 2, landed (the write callbacks fire on
// flush — the stdio pipes are asynchronous on this platform family) ahead of
// the done frame: the host settles the cell only once both marks have
// arrived, so a done frame on fd 3 can never overtake the cell's last
// output bytes on the data pipes.
function endMarks(id) {
  const mark = '\\x1fmercury-eval-end ' + id + ' ' + token + '\\x1f'
  return new Promise(resolve => {
    let pending = 2
    const one = () => { if (--pending === 0) resolve() }
    for (const stream of [process.stdout, process.stderr]) {
      try {
        stream.write(mark, one)
      } catch {
        one()
      }
    }
  })
}

process.on('SIGINT', () => {
  // Idle immunity: a stray SIGINT between cells is a no-op.
  if (currentCell === null) return
  for (const [bridgeId, wait] of bridgeWaits) {
    bridgeWaits.delete(bridgeId)
    wait.reject(new KernelInterrupt())
  }
  if (cancelController) cancelController.abort()
})

const queue = []
let running = false
async function pump() {
  if (running) return
  running = true
  while (queue.length > 0) {
    const msg = queue.shift()
    if (msg.t === 'hello') {
      token = msg.token
      if (msg.cwd) {
        try { process.chdir(msg.cwd) } catch {}
      }
      globalThis.env = Object.freeze(Object.assign({}, process.env))
      emit({ t: 'ready' })
    } else if (msg.t === 'exec') {
      await runCell(String(msg.id), String(msg.code))
    } else if (msg.t === 'bye') {
      process.exit(0)
    }
  }
  running = false
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', line => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.t === 'bridge_result') {
    const wait = bridgeWaits.get(msg.bridgeId)
    if (wait) {
      bridgeWaits.delete(msg.bridgeId)
      if (msg.ok) wait.resolve(msg.value)
      else wait.reject(new Error(String(msg.error || 'bridge call failed')))
    }
    return
  }
  queue.push(msg)
  void pump()
})
rl.on('close', () => process.exit(0))
`
