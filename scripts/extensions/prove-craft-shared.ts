import assert from 'node:assert/strict'
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { zipSync, strToU8 } from 'fflate'
import { z } from 'zod'
import { Client, StdioClientTransport } from '../../src/services/mcp/sdk.ts'

;(globalThis as Record<string, unknown>).MACRO = { VERSION: 'craft-proof' }
const root = resolve(import.meta.dir, '../..')
const temp = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), 'craft-shared-'))
const shared = await import(pathToFileURL(join(root, 'src/extensions/bundled/shared/install.mjs')).href)
const bootstrap = await import(pathToFileURL(join(root, 'src/extensions/bundled/shared/bootstrap.mjs')).href)
let passed = 0
async function check(label: string, fn: () => unknown | Promise<unknown>): Promise<void> { await fn(); passed++; console.log(`PASS ${label}`) }
const platform = shared.hostPlatform()
const gui = platform.startsWith('darwin') ? 'Fixture.app/Contents/MacOS/fixture' : `fixture${platform.startsWith('win-') ? '.exe' : ''}`
const cli = `fixture-cli${platform.startsWith('win-') ? '.exe' : ''}`
const bytes = Buffer.from(zipSync({ [gui]: strToU8('gui'), [cli]: strToU8('cli'), LICENSE: strToU8('fixture licence') }))
const pin = { name: 'fixture', version: '1.0.0', tag: 'v1.0.0', repository: 'https://github.com/example/fixture', license: 'MIT', licenseFiles: ['LICENSE'], platforms: { [platform]: { archive: 'fixture-1.0.0.zip', url: 'https://github.com/example/fixture/releases/download/v1.0.0/fixture-1.0.0.zip', sha256: shared.sha256(bytes), bytes: bytes.length } } }
const adapter = { id: 'fixture', title: 'Fixture', version: '1.0.0', pins: [pin], guiBasename: 'fixture', cliBasename: 'fixture-cli' }
const fetcher = async () => new Response(bytes)
const absent = async (path: string) => lstat(path).then(() => false, () => true)
try {
  await check('release URL, tag, size and hash binding', () => {
    shared.validatePin(pin)
    for (const mutated of [{ ...pin, tag: 'latest' }, { ...pin, platforms: { [platform]: { ...pin.platforms[platform], url: 'https://other.example/fixture.zip' } } }, { ...pin, platforms: { [platform]: { ...pin.platforms[platform], sha256: 'bad' } } }]) assert.throws(() => shared.validatePin(mutated))
  })
  await check('traversal, absolute paths and Windows aliases refused', () => {
    for (const path of ['../escape', '/escape', 'C:/escape', 'safe/../../escape', 'a\\b', 'CON', 'thing.']) assert.throws(() => shared.safeMember(path))
    shared.safeMember('safe/item')
  })
  await check('archive traversal and links refused before extraction', () => {
    assert.throws(() => shared.zipEntries(Buffer.from(zipSync({ '../escape': strToU8('bad') }))))
    const links = Buffer.from(bytes), at = links.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    links.writeUInt32LE((0o120777 << 16) >>> 0, at + 38)
    assert.throws(() => shared.zipEntries(links))
  })
  await check('denied install writes and downloads nothing', async () => {
    const dataDir = join(temp, 'denied'); let asks = 0, downloads = 0
    await assert.rejects(shared.installPinned(adapter, { dataDir, authorize: () => { asks++; return false }, fetcher: () => { downloads++; throw new Error('unexpected network') } }), /declined/)
    assert.equal(asks, 1); assert.equal(downloads, 0); assert(await absent(dataDir))
  })
  await check('corrupt bytes fail before extraction and leave no active install', async () => {
    const dataDir = join(temp, 'corrupt'); let extracted = 0
    await assert.rejects(shared.installPinned(adapter, { dataDir, authorize: () => true, fetcher: async () => new Response(Buffer.alloc(bytes.length)), extractor: () => { extracted++ } }), /SHA-256/)
    assert.equal(extracted, 0); assert.deepEqual(await readdir(join(dataDir, 'runtime')), [])
  })
  await check('cancelled partial download leaves no partial install or hidden retry', async () => {
    const dataDir = join(temp, 'cancelled'), abort = new AbortController(); let downloads = 0
    await assert.rejects(shared.installPinned(adapter, { dataDir, signal: abort.signal, authorize: () => true, fetcher: async () => { downloads++; return new Response(new ReadableStream({ start(c) { c.enqueue(bytes.subarray(0, 10)); abort.abort(); c.close() } })) } }))
    assert.equal(downloads, 1); assert.deepEqual(await readdir(join(dataDir, 'runtime')), [])
  })
  await check('missing licence prevents activation', async () => {
    const dataDir = join(temp, 'no-licence')
    await assert.rejects(shared.installPinned({ ...adapter, pins: [{ ...pin, licenseFiles: ['MISSING'] }] }, { dataDir, authorize: () => true, fetcher }), /Missing licence/)
    assert.deepEqual(await readdir(join(dataDir, 'runtime')), [])
  })
  const dataDir = join(temp, 'valid')
  let installation: any
  await check('atomic activation, manifest, all payloads and offline validation', async () => {
    installation = await shared.installPinned(adapter, { dataDir, authorize: () => true, fetcher })
    assert.equal(installation.manifest.archives[0].sha256, pin.platforms[platform].sha256)
    assert.equal(installation.manifest.licences.length, 1)
    assert.equal((await shared.checkInstall(adapter, { dataDir })).state, 'installed')
    assert.deepEqual(await readdir(join(dataDir, 'runtime')), ['1.0.0-' + platform])
  })
  await check('same version reuse asks and downloads zero times', async () => {
    const reused = await shared.installPinned(adapter, { dataDir, authorize: () => { throw new Error('unexpected ask') }, fetcher: () => { throw new Error('unexpected network') } })
    assert(reused.reused)
  })
  await check('different user version is never downgraded', async () => {
    await assert.rejects(shared.installPinned(adapter, { dataDir: join(temp, 'newer'), existingVersion: '2.0.0', authorize: () => { throw new Error('unexpected ask') } }), /was not changed/)
    assert(await absent(join(temp, 'newer')))
  })
  await check('offline validation detects modified files and link escapes', async () => {
    await writeFile(installation.cli, 'drift')
    assert.equal((await shared.checkInstall(adapter, { dataDir })).state, 'invalid')
    await assert.rejects(shared.installPinned(adapter, { dataDir, authorize: () => true, fetcher }), /not replaced/)
    if (process.platform !== 'win32') {
      await symlink(temp, join(installation.root, 'escape'))
      await assert.rejects(shared.treeRecord(installation.root), /escapes/)
    }
  })

  const delivered = join(temp, 'filmcraft')
  await cp(join(root, 'src/extensions/bundled/filmcraft'), delivered, { recursive: true })
  await cp(join(root, 'src/extensions/bundled/shared'), join(delivered, 'shared'), { recursive: true })
  const { registerBundledAppInstall, bundledAppInstallPermission, withBundledAppInstallConsent } = await import('../../src/extensions/installConsent.ts')
  const { decideToolPermission } = await import('../../src/utils/permissions/decision/engine.ts')
  const { getEmptyToolPermissionContext } = await import('../../src/Tool.ts')
  const serverName = 'ext:filmcraft:app', missingData = join(temp, 'missing')
  const key = registerBundledAppInstall(serverName, delivered, missingData)
  let invokedInput: any
  const tool: any = withBundledAppInstallConsent({ name: 'mcp__ext_filmcraft_app__craft_install', mcpInfo: { serverName, toolName: 'craft_install' }, inputSchema: z.object({}).passthrough(), checkPermissions: async () => ({ behavior: 'passthrough' }), call: async (input: unknown) => { invokedInput = input; return { data: [] } } } as any)
  const context = (mode: any): any => ({ abortController: new AbortController(), getAppState: () => ({ toolPermissionContext: { ...getEmptyToolPermissionContext(), mode } }) })
  let grant = ''
  await check('ordinary mode asks once with app, version, exact size and destination', async () => {
    const { decision } = await decideToolPermission(tool, {}, context('default'))
    assert.equal(decision.behavior, 'ask')
    assert.match(decision.message, /FilmCraft 0\.12\.0/); assert.match(decision.message, /bytes/); assert(decision.message.includes(missingData))
    assert(await absent(missingData))
  })
  await check('sovereign passes the same installation without an ask', async () => {
    const { decision } = await decideToolPermission(tool, {}, context('sovereign'))
    assert.equal(decision.behavior, 'allow')
    assert(!JSON.stringify(decision).includes('_mercuryInstallGrant'))
    await tool.call({}, context('sovereign'))
    grant = invokedInput._mercuryInstallGrant
    assert(grant)
  })
  await check('grant binds exact destination, expires and cannot be replayed', async () => {
    const { adapter: film } = await import(pathToFileURL(join(delivered, 'server/install.mjs')).href)
    const plan = shared.planInstall(film, { dataDir: missingData }), used = new Set()
    assert(!bootstrap.verifyInstallGrant(grant, { ...plan, digest: 'other' }, key, used))
    assert(bootstrap.verifyInstallGrant(grant, plan, key, used))
    assert(!bootstrap.verifyInstallGrant(grant, plan, key, used))
    assert(!bootstrap.verifyInstallGrant('forged', plan, key))
  })
  await check('third-party names cannot claim the bundled install permission', async () => {
    assert.equal(await bundledAppInstallPermission({ ...tool, mcpInfo: { serverName: 'fake', toolName: 'craft_install' } }, {}), null)
  })
  await check('MCP discovery exposes missing-app tools without installing or launching', async () => {
    const client = new Client({ name: 'craft-proof', version: '1.0.0' })
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(delivered, 'server/bridge.mjs')], env: { ...process.env, MERCURY_EXTENSION_DATA: missingData, MERCURY_CRAFT_INSTALL_KEY: key } as Record<string, string>, stderr: 'pipe' })
    await client.connect(transport)
    try {
      const tools = await client.listTools()
      assert.deepEqual(tools.tools.map(t => t.name), ['craft_status', 'craft_install', 'craft_connect'])
      const status = await client.callTool({ name: 'craft_status', arguments: {} }); assert(!status.isError)
      assert(await absent(missingData))
      const denied = await client.callTool({ name: 'craft_install', arguments: {} }); assert(denied.isError)
      assert(await absent(missingData))
      const invalid = await client.callTool({ name: 'craft_connect', arguments: { mode: 'invalid' } }); assert(invalid.isError)
      assert(await absent(missingData))
    } finally { await client.close() }
  })
  await check('wrong listener is rejected before any application bytes', async () => {
    const { createServer } = await import('node:net')
    const { verifyListener, controlSession } = await import(pathToFileURL(join(root, 'src/extensions/bundled/shared/control.mjs')).href)
    let received = 0
    const server = createServer(socket => socket.on('data', () => { received++ }))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const endpoint = `127.0.0.1:${(server.address() as any).port}`
    try {
      await assert.rejects(verifyListener(endpoint, installation.gui), /different executable|not the verified installation|Cannot identify/)
      assert.equal(received, 0)
      const control = controlSession(endpoint, { timeoutMs: 30 })
      try { await assert.rejects(control.request('state.inspect'), /timed out; outcome may be unknown/) } finally { control.close() }
      assert.equal(received, 1, 'Timeout must never replay the request')
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  console.log(`Craft shared: ${passed} checks passed`)
} finally { await rm(temp, { recursive: true, force: true }) }
