import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { checkInstall, installPinned, planInstall } from './install.mjs'
import { loopbackEndpoint } from './control.mjs'

const text = (message, isError = false) => ({ content: [{ type: 'text', text: message }], ...(isError ? { isError: true } : {}) })
const json = value => text(JSON.stringify(value, null, 2))
export function installQuestion(plan) {
  return `Install ${plan.title} ${plan.version} (${plan.bytes.toLocaleString('en-US')} bytes) to ${plan.destination}?`
}
export function verifyInstallGrant(grant, plan, key, used = new Set()) {
  if (typeof grant !== 'string' || !key) return false
  try {
    const [encoded, signature] = grant.split('.')
    const expected = createHmac('sha256', key).update(encoded).digest('hex')
    if (!/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString())
    if (payload.digest !== plan.digest || payload.expires < Date.now() || used.has(payload.nonce)) return false
    used.add(payload.nonce)
    return true
  } catch { return false }
}

export function bootstrapTools(adapter, plan) {
  return [
    { name: 'craft_status', description: `Check ${adapter.title} installation without downloading or opening it.`, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
    { name: 'craft_install', description: `Install ${adapter.title} ${adapter.version}. Asks before downloading; does not open the app.`, inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true } },
    { name: 'craft_connect', description: `Attach to the ${adapter.title} window or launch it. Headless opens a separate session.`, inputSchema: { type: 'object', properties: { mode: { type: 'string', enum: ['attach', 'launch', 'headless'], default: 'attach' }, endpoint: { type: 'string' }, project: { type: 'string' }, library: { type: 'string' }, tokenFile: { type: 'string' }, readRoot: { type: 'string' }, writeRoot: { type: 'string' } }, additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false } },
  ]
}

export async function runCraftBridge(adapter, options = {}) {
  const dataDir = options.dataDir ?? process.env.MERCURY_EXTENSION_DATA
  if (!dataDir) throw new Error('MERCURY_EXTENSION_DATA is required')
  const plan = planInstall(adapter, { dataDir })
  if (process.argv.includes('--check')) {
    const result = await checkInstall(adapter, { dataDir })
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.state === 'installed' ? 0 : 2; return
  }
  const inputStream = options.input ?? process.stdin, output = options.output ?? process.stdout
  const send = message => { if (!closing && !output.destroyed) output.write(JSON.stringify(message) + '\n') }
  const result = (id, value) => send({ jsonrpc: '2.0', id, result: value })
  const error = (id, message, code = -32603) => send({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })
  const tools = bootstrapTools(adapter, plan), grants = new Set(), calls = new Map(), forwarded = new Map(), handlers = new Set()
  let initialize, child, attached, connection, upstreamInit, closing = false
  const privateId = `mercury-init-${randomUUID()}`
  const lineReader = createInterface({ input: inputStream, crlfDelay: Infinity })

  function endUpstream(note) {
    for (const [id, message] of forwarded) error(message.id, note)
    forwarded.clear()
    child = undefined; attached = undefined; connection = undefined
    if (!closing) send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  }
  async function connect(args, signal) {
    const mode = args.mode ?? 'attach'
    if (!['attach', 'launch', 'headless'].includes(mode)) throw new Error('Choose attach, launch or headless')
    if (child) {
      if (mode !== 'attach' || connection.input.mode === 'headless' || (args.endpoint && args.endpoint !== connection.endpoint) || forwarded.size) throw new Error('A session is already active. Finish its requests and end this MCP session before choosing another.')
      const context = { ...connection, input: { ...args, mode }, signal }
      const current = await adapter.probe(context)
      if (current?.identity !== adapter.id || current?.version !== adapter.version || !current?.project) throw new Error('Application identity, version or document could not be verified')
      attached = current; connection = context
      return text(`Attached to ${adapter.title} ${adapter.version} — ${attached.project}.`)
    }
    const checked = await checkInstall(adapter, { dataDir })
    if (checked.state !== 'installed') throw new Error(`${adapter.title} ${adapter.version} is not installed or failed verification. Use craft_install first.`)
    const installation = checked.installation
    const endpoint = args.endpoint ?? `127.0.0.1:${adapter.defaultPort}`
    loopbackEndpoint(endpoint)
    const context = { endpoint, dataDir, signal, installation, input: { ...args, mode } }
    if (mode === 'launch') {
      const gui = await adapter.launch(context)
      gui?.unref?.()
    }
    if (mode !== 'headless') {
      attached = await adapter.probe(context)
      if (attached?.identity !== adapter.id || attached?.version !== adapter.version || !attached?.project) throw new Error('Application identity, version or current document could not be verified')
    } else attached = { identity: adapter.id, version: adapter.version, project: args.project ?? args.library ?? 'new headless session', headless: true }
    connection = context
    const spec = adapter.upstream(context)
    const temp = join(dataDir, 'tmp'); await mkdir(temp, { recursive: true, mode: 0o700 })
    const environment = { ...process.env, TMPDIR: temp, TMP: temp, TEMP: temp, ...spec.env }
    delete environment.MERCURY_CRAFT_INSTALL_KEY
    const spawned = spawn(spec.command, spec.args, { env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    child = spawned
    spawned.stderr.on('data', bytes => process.stderr.write(bytes))
    const reader = createInterface({ input: spawned.stdout, crlfDelay: Infinity })
    spawned.on('error', e => { upstreamInit?.reject(e); endUpstream(`Command server failed: ${e.message}`) })
    spawned.on('exit', () => { upstreamInit?.reject(new Error('Command server exited during initialization')); endUpstream('Command server disconnected; the last edit may have completed. Inspect before retrying.') })
    reader.on('line', line => {
      try {
        const message = JSON.parse(line)
        if (message.id === privateId) {
          if (message.error) upstreamInit?.reject(new Error(message.error.message))
          else {
            spawned.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
            upstreamInit?.resolve(message.result)
          }
          return
        }
        const request = forwarded.get(String(message.id))
        if (request && !message.method) {
          forwarded.delete(String(message.id)); calls.delete(String(message.id))
          if (request.method === 'tools/list' && message.result?.tools && !request.params?.cursor) message.result.tools = [...tools, ...message.result.tools]
        }
        send(message)
      } catch { endUpstream('Command server returned invalid JSON. The last edit may have completed.'); spawned.kill() }
    })
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Command server initialization timed out. The app was left open.')), 15000)
      upstreamInit = { resolve: value => { clearTimeout(timer); resolve(value) }, reject: e => { clearTimeout(timer); reject(e) } }
    })
    spawned.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: privateId, method: 'initialize', params: initialize }) + '\n')
    try { await ready } catch (e) { spawned.kill(); throw e }
    finally { upstreamInit = undefined }
    signal.throwIfAborted()
    send({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    send({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' })
    return text(`${mode === 'headless' ? 'Headless session' : 'Attached to'} ${adapter.title} ${adapter.version} — ${attached.project}.`)
  }

  async function handle(message) {
    if (!message || message.jsonrpc !== '2.0' || (message.method !== undefined && typeof message.method !== 'string')) { error(message?.id, 'Invalid JSON-RPC request', -32600); return }
    const { id, method, params = {} } = message
    if (method === 'initialize') {
      if (initialize) { error(id, 'Already initialized', -32600); return }
      initialize = params
      result(id, { protocolVersion: params.protocolVersion, serverInfo: { name: `${adapter.id}-bootstrap`, version: adapter.version }, capabilities: { tools: { listChanged: true }, resources: { subscribe: true, listChanged: true }, prompts: { listChanged: true }, logging: {} }, instructions: `Use craft_status, then request craft_install if needed. Attach to the user's window with craft_connect. Never silently choose headless.` })
      return
    }
    if (!initialize) { error(id, 'Initialize first', -32000); return }
    if (method === 'notifications/cancelled') { calls.get(String(params.requestId))?.abort(); child?.stdin.write(JSON.stringify(message) + '\n'); return }
    if (method === 'notifications/initialized') return
    if (method === 'tools/call' && tools.some(t => t.name === params.name)) {
      const controller = new AbortController(); calls.set(String(id), controller)
      try {
        const args = params.arguments ?? {}
        if (params.name === 'craft_status') {
          const checked = await checkInstall(adapter, { dataDir })
          result(id, json({ app: adapter.title, version: adapter.version, state: checked.state, destination: plan.destination, bytes: plan.bytes, ...(attached ? { attached } : {}), ...(checked.reason ? { reason: checked.reason } : {}) }))
        } else if (params.name === 'craft_install') {
          const installed = await installPinned(adapter, { dataDir, signal: controller.signal, authorize: p => verifyInstallGrant(args._mercuryInstallGrant, p, process.env.MERCURY_CRAFT_INSTALL_KEY, grants), onProgress: (received, total, archive) => {
            if (params._meta?.progressToken !== undefined) send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: params._meta.progressToken, progress: received, total, message: archive } })
          } })
          result(id, text(`${adapter.title} ${adapter.version} ${installed.reused ? 'is already installed' : 'installed'} at ${installed.root}.`))
        } else result(id, await connect(args, controller.signal))
      } catch (e) { result(id, text(e.message, true)) }
      finally { calls.delete(String(id)) }
      return
    }
    if (child) {
      const controller = new AbortController()
      if (id !== undefined && method) calls.set(String(id), controller)
      try {
        if (method && id !== undefined && connection.input.mode !== 'headless') {
          const context = { ...connection, attached, signal: controller.signal }
          const current = adapter.verify ? await adapter.verify(context) : await adapter.probe(context)
          if (current?.identity !== attached.identity || current?.version !== attached.version || current?.project !== attached.project) throw new Error('The attached app or document changed. Inspect and reconnect before editing.')
        }
        controller.signal.throwIfAborted()
        if (id !== undefined && method) forwarded.set(String(id), message)
        if (!child) throw new Error('Command server disconnected before the request was sent')
        child.stdin.write(JSON.stringify(message) + '\n')
      } catch (e) { calls.delete(String(id)); error(id, e.message) }
      return
    }
    if (method === 'tools/list') result(id, { tools })
    else if (method === 'resources/list') result(id, { resources: [] })
    else if (method === 'resources/templates/list') result(id, { resourceTemplates: [] })
    else if (method === 'prompts/list') result(id, { prompts: [] })
    else if (method === 'ping') result(id, {})
    else if (id !== undefined) error(id, 'No application is attached. Use craft_connect.', -32000)
  }
  lineReader.on('line', line => {
    try {
      const task = handle(JSON.parse(line)).catch(e => { if (!closing) error(null, e.message) })
      handlers.add(task); void task.finally(() => handlers.delete(task))
    } catch { error(null, 'Invalid JSON', -32700) }
  })
  const stop = () => { closing = true; for (const controller of calls.values()) controller.abort(); lineReader.close() }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
  await new Promise(resolve => lineReader.on('close', resolve))
  stop()
  child?.kill()
  await Promise.allSettled([...handlers])
  process.off('SIGTERM', stop); process.off('SIGINT', stop)
  inputStream.pause?.()
}
