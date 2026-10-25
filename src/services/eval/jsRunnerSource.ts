
export const JS_RUNNER_SOURCE: string = `// Mercury eval kernel runner (generated; do not edit in place)
import { createInterface } from 'node:readline'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve as resolvePath, join as joinPath, dirname as dirnamePath, basename as basenamePath, isAbsolute, sep as pathSep } from 'node:path'
import { homedir as osHomedir } from 'node:os'
import { createWriteStream } from 'node:fs'
import { inspect } from 'node:util'

const proto = createWriteStream('', { fd: 3 })
let token = null
let currentCell = null
const cjsFs = createRequire(import.meta.url)('node:fs')
const origRealpath = cjsFs.realpathSync.bind(cjsFs)
function checkFloorPath(rawPath, writing) {
  if (!currentCell || (typeof rawPath !== 'string' && !Buffer.isBuffer(rawPath) && !(rawPath instanceof URL))) return
  const str = rawPath instanceof URL ? (rawPath.protocol === 'file:' ? decodeURIComponent(rawPath.pathname) : '') : String(rawPath).trim()
  if (!str) return
  const abs = isAbsolute(str) ? str : resolvePath(process.cwd(), str)
  const forms = new Set([abs.replace(/\\\\/g, '/').replace(/\\/$/, '').toLowerCase()])
  try { forms.add(origRealpath(abs).replace(/\\\\/g, '/').replace(/\\/$/, '').toLowerCase()) } catch {
    try { forms.add(joinPath(origRealpath(dirnamePath(abs)), basenamePath(abs)).replace(/\\\\/g, '/').replace(/\\/$/, '').toLowerCase()) } catch {}
  }
  const dotHome = '.' + 'mercury'
  const homes = [process.env.MERCURY_CONFIG_DIR, process.env.MERCURY_HOME, joinPath(process.env.HOME || osHomedir(), dotHome)].filter(Boolean).flatMap(h => {
    const out = [String(h).replace(/\\\\/g, '/').replace(/\\/$/, '').toLowerCase()]
    try { out.push(origRealpath(h).replace(/\\\\/g, '/').replace(/\\/$/, '').toLowerCase()) } catch {}
    return out
  })
  const uHomes = [process.env.HOME, process.env.USERPROFILE, osHomedir()].filter(Boolean).flatMap(h => {
    const out = [String(h).replace(/\\\\/g, '/').replace(/\\/$/, '').toLowerCase()]
    try { out.push(origRealpath(h).replace(/\\\\/g, '/').replace(/\\/$/, '').toLowerCase()) } catch {}
    return out
  })
  for (const c of forms) {
    const parent = dirnamePath(c), name = basenamePath(c)
    if ((homes.includes(parent) || parent.endsWith('/' + dotHome)) && (/^(?:\\.credentials\\.json|\\.provider-secrets\\.json)(?:\\.corrupt\\.[^/]+)?$/.test(name) || /^.+-auth\\.json$/.test(name) || name === 'browser-secrets.json')) {
      throw new Error('Reading or writing ' + str + ' is refused: ' + c + " holds Mercury's own credentials.")
    }
    if (writing) {
      if (homes.some(h => c === h + '/runtime' || c.startsWith(h + '/runtime/'))) throw new Error('Writing ' + str + ' is refused: ' + c + " is part of Mercury's running runtime.")
      const sys = c.replace(/^\\/private\\/etc(?=\\/|$)/, '/etc')
      if (['/etc/sudoers', '/etc/passwd', '/etc/shadow'].includes(sys) || ['/etc/sudoers.d', '/etc/systemd', '/library/keychains'].some(b => sys === b || sys.startsWith(b + '/'))) {
        throw new Error('Writing ' + str + ' is refused: ' + c + ' is a protected system or credential path.')
      }
      for (const uh of uHomes) {
        if (['.netrc', '.pgpass', '.npmrc', '.pypirc', '.git-credentials'].some(f => c === uh + '/' + f) || ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.config/gh', '.config/gcloud', 'library/keychains', '.local/share/keyrings'].some(d => c === uh + '/' + d || c.startsWith(uh + '/' + d + '/'))) {
          throw new Error('Writing ' + str + ' is refused: ' + c + ' is a protected system or credential path.')
        }
      }
    }
  }
}
for (const fn of ['readFileSync', 'readFile', 'createReadStream']) {
  const orig = cjsFs[fn].bind(cjsFs)
  cjsFs[fn] = (p, ...rest) => { checkFloorPath(p, false); return orig(p, ...rest) }
}
for (const fn of ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'createWriteStream', 'unlinkSync', 'unlink', 'rmSync', 'rm', 'rmdirSync', 'rmdir', 'truncateSync', 'truncate', 'chmodSync', 'chmod']) {
  const orig = cjsFs[fn].bind(cjsFs)
  cjsFs[fn] = (p, ...rest) => { checkFloorPath(p, true); return orig(p, ...rest) }
}
for (const fn of ['copyFileSync', 'copyFile', 'renameSync', 'rename']) {
  const orig = cjsFs[fn].bind(cjsFs)
  cjsFs[fn] = (src, dst, ...rest) => { checkFloorPath(src, fn.startsWith('rename')); checkFloorPath(dst, true); return orig(src, dst, ...rest) }
}
if (cjsFs.promises) {
  const origPRead = cjsFs.promises.readFile.bind(cjsFs.promises)
  cjsFs.promises.readFile = async (p, ...rest) => { checkFloorPath(p, false); return origPRead(p, ...rest) }
  for (const fn of ['writeFile', 'appendFile', 'unlink', 'rm', 'rmdir', 'truncate', 'chmod']) {
    const orig = cjsFs.promises[fn].bind(cjsFs.promises)
    cjsFs.promises[fn] = async (p, ...rest) => { checkFloorPath(p, true); return orig(p, ...rest) }
  }
}
syncBuiltinESMExports()
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

// tool.attempt.Name(input) / tool.attempt('Name', input): the error as a
// value — { ok: true, value } or { ok: false, error } — so a batch of calls
// finishes and reports each outcome instead of failing whole at the first.
function attemptCall(name, input) {
  return bridge('tool', { name, input: input || {} }).then(
    value => ({ ok: true, value }),
    error => ({ ok: false, error: String(error && error.message !== undefined ? error.message : error) }),
  )
}
const attempt = new Proxy(function () {}, {
  apply(_target, _thisArg, args) {
    return attemptCall(String(args[0]), args[1])
  },
  get(_target, name) {
    if (typeof name !== 'string' || name.startsWith('_') || name === 'then') return undefined
    return (input) => attemptCall(name, input)
  },
})
const tool = new Proxy(function () {}, {
  apply(_target, _thisArg, args) {
    return bridge('tool', { name: String(args[0]), input: args[1] || {} })
  },
  get(_target, name) {
    if (typeof name !== 'string' || name.startsWith('_') || name === 'then') return undefined
    if (name === 'attempt') return attempt
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
  const o = opts || {}
  if (list.length === 0) return o.settled ? (parallel.results = []) : []
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
  if (o.settled) {
    const failed = []
    parallel.results = states.map((state, i) => {
      if (state === 'ok') return { ok: true, value: results[i] }
      failed.push(i)
      const e = state.error
      return { ok: false, error: {
        kind: e instanceof KernelInterrupt || e?.name === 'AbortError' ? 'cancelled' : e?.kind || 'error',
        name: e?.name || 'Error', message: String(e?.message ?? e),
      } }
    })
    if (failed.length) console.log('Parallel failed indices (0-based): ' + failed.join(', ') + '; results remain in parallel.results.')
    return parallel.results
  }
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
  sample: spec => bridge('sample', spec),
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

async function runCell(id, code, names) {
  currentCell = id
  execCount += 1
  emit({ t: 'started', id })
  let status = 'ok'
  let cancelled = false
  cancelController = new AbortController()
  const signal = cancelController.signal
  try {
    const require = createRequire(joinPath(process.cwd(), '__mercury_eval__.js'))
    for (const path of Object.keys(require.cache)) {
      if (!path.split(pathSep).includes('node_modules')) delete require.cache[path]
    }
    globalThis.require = require
    globalThis.__mercuryPersistedNames = []
    const fn = new AsyncFunction(code)
    const returned = await Promise.race([
      fn.call(globalThis),
      new Promise((_resolve, reject) => {
        if (signal.aborted) reject(new KernelInterrupt())
        else signal.addEventListener('abort', () => reject(new KernelInterrupt()), { once: true })
      }),
    ])
    const result = globalThis.__mercuryResult !== undefined ? globalThis.__mercuryResult : returned
    if (result !== undefined) {
      emit({ t: 'result', id, repr: inspect(result, { depth: 4 }).slice(0, 10000) })
    }
  } catch (error) {
    if (error instanceof KernelInterrupt) {
      status = 'cancelled'
      cancelled = true
      emit({ t: 'error', id, name: 'Interrupt', value: 'cell interrupted', traceback: '' })
    } else {
      status = 'error'
      // Only bindings initialized by this cell count; an older global with
      // the same name does not prove that this declaration initialized.
      const survived = (Array.isArray(names) ? names : []).filter(n => globalThis.__mercuryPersistedNames.includes(n))
      emit({
        t: 'error',
        id,
        name: (error && error.constructor && error.constructor.name) || 'Error',
        value: String((error && error.message) !== undefined ? error.message : error).slice(0, 2000),
        traceback: String((error && error.stack) || '').slice(0, 8000),
        survived,
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
      await runCell(String(msg.id), String(msg.code), msg.names)
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
      else wait.reject(Object.assign(new Error(String(msg.error || 'bridge call failed')), { kind: msg.errorKind || 'error' }))
    }
    return
  }
  queue.push(msg)
  void pump()
})
rl.on('close', () => process.exit(0))
`
