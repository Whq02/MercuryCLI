#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { computeActiveSet, publishActiveSet } from '../../src/extensions/active.js'
import { getExtensionSkills, clearExtensionCommandCaches } from '../../src/extensions/load/commands.js'
import { validateManifest } from '../../src/extensions/manifest.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1] }
const base = arg('--scratch') ?? process.env.TMPDIR ?? process.env.TEMP
assert(base && isAbsolute(base), 'Pass --scratch <isolated absolute folder>')
mkdirSync(base, { recursive: true })
const scratch = mkdtempSync(join(base, 'photocraft-static-'))
const delivered = join(scratch, 'extension'), dataDir = join(scratch, 'data')
const shared = arg('--shared-dir') ?? join(root, 'src/extensions/bundled/shared')
cpSync(join(root, 'src/extensions/bundled/photocraft'), delivered, { recursive: true })
cpSync(shared, join(delivered, 'shared'), { recursive: true })
const adapterModule = await import(pathToFileURL(join(delivered, 'server/install.mjs')).href)
const { adapter, scopedRoots, endpointParts, prepareControl, readPrivateToken, inspectControl, upstream } = adapterModule
const sharedInstall = await import(pathToFileURL(join(delivered, 'shared/install.mjs')).href)
let passed = 0
function check(label: string, action: () => unknown) { action(); passed++; console.log(`PASS ${label}`) }
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const manifest = JSON.parse(readFileSync(join(delivered, 'mercury-extension.json'), 'utf8'))

try {
  check('declarative manifest uses shared Node launcher without missing-app prerequisites', () => {
    assert.equal(manifest.name, 'photocraft'); assert.equal(manifest.contributes.servers.app.command, '${MERCURY_NODE}')
    assert.deepEqual(Object.keys(manifest.contributes).sort(), ['servers', 'skills'])
    assert(!manifest.module && !manifest.install && !manifest.needs.binaries)
  })
  check('release plans bind exact app/CLI version, URL, bytes and hash', () => {
    for (const pin of adapter.pins) sharedInstall.validatePin(pin)
    const mac = sharedInstall.planInstall(adapter, { dataDir, platform: 'darwin-arm64' })
    assert.equal(mac.payloads.length, 2); assert.equal(mac.bytes, 166288476)
    for (const platform of ['win-x64', 'linux-x64']) assert.equal(sharedInstall.planInstall(adapter, { dataDir, platform }).payloads.length, 1)
    const broken = structuredClone(adapter.pins[0]); broken.platforms['darwin-arm64'].url = broken.platforms['darwin-arm64'].url.replace('v0.14.0', 'latest')
    assert.throws(() => sharedInstall.validatePin(broken))
  })
  check('supplemental notices retain exact tagged bytes and provenance', () => {
    for (const notice of adapter.notices) { assert.equal(hash(notice.content), notice.sha256); assert.equal(notice.source, `${adapter.pins[0].repository}/blob/v0.14.0/${notice.name}`) }
  })
  const readRoot = join(scratch, 'project'), writeRoot = join(scratch, 'outputs')
  mkdirSync(readRoot); mkdirSync(writeRoot)
  check('roots are explicit, existing project folders; no home or disk-wide scope', () => {
    assert.deepEqual(scopedRoots({ readRoot, writeRoot }), { readRoot, writeRoot })
    assert.throws(() => scopedRoots({ readRoot: '/', writeRoot })); assert.throws(() => scopedRoots({ readRoot: homedir(), writeRoot }))
    assert.throws(() => scopedRoots({ readRoot: 'relative', writeRoot })); assert.throws(() => scopedRoots({ readRoot }))
    assert.throws(() => endpointParts('0.0.0.0:7878')); assert.throws(() => endpointParts('127.0.0.1:65536'))
  })
  const tokenFile = prepareControl(dataDir)
  check('desktop creates the token, not discovery or the adapter', () => assert(!existsSync(tokenFile)))
  const token = 'a'.repeat(64)
  writeFileSync(tokenFile, token, { mode: 0o600 })
  check('private credential validation does not change the token', () => assert.equal(readPrivateToken(tokenFile), token))
  if (process.platform !== 'win32') {
    chmodSync(tokenFile, 0o644)
    check('public token files are refused', () => assert.throws(() => readPrivateToken(tokenFile), /only by the current user/))
    chmodSync(tokenFile, 0o600)
    const linked = join(scratch, 'token-link'); symlinkSync(tokenFile, linked)
    check('token symlinks are refused', () => assert.throws(() => readPrivateToken(linked), /regular file/))
  }
  check('bridge argv carries only the credential file path, never its value', () => {
    const spec = upstream({ installation: { cli: 'photocraft-cli' }, endpoint: '127.0.0.1:7878', dataDir, input: { mode: 'attach' } })
    assert.deepEqual(spec.args, ['mcp', '--bridge', '127.0.0.1:7878', '--control-token-file', tokenFile])
    assert(!JSON.stringify(spec).includes(token)); assert(!spec.args.includes('--control-token'))
    assert.equal(spec.env.PHOTOCRAFT_CONTROL_TOKEN, undefined, 'An empty token environment variable conflicts with the token-file flag')
  })
  let authAccepted = true, omitResponse = false, calls: string[] = []
  const server = createServer(socket => {
    createInterface({ input: socket }).on('line', line => {
      const request = JSON.parse(line); calls.push(request.method)
      if (omitResponse) return
      socket.write(JSON.stringify(request.method === 'auth'
        ? { id: request.id, ok: authAccepted && request.params.token === token }
        : { id: request.id, ok: true, result: { window: { width: 100 }, session: {}, document: null } }) + '\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const state = await inspectControl({ endpoint, tokenFile }); assert.equal(state.document, null); assert.deepEqual(calls, ['auth', 'ui.inspect'])
    console.log('PASS attachment authenticates then reads UI state, without edits'); passed++
    authAccepted = false; calls = []
    await assert.rejects(inspectControl({ endpoint, tokenFile }), /authentication failed/); assert.deepEqual(calls, ['auth'])
    console.log('PASS wrong credentials reveal no token and send no app request'); passed++
    omitResponse = true; calls = []
    await assert.rejects(inspectControl({ endpoint, tokenFile, timeoutMs: 40 }), /No edit was sent/); assert.deepEqual(calls, ['auth'])
    console.log('PASS attachment timeout is bounded and never retried'); passed++
  } finally { server.close() }

  const clean = join(scratch, 'discovery-data')
  const child = spawn(process.env.MERCURY_NODE ?? 'node', [join(delivered, 'server/bridge.mjs')], { env: { ...process.env, MERCURY_EXTENSION_DATA: clean, MERCURY_CRAFT_INSTALL_KEY: '' }, stdio: ['pipe', 'pipe', 'pipe'] })
  let id = 0, stderr = ''
  const waiters = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  child.stderr.on('data', data => { stderr += data })
  createInterface({ input: child.stdout }).on('line', line => { const message = JSON.parse(line), waiter = waiters.get(message.id); if (waiter) { waiters.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message) } })
  const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => { const next = ++id, timer = setTimeout(() => reject(new Error(`MCP timeout: ${stderr}`)), 10000); waiters.set(next, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: next, method, params }) + '\n') })
  try {
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'photocraft-static', version: '1' } })
    const tools = await request('tools/list', {})
    check('missing-app discovery exposes actionable tools and performs no installation', () => { assert.deepEqual(tools.result.tools.map((t: any) => t.name), ['craft_status', 'craft_install', 'craft_connect']); assert(!existsSync(clean)) })
    await request('tools/call', { name: 'craft_status', arguments: {} }); assert(!existsSync(clean))
    const denied = await request('tools/call', { name: 'craft_install', arguments: {} })
    check('denied install writes nothing and has no hidden discovery retry', () => { assert.equal(denied.result.isError, true); assert(!existsSync(clean)) })
    await request('tools/list', {}); assert(!existsSync(clean))
  } finally { child.stdin.end(); child.kill(); for (const waiter of waiters.values()) clearTimeout(waiter.timer) }

  process.env.MERCURY_CONFIG_DIR = join(scratch, 'mercury-config')
  const active = computeActiveSet({ cwd: scratch, sessionPaths: [delivered] }); publishActiveSet(active); clearExtensionCommandCaches()
  const skill = getExtensionSkills().find(s => s.name === 'photocraft:photocraft')
  assert(skill && skill.type === 'prompt')
  const prompt = await skill.getPromptForCommand('Crop the open PhotoCraft image and export a PNG')
  check('real extension loader discovers the skill and expands supplied arguments', () => {
    assert.equal(skill.source, 'extension'); assert(prompt[0]?.type === 'text' && prompt[0].text.includes('Crop the open PhotoCraft image and export a PNG'))
    assert.match(skill.description, /PhotoCraft image/); assert.match(skill.description, /Not for video editing/)
    assert(prompt[0]?.type === 'text' && prompt[0].text.includes('Trim the video timeline'))
  })
  console.log(`${passed} PhotoCraft static checks passed. Routing examples: PhotoCraft crop included; video trim explicitly excluded.`)
} finally { publishActiveSet(null); clearExtensionCommandCaches(); rmSync(scratch, { recursive: true, force: true }) }
