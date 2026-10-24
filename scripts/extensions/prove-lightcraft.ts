#!/usr/bin/env bun
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, symlinkSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { computeActiveSet, publishActiveSet } from '../../src/extensions/active.js'
import { clearExtensionCommandCaches, getExtensionSkills } from '../../src/extensions/load/commands.js'
import { removeScratch } from '../lib/removeScratch.ts'

const root = resolve(import.meta.dir, '../..')
const extension = join(root, 'src/extensions/bundled/lightcraft')
const scratch = mkdtempSync(join(process.env.MERCURY_CONFIG_DIR || tmpdir(), 'lightcraft-unit-'))
const delivered = join(scratch, 'delivered')
cpSync(extension, delivered, { recursive: true })
cpSync(join(root, 'src/extensions/bundled/shared'), join(delivered, 'shared'), { recursive: true })
const { adapter, endpointPort, verifyListener, readLibrary, privateEnvironment } = await import(pathToFileURL(join(delivered, 'server/install.mjs')).href)
let passed = 0
function check(name: string, fn: () => unknown) { fn(); passed++; console.log(`PASS ${name}`) }
async function checkAsync(name: string, fn: () => Promise<unknown>) { await fn(); passed++; console.log(`PASS ${name}`) }
try {
  const manifest = JSON.parse(readFileSync(join(extension, 'mercury-extension.json'), 'utf8'))
  check('only skills and stdio app contributions', () => {
    assert.deepEqual(Object.keys(manifest.contributes).sort(), ['servers', 'skills'])
    assert.equal(manifest.contributes.servers.app.command, '${MERCURY_NODE}')
    assert.deepEqual(manifest.contributes.servers.app.args, ['${MERCURY_EXTENSION_ROOT}/server/bridge.mjs'])
    assert.equal(manifest.needs.binaries, undefined)
  })
  check('matched version/tag and fixed URL/hash/size payloads', () => {
    assert.equal(adapter.version, '0.13.0')
    for (const pin of adapter.pins) {
      assert.equal(pin.version, adapter.version)
      assert.equal(pin.tag, `v${pin.version}`)
      for (const payload of Object.values(pin.platforms) as Array<{ archive: string; url: string; sha256: string; bytes: number }>) {
        assert.equal(payload.url, `${pin.repository}/releases/download/${pin.tag}/${payload.archive}`)
        assert.match(payload.sha256, /^[a-f0-9]{64}$/)
        assert.ok(payload.bytes > 0)
      }
    }
    assert.equal(adapter.pins[0].platforms['darwin-arm64'].sha256, '9a1a9b5d8e9af96101d3299650d014d094c51d8ea8fe5e39bae83fa5a9189de0')
    assert.equal(adapter.pins[1].platforms['darwin-arm64'].sha256, '5c456eefc93558db123ed2203f60c7819fa8ed3607bf715404a71005f9342200')
  })
  check('only literal IPv4 loopback endpoints accepted', () => {
    assert.equal(endpointPort('127.0.0.1:7980'), 7980)
    for (const invalid of ['localhost:7980', '0.0.0.0:7980', '192.0.2.1:7980', '127.0.0.1:0', '127.0.0.1:65536', '127.0.0.1:7980\n']) assert.throws(() => endpointPort(invalid))
  })
  check('a real private temp per child and no symlink configuration', () => {
    const data = join(scratch, 'private')
    const first = privateEnvironment(data)
    const second = privateEnvironment(data)
    assert.notEqual(first.TMPDIR, second.TMPDIR)
    assert.equal(first.TMPDIR, first.TEMP)
    if (process.platform !== 'win32') assert.equal(statSync(first.TMPDIR).mode & 0o077, 0)
    const linked = join(scratch, 'linked')
    if (process.platform !== 'win32') {
      symlinkSync(data, linked, 'dir')
      assert.throws(() => privateEnvironment(linked), /not a link/)
      const publicDir = join(scratch, 'public'); mkdirSync(publicDir, { mode: 0o755 })
      assert.throws(() => privateEnvironment(publicDir), /current user/)
    }
  })
  check('explicit library and mode: connect is not a headless fallback', () => {
    const installation = { cli: '/a/lightcraft-cli' }
    const args = { installation, endpoint: '127.0.0.1:7980', dataDir: join(scratch, 'launch'), input: { mode: 'attach', library: join(scratch, 'library') } }
    assert.deepEqual(adapter.upstream(args).args, ['mcp', '--connect', '127.0.0.1:7980'])
    assert.deepEqual(adapter.upstream({ ...args, input: { ...args.input, mode: 'headless' } }).args, ['mcp', '--library', join(scratch, 'library')])
    assert.throws(() => adapter.upstream({ ...args, input: {} }), /absolute path/)
    assert.ok(!adapter.upstream(args).args.includes('--compact'))
  })
  await checkAsync('wrong listener sends zero bytes, including read-only probes', async () => {
    let bytes = 0
    const server = createServer(socket => { socket.on('data', data => { bytes += data.length }); socket.end() })
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
    const address = server.address() as { port: number }
    try {
      const hash = createHash('sha256').update(readFileSync(process.execPath)).digest('hex')
      await assert.rejects(verifyListener({ endpoint: `127.0.0.1:${address.port}`, installation: { gui: process.execPath, cli: process.execPath, manifest: { version: '0.13.0', guiSha256: hash, cliSha256: hash } } }), /does not match|identify|listener/)
      assert.equal(bytes, 0)
    } finally { await new Promise<void>(resolveClose => server.close(() => resolveClose())) }
  })
  await checkAsync('mismatched installation refuses before socket inspection', async () => {
    let inspected = false
    await assert.rejects(verifyListener({ endpoint: '127.0.0.1:7980', installation: { manifest: { version: '0.12.0' } } }, async () => { inspected = true }), /Verify/)
    assert.equal(inspected, false)
  })
  await checkAsync('library handshake is read-only and validates response framing', async () => {
    let requests = 0
    const server = createServer(socket => socket.once('data', data => {
      const request = JSON.parse(data.toString())
      assert.deepEqual(request, { id: 1, method: 'engine.execute', params: { command: 'library.info', params: {} } })
      requests++
      socket.end(JSON.stringify({ id: requests === 1 ? 1 : 2, ok: true, result: { path: scratch } }) + '\n')
    }))
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
    const endpoint = `127.0.0.1:${(server.address() as { port: number }).port}`
    try {
      assert.equal(await readLibrary(endpoint), scratch)
      await assert.rejects(readLibrary(endpoint), /persistent library/)
      assert.equal(requests, 2)
    } finally { await new Promise<void>(resolveClose => server.close(() => resolveClose())) }
  })
  await checkAsync('silent library check times out once without edits or retries', async () => {
    let requests = 0
    const server = createServer(socket => socket.on('data', bytes => {
      const request = JSON.parse(bytes.toString())
      assert.equal(request.params.command, 'library.info')
      requests++
    }))
    await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
    const endpoint = `127.0.0.1:${(server.address() as { port: number }).port}`
    try {
      await assert.rejects(readLibrary(endpoint), /did not answer.*No edit was sent/)
      assert.equal(requests, 1)
    } finally { await new Promise<void>(done => server.close(() => done())) }
  })
  await checkAsync('cancelled library check cannot send a request', async () => {
    const controller = new AbortController(); controller.abort()
    await assert.rejects(readLibrary('127.0.0.1:7980', controller.signal), /cancelled/)
  })
  await checkAsync('real extension skill loader discovers name and expands arguments', async () => {
    publishActiveSet(computeActiveSet({ cwd: scratch, sessionPaths: [extension] }))
    clearExtensionCommandCaches()
    const skill = getExtensionSkills().find(row => row.name === 'lightcraft:lightcraft')
    assert.ok(skill && skill.type === 'prompt')
    assert.equal(skill.argumentHint, '[library and task]')
    assert.match(skill.description, /importing, developing, cropping or exporting photos in a LightCraft library/)
    assert.match(skill.description, /Not for video editing, layered PhotoCraft documents or Apple Photos management/)
    const prompt = await skill.getPromptForCommand('Develop this LightCraft library and export a PNG')
    const text = prompt.map(part => part.type === 'text' ? part.text : '').join('\n')
    assert.match(text, /Develop this LightCraft library and export a PNG/)
    assert.match(text, /library.info/)
    assert.match(text, /outcome is unknown/)
    assert.match(text, /external editors/)
    assert.match(text, /not a filesystem sandbox/)
    assert.doesNotMatch(text, /\$ARGUMENTS|\$\{MERCURY_SKILL_DIR\}/)
  })
  check('upstream forwarding uses only the shared bootstrap', () => {
    const bridge = readFileSync(join(extension, 'server/bridge.mjs'), 'utf8')
    assert.match(bridge, /import \{ runCraftBridge \} from '\.\.\/shared\/bootstrap.mjs'/)
    assert.match(bridge, /runCraftBridge\(adapter\)/)
    const adapterSource = readFileSync(join(extension, 'server/install.mjs'), 'utf8')
    assert.doesNotMatch(adapterSource, /fetch\(|https\.get|--compact|app\.quit/)
    assert.match(adapterSource, /probe, launch, upstream, verify/)
  })
  await checkAsync('real bootstrap SDK discovery is actionable and has no install side effects', async () => {
    const dataDir = join(scratch, 'missing-app-data')
    const client = new Client({ name: 'lightcraft-missing-app-proof', version: '1' }, { capabilities: {} })
    const transport = new StdioClientTransport({ command: 'node', args: [join(delivered, 'server/bridge.mjs')], env: { PATH: process.env.PATH!, MERCURY_EXTENSION_DATA: dataDir }, stderr: 'pipe' })
    try {
      await client.connect(transport)
      const tools = await client.listTools()
      assert.deepEqual(tools.tools.map(tool => tool.name), ['craft_status', 'craft_install', 'craft_connect'])
      const status = await client.callTool({ name: 'craft_status', arguments: {} })
      assert.match(JSON.stringify(status), /absent/)
      assert.equal(existsSync(dataDir), false)
      const declined = await client.callTool({ name: 'craft_install', arguments: {} })
      assert.equal(declined.isError, true)
      assert.match(JSON.stringify(declined), /declined/)
      await client.listTools()
      assert.equal(existsSync(dataDir), false)
      const absent = await client.callTool({ name: 'craft_connect', arguments: { mode: 'attach', library: scratch } })
      assert.equal(absent.isError, true)
      assert.equal(existsSync(dataDir), false)
    } finally { await client.close() }
  })
  console.log(`LightCraft: ${passed} checks passed`)
} finally {
  publishActiveSet(null)
  clearExtensionCommandCaches()
  removeScratch(scratch)
}
